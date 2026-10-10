import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { connect, type InitRegistration, type MemoryClient } from "@snoai/memory/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquirePidFileLock } from "../../../apps/mem-codex/src/files.js";
import { appStateRoot, importDirectory, spoolDirectory, workerLockPath } from "../../../apps/mem-codex/src/paths.js";
import { runWorker, type WorkerDependencies } from "../../../apps/mem-codex/src/worker.js";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";
import { untilModelReady } from "../../packages/memory/integration/fixtures/model-ready";

const previousEnv = { SNO_PROFILE_DIR: process.env.SNO_PROFILE_DIR, HOME: process.env.HOME };
const roots: string[] = [];
const sidecarPids: number[] = [];
// The machine's own model cache (read from the account, not HOME): no per-test model download.
const MODEL_CACHE = join(userInfo().homedir, ".cache", "sno-station", "models");

/** A temporary profile with its own settings.json and home (the store list lives under HOME). */
async function profile(mode: "agent-native" | "local-first" = "agent-native"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mem-codex-worker-"));
	roots.push(root);
	process.env.SNO_PROFILE_DIR = root;
	process.env.HOME = join(root, "home");
	writeSettingsFixture(root, { mode, rerank: { mode: "none" }, embedding: { cacheDir: MODEL_CACHE } });
	return root;
}

async function spool(name: string, turnId: string): Promise<string> {
	await mkdir(spoolDirectory(), { recursive: true });
	const path = join(spoolDirectory(), name);
	await writeFile(path, JSON.stringify({ sessionId: `session-${turnId}`, turnId, project: "/repo", childCwd: "/repo", user: `user-${turnId}`, assistant: `assistant-${turnId}`, at: 1, attempts: 0, state: "pending" }));
	return path;
}

function dependencies(options: {
	failCapture?: boolean;
	failuresBeforeSuccess?: number;
	childFailure?: boolean;
	captureCommitted?: boolean;
	onCapture?: (turnId: string) => Promise<void>;
} = {}) {
	const captures: string[] = [];
	let captureFailures = 0;
	let now = 1_000;
	const waits: number[] = [];
	let registration: InitRegistration | undefined;
	let callbackStatus = 0;
	let callbackBody: unknown;
	const client = {
		principal: "tester",
		async init(_scope: unknown, value: InitRegistration) { registration = value; return { degraded: false }; },
		async capture(turn: { turnId: string }) {
			captures.push(turn.turnId);
			await options.onCapture?.(turn.turnId);
			if (options.failCapture || captureFailures < (options.failuresBeforeSuccess ?? 0)) {
				captureFailures += 1;
				throw new Error("capture-failed");
			}
			const response = await fetch(`${registration?.model.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${registration?.model.credential}`, "content-type": "application/json" },
				body: JSON.stringify({ model: "codex-exec", messages: [{ role: "system", content: "system" }, { role: "user", content: turn.turnId }] }),
			});
			callbackStatus = response.status;
			callbackBody = await response.json();
			return { degraded: false, committed: options.captureCommitted ?? response.ok, turnId: turn.turnId };
		},
	} as unknown as MemoryClient;
	const deps: WorkerDependencies = {
		async connect() { return client; },
		now: () => now,
		async sleep(delayMs) { waits.push(delayMs); now += delayMs; },
		async runChild(prompt, cwd) {
			expect(cwd).toBe("/repo");
			expect(prompt).toContain("system: system");
			return options.childFailure
				? { kind: "error", category: "transport", message: "codex-exit-9" }
				: { kind: "ok", text: `child:${prompt.split("\n").at(-1)}` };
		},
	};
	return {
		deps,
		captures,
		waits,
		get now() { return now; },
		get registration() { return registration; },
		get callbackStatus() { return callbackStatus; },
		get callbackBody() { return callbackBody; },
	};
}

afterEach(async () => {
	for (const pid of sidecarPids.splice(0)) {
		try { process.kill(pid, "SIGTERM"); } catch { continue; /* already stopped */ }
		// The sidecar writes into the profile until it exits; removing the root earlier races it.
		for (let attempt = 0; attempt < 200; attempt += 1) {
			try { process.kill(pid, 0); } catch { break; }
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("mem-codex worker", () => {
	it("holds one lock, drains in filename order, registers with only its skin and model, and deletes only after commit", async () => {
		await profile();
		const first = await spool("0002.json", "two");
		const second = await spool("0001.json", "one");
		const third = await spool("0003.json", "three");
		const fixture = dependencies();
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.captures).toEqual(["one", "two", "three"]);
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(false);
		expect(existsSync(third)).toBe(false);
		// The worker never holds routing, settings, or the reranker key; the service reads settings.json.
		expect(fixture.registration).toEqual({
			skinId: "codex",
			model: { baseUrl: expect.any(String), credential: expect.any(String), model: "codex-exec" },
		});
		expect(fixture.callbackBody).toMatchObject({ choices: [{ message: { role: "assistant", content: "child:user: three" } }] });
		expect(await readdir(spoolDirectory())).toEqual([]);

	});

	it("allows only one concurrent worker", async () => {
		await profile();
		const fixture = dependencies();
		let release: (() => void) | undefined;
		const held = new Promise<void>(resolve => { release = resolve; });
		const first = runWorker({ ...fixture.deps, async connect() { await held; return fixture.deps.connect(); } });
		for (let attempt = 0; attempt < 100 && !existsSync(workerLockPath()); attempt += 1) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		expect(existsSync(workerLockPath())).toBe(true);
		expect(await runWorker(fixture.deps)).toBe("locked");
		release?.();
		expect(await first).toBe("drained");
	});

	it("reclaims a worker lock whose recorded process is gone", async () => {
		await profile();
		await mkdir(join(workerLockPath(), ".."), { recursive: true });
		await writeFile(workerLockPath(), "2147483647\n");
		await spool("0001.json", "after-crash");
		const fixture = dependencies();

		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.captures).toEqual(["after-crash"]);
		expect(existsSync(workerLockPath())).toBe(false);
	});

	it("grants one racing lock and does not reclaim an empty fresh lock", async () => {
		const root = await profile();
		const racePath = join(root, "race.lock");
		const locks = await Promise.all([
			acquirePidFileLock(racePath, 60_000),
			acquirePidFileLock(racePath, 60_000),
		]);
		const winners = locks.filter(lock => lock !== undefined);
		expect(winners).toHaveLength(1);
		await winners[0]?.release();

		const emptyPath = join(root, "empty.lock");
		await writeFile(emptyPath, "");
		expect(await acquirePidFileLock(emptyPath, 60_000)).toBeUndefined();
		expect(await readFile(emptyPath, "utf8")).toBe("");

		const deadPath = join(root, "dead.lock");
		await writeFile(deadPath, "2147483647 1\n");
		const reclaimed = await Promise.all([
			acquirePidFileLock(deadPath, 60_000),
			acquirePidFileLock(deadPath, 60_000),
		]);
		const reclaimWinners = reclaimed.filter(lock => lock !== undefined);
		expect(reclaimWinners).toHaveLength(1);
		await reclaimWinners[0]?.release();

		const staleReclaimPath = join(root, "stale-reclaim.lock");
		await writeFile(staleReclaimPath, "2147483647 1\n");
		await writeFile(`${staleReclaimPath}.reclaim`, "2147483647 1\n");
		const afterCrash = await acquirePidFileLock(staleReclaimPath, 60_000);
		expect(afterCrash).toBeDefined();
		await afterCrash?.release();
	});

	it("hands off a record enqueued between the final scan and lock release", async () => {
		await profile();
		const fixture = dependencies();
		let queued = false;
		const deps: WorkerDependencies = {
			...fixture.deps,
			async beforeLockRelease() {
				if (queued) return;
				queued = true;
				await spool("0001.json", "handoff");
			},
			async handoff() {
				expect(await runWorker(fixture.deps)).toBe("drained");
			},
		};

		expect(await runWorker(deps)).toBe("drained");
		expect(fixture.captures).toEqual(["handoff"]);
		expect(await readdir(spoolDirectory())).toEqual([]);
	});

	it("rescans before exit and drains a record appended during capture", async () => {
		await profile();
		await spool("0001.json", "one");
		let appended = false;
		const fixture = dependencies({ async onCapture(turnId) {
			if (turnId === "one" && !appended) { appended = true; await spool("0002.json", "two"); }
		} });
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.captures).toEqual(["one", "two"]);
		expect(await readdir(spoolDirectory())).toEqual([]);
	});

	it("keeps the head record, counts three failures, and never retries a terminal record", async () => {
		await profile();
		const path = await spool("0001.json", "one");
		const fixture = dependencies({ failCapture: true });
		const logged = vi.spyOn(console, "log");
		expect(await runWorker(fixture.deps)).toBe("drained");
		// Each failed attempt names its turn and cause in the worker log; the cause used to be dropped.
		const failures = logged.mock.calls.map(([line]) => String(line)).filter(line => line.includes('"capture-failed"'));
		logged.mockRestore();
		expect(failures.map(line => JSON.parse(line))).toEqual([1, 2, 3].map(attempt =>
			expect.objectContaining({ event: "capture-failed", turnId: "one", attempt, error: expect.stringMatching(/\S/) })));
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ attempts: 3, state: "failed" });
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.captures).toEqual(["one", "one", "one"]);
	});

	it("commits the next record after the first exhausts its retries", async () => {
		await profile();
		const first = await spool("0001.json", "one");
		const second = await spool("0002.json", "two");
		const fixture = dependencies({ async onCapture(turnId) {
			if (turnId === "one") throw new Error("capture-failed");
		} });

		await runWorker(fixture.deps);

		expect(JSON.parse(await readFile(first, "utf8"))).toMatchObject({ attempts: 3, state: "failed" });
		expect(existsSync(second)).toBe(false);
	});

	it("persists retry deadlines and waits before the second and third attempts", async () => {
		await profile();
		const path = await spool("0001.json", "one");
		const observed: Array<{ attempts: number; retryAt: number }> = [];
		const fixture = dependencies({ failuresBeforeSuccess: 2 });
		let now = 1_000;
		fixture.deps.now = () => now;
		fixture.deps.sleep = async delayMs => {
			if (existsSync(path)) {
				const record = JSON.parse(await readFile(path, "utf8"));
				observed.push({ attempts: record.attempts, retryAt: record.retryAt });
			}
			fixture.waits.push(delayMs);
			now += delayMs;
		};

		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(observed).toEqual([
			{ attempts: 1, retryAt: 3_000 },
			{ attempts: 2, retryAt: 13_000 },
		]);
		// Two retry waits, then the two idle minutes a drained worker stays up before it exits.
		// Retry waits, then the two idle minutes taken in rescanning slices of at most five seconds.
		expect(fixture.waits.slice(0, 2)).toEqual([2_000, 10_000]);
		expect(fixture.waits.slice(2).every(wait => wait <= 5_000)).toBe(true);
		expect(fixture.waits.slice(2).reduce((total, wait) => total + wait, 0)).toBe(120_000);
		expect(fixture.captures).toEqual(["one", "one", "one"]);
		expect(existsSync(path)).toBe(false);
	});

	it("relays a typed child transport failure with HTTP 503 and keeps the record", async () => {
		await profile();
		const path = await spool("0001.json", "one");
		const fixture = dependencies({ childFailure: true });
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.callbackStatus).toBe(503);
		expect(fixture.callbackBody).toEqual({ error: { kind: "error", category: "transport", message: "codex-exit-9" } });
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ attempts: 3, state: "failed" });
	});

	it("keeps a capture that completed without committing or deliberately skipping", async () => {
		await profile();
		const path = await spool("0001.json", "unavailable");
		const fixture = dependencies({ captureCommitted: false });
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.captures).toEqual(["unavailable", "unavailable", "unavailable"]);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ attempts: 3, state: "failed" });
	});

	it("paces consecutive import children and records committed blocks", async () => {
		await profile();
		await mkdir(importDirectory(), { recursive: true });
		const receiptPath = join(importDirectory(), "receipt.json");
		await writeFile(receiptPath, JSON.stringify({ files: { "/note.md": { committed: 0, failures: 0 } } }));
		for (const [name, turn] of [["0001.json", "one"], ["0002.json", "two"]] as const) {
			const path = await spool(name, turn);
			const record = JSON.parse(await readFile(path, "utf8"));
			delete record.assistant;
			record.kind = "import";
			record.importReceipt = { path: receiptPath, file: "/note.md" };
			await writeFile(path, JSON.stringify(record));
		}
		const starts: number[] = [];
		const fixture = dependencies();
		const deps = { ...fixture.deps, async runChild() { starts.push(Date.now()); return { kind: "ok" as const, text: "ok" }; } };
		expect(await runWorker(deps)).toBe("drained");
		expect(starts).toHaveLength(2);
		expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(2_000);
		expect(JSON.parse(await readFile(receiptPath, "utf8")).files["/note.md"]).toMatchObject({ committed: 2, failures: 0 });
	}, 10_000);

	it("registers and captures through a real sidecar in a temporary profile", async () => {
		const root = await profile("agent-native");
		await spool("0001.json", "real-sidecar");
		const prompts: string[] = [];
		// The drained worker idles two minutes; the injected clock makes that wait instant.
		let clock = Date.now();
		const idleWaits: number[] = [];
		const deps: WorkerDependencies = {
			now: () => clock,
			async sleep(delayMs) { idleWaits.push(delayMs); clock += delayMs; },
			async connect() {
				const client = await connect({ skinId: "codex" });
				if (client.degraded) throw new Error(client.reason);
				sidecarPids.push(client.pid);
				return client;
			},
			async runChild(prompt) {
				prompts.push(prompt);
				return { kind: "ok", text: '{"claims_found":[],"decisions":[{"turn_index":0,"progress_only":false}],"facts":[]}' };
			},
		};
		expect(await runWorker(deps), prompts.join("\n---\n")).toBe("drained");
		expect(await readdir(spoolDirectory())).toEqual([]);
		expect(idleWaits.reduce((total, delayMs) => total + delayMs, 0)).toBeGreaterThanOrEqual(2 * 60_000);
		const discovery = JSON.parse(await readFile(join(root, "station/sidecar.json"), "utf8"));
		expect(discovery.pid).toBe(sidecarPids.at(-1));
		expect((await fetch(`http://127.0.0.1:${discovery.port}/healthz`)).status).toBe(200);
	}, 30_000);

	it("finishes an import without a failed receipt when ambient capture is disabled", async () => {
		const root = await profile();
		writeSettingsFixture(root, { mode: "agent-native", capture: { ambient: false }, rerank: { mode: "none" }, embedding: { cacheDir: MODEL_CACHE } });
		const path = await spool("0001.json", "capture-disabled");
		await mkdir(importDirectory(), { recursive: true });
		const receiptPath = join(importDirectory(), "receipt.json");
		await writeFile(receiptPath, JSON.stringify({ files: { "/note.md": { committed: 0, failures: 0 } } }));
		const record = JSON.parse(await readFile(path, "utf8"));
		record.kind = "import";
		record.importReceipt = { path: receiptPath, file: "/note.md" };
		await writeFile(path, JSON.stringify(record));
		let clock = Date.now();
		const deps: WorkerDependencies = {
			now: () => clock,
			async sleep(delayMs) { clock += delayMs; },
			async connect() {
				const client = await connect({ skinId: "codex" });
				if (client.degraded) throw new Error(client.reason);
				sidecarPids.push(client.pid);
				await untilModelReady(({ scope, query, options }) => client.getRecall(query, { principal: client.principal, ...scope }, options));
				return client;
			},
			async runChild() { throw new Error("capture should be skipped"); },
		};
		expect(await runWorker(deps)).toBe("drained");
		expect(await readdir(spoolDirectory())).toEqual([]);
		expect(JSON.parse(await readFile(receiptPath, "utf8")).files["/note.md"]).toEqual({ committed: 0, failures: 0, skipped: 1 });
	}, 150_000);
});

// Local First PRD REQ-3: the callback answers while the worker lives, not only during spool work,
// and a drained worker stays up while its callback served a call in the last 2 minutes (9-minute cap).
describe("mem-codex worker callback with an empty spool", () => {
	const answer = (text: string) => ({ choices: [{ message: { role: "assistant", content: `child:user: ${text}` } }] });

	async function postCallback(model: { baseUrl: string; credential: string }, text: string) {
		const response = await fetch(`${model.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${model.credential}`, "content-type": "application/json" },
			body: JSON.stringify({ model: "codex-exec", messages: [{ role: "system", content: "system" }, { role: "user", content: text }] }),
		});
		const raw = await response.text();
		let body: unknown = raw;
		try { body = JSON.parse(raw); } catch { /* keep the raw text in the failure diff */ }
		return { status: response.status, body };
	}

	// A real local-first sidecar in a temporary profile; the worker registers its callback there.
	// Worker time is the injected clock; each callback request arrives at its scheduled offset
	// (ms after start) while the worker sleeps, exactly as a service call lands mid-wait.
	async function callbackWorker(callsAt: number[], probeAtRegistration = true) {
		await profile("local-first");
		const startedAt = Date.now();
		let clock = startedAt;
		let sleeps = 0;
		let model: { baseUrl: string; credential: string } | undefined;
		const children: Array<{ prompt: string; cwd: string }> = [];
		const served: Array<{ at: number; status: number; body: unknown }> = [];
		const deps: WorkerDependencies = {
			async connect() {
				const client = await connect({ skinId: "codex" });
				if (client.degraded) throw new Error(client.reason);
				sidecarPids.push(client.pid);
				const init = client.init.bind(client);
				client.init = async (scope, value) => {
					const result = await init(scope, value);
					model = value.model;
					if (!model) throw new Error("worker registration missing model");
					if (probeAtRegistration) served.push({ at: 0, ...await postCallback(model, "REGISTRATION_PROBE") });
					return result;
				};
				return client;
			},
			now: () => clock,
			async sleep(delayMs) {
				sleeps += 1;
				if (sleeps > 10_000 || clock - startedAt > 60 * 60_000) throw new Error(`worker still sleeping at +${clock - startedAt} ms`);
				const wakeAt = clock + delayMs;
				for (const offset of callsAt) {
					if (!model || startedAt + offset <= clock || startedAt + offset > wakeAt) continue;
					clock = startedAt + offset;
					served.push({ at: offset, ...await postCallback(model, `CALL_AT_${offset}`) });
				}
				clock = wakeAt;
			},
			async runChild(prompt, cwd) {
				children.push({ prompt: prompt.split("\n").at(-1) ?? "", cwd });
				return { kind: "ok", text: `child:${prompt.split("\n").at(-1)}` };
			},
		};
		return { deps, served, children, startedAt, get exitedAfter() { return clock - startedAt; } };
	}

	// The callback runs one child at a time. A call whose requester gave up while it waited in line used to start a
	// child anyway, spending the user's model quota on an answer nobody read.
	it("does not run the model for a call its requester gave up on while it waited", async () => {
		const fixture = await callbackWorker([], false);
		const children: string[] = [];
		const connectWorker = fixture.deps.connect;
		fixture.deps.connect = async () => {
			const connected = await connectWorker();
			const init = connected.init.bind(connected);
			connected.init = async (scope, value) => {
				const result = await init(scope, value);
				const model = value.model;
				if (!model) throw new Error("worker registration missing model");
				const answered = postCallback(model, "ANSWERED");
				// The requester is another process (the memory service): its call arrives while the worker is blocked and
				// carries the time after which it no longer waits.
				const requester = spawn(process.execPath, ["-e", `
					fetch(process.argv[1], { method: "POST", signal: AbortSignal.timeout(200),
						headers: { "content-type": "application/json", authorization: "Bearer " + process.argv[2], "x-sno-deadline": String(Date.now() + 200) },
						body: JSON.stringify({ model: "codex-exec", messages: [{ role: "user", content: "GAVE_UP" }] }) }).catch(() => {});
				`, `${model.baseUrl}/chat/completions`, model.credential], { stdio: "ignore" });
				const second = new Promise(resolve => requester.once("exit", resolve));
				await Promise.all([answered, second]);
				return result;
			};
			return connected;
		};
		fixture.deps.runChild = async prompt => {
			children.push(prompt.split("\n").at(-1) ?? "");
			// The real child runs under spawnSync, which blocks the event loop until it exits.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
			return { kind: "ok", text: "child answer" };
		};
		await runWorker(fixture.deps);
		expect(children).toEqual(["user: ANSWERED"]);
	}, 60_000);

	// Calls at 0 (registration), 30 s, 150 s and 200 s: the worker exits exactly 2 minutes after the
	// last one (320 s). A fixed lifetime or a timer counted from the drain alone exits elsewhere.
	it("answers model calls with an empty spool and exits exactly two minutes after the last call", async () => {
		const fixture = await callbackWorker([30_000, 150_000, 200_000]);
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.served).toEqual([
			{ at: 0, status: 200, body: answer("REGISTRATION_PROBE") },
			{ at: 30_000, status: 200, body: answer("CALL_AT_30000") },
			{ at: 150_000, status: 200, body: answer("CALL_AT_150000") },
			{ at: 200_000, status: 200, body: answer("CALL_AT_200000") },
		]);
		// With no spool record the child runs in the worker's own directory, never a user project.
		for (const child of fixture.children) {
			expect(child.cwd.startsWith(`${appStateRoot()}/`)).toBe(true);
			expect(existsSync(child.cwd)).toBe(true);
		}
		expect(fixture.exitedAfter).toBe(200_000 + 2 * 60_000);
		expect(existsSync(workerLockPath())).toBe(false);
	}, 60_000);

	// The service dispatches REM after registration returns, so its first call can arrive only once
	// the worker has drained its spool (Done test: the pass reaches its end with the spool empty).
	it("waits after registration for a first call that arrives once the spool is empty", async () => {
		const fixture = await callbackWorker([90_000], false);
		await runWorker(fixture.deps);
		expect(fixture.served.map(({ at, status }) => ({ at, status }))).toEqual([{ at: 90_000, status: 200 }]);
		expect(fixture.exitedAfter).toBe(90_000 + 2 * 60_000);
	}, 60_000);

	// A record due at 60 s drains the spool after the last call (30 s): the two minutes count from
	// the drain, so the worker exits at 180 s, not 150 s.
	it("counts the two idle minutes from the drain when it is later than the last call", async () => {
		const fixture = await callbackWorker([30_000], false);
		await mkdir(spoolDirectory(), { recursive: true });
		await writeFile(join(spoolDirectory(), "0001.json"), JSON.stringify({ sessionId: "session-late-drain", turnId: "late-drain",
			project: "/repo", childCwd: "/repo", user: "The staging database is refreshed every Monday.", assistant: "Noted.",
			at: 1, attempts: 0, state: "pending", retryAt: fixture.startedAt + 60_000 }));
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(await readdir(spoolDirectory())).toEqual([]);
		expect(fixture.served.map(({ at, status }) => ({ at, status }))).toEqual([{ at: 30_000, status: 200 }]);
		expect(fixture.exitedAfter).toBe(60_000 + 2 * 60_000);
	}, 60_000);

	// A call every minute keeps the worker alive; it answers every call up to the cap and exits at
	// exactly nine minutes, never earlier and never later.
	it("keeps answering while called and exits exactly at the nine-minute cap", async () => {
		const everyMinute = Array.from({ length: 10 }, (_, index) => (index + 1) * 60_000);
		const fixture = await callbackWorker(everyMinute);
		await runWorker(fixture.deps);
		expect(fixture.served.map(({ at, status }) => ({ at, status }))).toEqual(
			[0, ...everyMinute.filter(offset => offset <= 9 * 60_000)].map(at => ({ at, status: 200 })));
		expect(fixture.exitedAfter).toBe(9 * 60_000);
	}, 60_000);
});

describe("mem-codex worker lock files", () => {
	it("waits while a worker from before an upgrade still holds the lock under the old lock kind", async () => {
		// A worker started before an upgrade held its guard with flock, which the new lock cannot see on Linux; both
		// workers then drained the same spool, and the second unlink rewrote a committed record for another capture.
		const root = await mkdtemp(join(tmpdir(), "mem-codex-lock-"));
		roots.push(root);
		const path = join(root, "upgrade.lock");
		const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
		try {
			await writeFile(path, `${holder.pid} ${Date.now()}\n`);
			expect(await acquirePidFileLock(path, 60_000)).toBeUndefined();
			holder.kill();
			await new Promise(resolve => holder.once("exit", resolve));
			const taken = await acquirePidFileLock(path, 60_000);
			expect(taken).toBeDefined();
			await taken?.release();
		} finally {
			holder.kill();
		}
	});
});
