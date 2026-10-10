import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect, type InitRegistration, type MemoryClient } from "@snoai/memory/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquirePidFileLock } from "../../../apps/mem-claude/src/files.js";
import { importDirectory, spoolDirectory, workerLockPath } from "../../../apps/mem-claude/src/paths.js";
import { runWorker, type WorkerDependencies } from "../../../apps/mem-claude/src/worker.js";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";
import { untilModelReady } from "../../packages/memory/integration/fixtures/model-ready";

const repoRoot = resolve(import.meta.dirname, "../../..");
const extraction = '{"claims_found":[],"decisions":[{"turn_index":0,"progress_only":false}],"facts":[]}';
let root: string;
let client: MemoryClient;
let previousEnv: Record<string, string | undefined>;
// The machine's own model cache (read from the account, not HOME): no per-test model download.
const MODEL_CACHE = join(userInfo().homedir, ".cache", "sno-station", "models");

beforeEach(async ({ task }) => {
	root = await mkdtemp(join(tmpdir(), "mem-claude-worker-"));
	previousEnv = { SNO_PROFILE_DIR: process.env.SNO_PROFILE_DIR, HOME: process.env.HOME };
	process.env.SNO_PROFILE_DIR = root;
	// The store list lives under HOME; the service started below inherits this environment.
	process.env.HOME = join(root, "home");
	writeSettingsFixture(root, { mode: "agent-native", capture: { ambient: task.name !== "finishes an import when ambient capture is disabled" }, rerank: { mode: "none" }, embedding: { cacheDir: MODEL_CACHE } });
	const connected = await connect({ skinId: "claude-code" });
	if (connected.degraded) throw new Error(connected.error ?? connected.reason);
	client = connected;
	// Every case below expects committed captures, which need the prepared embedding model.
	await untilModelReady(({ scope, query, options }) => client.getRecall(query, { principal: client.principal, ...scope }, options));
}, 150_000);

afterEach(async () => {
	if (client) {
		try { process.kill(client.pid, "SIGTERM"); }
		catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
		// The sidecar writes into the profile until it exits; removing the root earlier races it.
		for (let attempt = 0; attempt < 200; attempt += 1) {
			try { process.kill(client.pid, 0); } catch { break; }
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});

async function spool(name: string, turnId: string, at = Date.now()): Promise<string> {
	await mkdir(spoolDirectory(), { recursive: true });
	const path = join(spoolDirectory(), name);
	await writeFile(path, JSON.stringify({ sessionId: `session-${turnId}`, turnId, project: root,
		childCwd: root, user: `The probe for turn ${turnId} has no durable facts.`,
		assistant: "Acknowledged.", at, attempts: 0, state: "pending" }));
	return path;
}

// Worker time runs on an injected clock: retry waits and the two idle minutes a drained worker
// stays up advance it instantly, so no case waits in real time for the worker's own sleeps.
function observeClient() {
	let clock = Date.now();
	const captures: Array<{ turnId: string; at: number; committed?: boolean }> = [];
	let registration: InitRegistration | undefined;
	const originalInit = client.init.bind(client);
	const originalCapture = client.capture.bind(client);
	client.init = async (scope, value) => {
		registration = value;
		return originalInit(scope, value);
	};
	client.capture = async (turn, scope) => {
		const record: (typeof captures)[number] = { turnId: turn.turnId, at: clock };
		captures.push(record);
		const result = await originalCapture(turn, scope);
		record.committed = !result.degraded && result.committed;
		return result;
	};
	const deps: WorkerDependencies = {
		async connect() { return client; },
		now: () => clock,
		async sleep(delayMs) { clock += delayMs; },
		async runChild(_prompt, cwd) {
			expect(cwd).toBe(join(root, "sno-mem-claude", "child"));
			return { kind: "ok", text: extraction };
		},
	};
	return { captures, deps, get registration() { return registration; } };
}

describe("Claude worker with a real sidecar", () => {
	it("finishes an import when ambient capture is disabled", async () => {
		const path = await spool("0001.json", "capture-disabled");
		await mkdir(importDirectory(), { recursive: true });
		const receiptPath = join(importDirectory(), "receipt.json");
		await writeFile(receiptPath, JSON.stringify({ files: { "/note.md": { committed: 0, failures: 0 } } }));
		const record = JSON.parse(await readFile(path, "utf8"));
		record.kind = "import";
		record.importReceipt = { path: receiptPath, file: "/note.md" };
		await writeFile(path, JSON.stringify(record));
		const fixture = observeClient();
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.captures).toEqual([{ turnId: "capture-disabled", at: expect.any(Number), committed: false }]);
		expect(await readdir(spoolDirectory())).toEqual([]);
		expect(JSON.parse(await readFile(receiptPath, "utf8")).files["/note.md"]).toEqual({ committed: 0, failures: 0, skipped: 1 });
	}, 30_000);

	it("admits one concurrent worker, registers with only its skin and model, and drains three files in order", async () => {
		await spool("0002.json", "two");
		await spool("0001.json", "one");
		await spool("0003.json", "three");
		const fixture = observeClient();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = runWorker({ ...fixture.deps, async connect() {
			entered.resolve();
			await release.promise;
			return client;
		} });
		await entered.promise;
		try {
			expect(existsSync(workerLockPath())).toBe(true);
			expect(await runWorker(fixture.deps)).toBe("locked");
		} finally { release.resolve(); }
		expect(await first).toBe("drained");
		expect(fixture.captures.map(item => item.turnId)).toEqual(["one", "two", "three"]);
		expect(fixture.captures.every(item => item.committed === true)).toBe(true);
		expect(await readdir(spoolDirectory())).toEqual([]);
		// The service reads routing and settings from settings.json; the worker sends only the skin
		// and its model callback.
		expect(fixture.registration).toEqual({
			skinId: "claude-code",
			model: { baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/), credential: expect.any(String), model: "claude-exec" },
		});
		const health = await fetch(`http://127.0.0.1:${client.port}/healthz`);
		expect(health.status).toBe(200);
		expect((await health.json()).status).toBe("ok");
		expect(existsSync(workerLockPath())).toBe(false);
	}, 90_000);

	it("reclaims a dead lock and drains a record arriving as the lock is released", async () => {
		await mkdir(dirname(workerLockPath()), { recursive: true });
		await writeFile(workerLockPath(), "2147483647 1\n");
		await spool("0001.json", "after-crash");
		const fixture = observeClient();
		let queued = false;
		await runWorker({ ...fixture.deps,
			async beforeLockRelease() {
				if (queued) return;
				queued = true;
				await spool("0002.json", "handoff");
			},
			async handoff() { expect(await runWorker(fixture.deps)).toBe("drained"); },
		});
		expect(fixture.captures.map(item => item.turnId)).toEqual(["after-crash", "handoff"]);
		expect(fixture.captures.every(item => item.committed === true)).toBe(true);
		expect(await readdir(spoolDirectory())).toEqual([]);
		expect(existsSync(workerLockPath())).toBe(false);
	}, 90_000);

	it("keeps a real rejected capture after three attempts spaced by two and ten seconds", async () => {
		// The sidecar contract rejects a negative message timestamp over the real HTTP route.
		const path = await spool("0001.json", "invalid-timestamp", -1);
		const fixture = observeClient();
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ attempts: 3, state: "failed" });
		expect(fixture.captures).toHaveLength(3);
		const [first, second, third] = fixture.captures;
		if (!first || !second || !third) throw new Error("three capture observations are required");
		expect(second.at - first.at).toBeGreaterThanOrEqual(2_000);
		expect(third.at - second.at).toBeGreaterThanOrEqual(10_000);
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.captures).toHaveLength(3);
	}, 30_000);

	it("paces real import callback requests while serving text and typed HTTP 503 errors", async () => {
		const path = await spool("0001.json", "callback");
		const record = JSON.parse(await readFile(path, "utf8"));
		record.kind = "import";
		delete record.assistant;
		await writeFile(path, JSON.stringify(record));
		const fixture = observeClient();
		const childStarts: number[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const capture = client.capture.bind(client);
		client.capture = async (turn, scope) => { entered.resolve(); await release.promise; return capture(turn, scope); };
		const worker = runWorker({ ...fixture.deps, async runChild(prompt) {
			childStarts.push(Date.now());
			if (prompt.includes("CHILD_FAILURE_PROBE")) return { kind: "error", category: "transport", message: "child-exit-1" };
			return { kind: "ok", text: prompt.includes("CALLBACK_PROBE") ? "child answer" : extraction };
		} });
		await entered.promise;
		try {
			const model = fixture.registration?.model;
			if (!model) throw new Error("worker registration missing model");
			for (const [text, status] of [["CALLBACK_PROBE", 200], ["CHILD_FAILURE_PROBE", 503]] as const) {
				const response = await fetch(`${model.baseUrl}/chat/completions`, {
					method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${model.credential}` },
					body: JSON.stringify({ model: "claude-exec", messages: [{ role: "system", content: "system" }, { role: "user", content: text }] }),
				});
				expect(response.status).toBe(status);
				expect(await response.json()).toEqual(status === 200
					? { choices: [{ message: { role: "assistant", content: "child answer" } }] }
					: { error: { kind: "error", category: "transport", message: "child-exit-1" } });
			}
			expect(childStarts).toHaveLength(2);
			const [first, second] = childStarts;
			if (first === undefined || second === undefined) throw new Error("two child starts are required");
			expect(second - first).toBeGreaterThanOrEqual(2_000);
		} finally { release.resolve(); }
		expect(await worker).toBe("drained");
	}, 60_000);

	it.each(["exit-1", "is-error"])("relays an actual %s stub child through the production worker", async failure => {
		await spool("0001.json", `child-${failure}`);
		const bin = join(root, "bin");
		await mkdir(bin);
		const claude = join(bin, "claude");
		await writeFile(claude, `#!${process.execPath}\n${failure === "exit-1"
			? "process.exit(1);"
			: 'console.log(JSON.stringify({is_error:true,result:"refused",usage:{cache_creation_input_tokens:0}}));'}\n`);
		await chmod(claude, 0o700);
		const worker = spawn(process.execPath, ["--import", "tsx", "apps/mem-claude/src/cli.ts", "worker"], {
			cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		worker.stdout.on("data", chunk => { stdout += chunk; });
		worker.stderr.on("data", chunk => { stderr += chunk; });
		const closed = new Promise<void>(resolve => worker.once("close", () => resolve()));
		// The production worker stays up two real idle minutes after draining, so the case stops it
		// once the relayed failure is on its output instead of waiting for it to exit.
		const relayed = /"event":"model-callback","model":"claude-exec","status":503/;
		const deadline = Date.now() + 80_000;
		while (!relayed.test(stdout) && worker.exitCode === null && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		worker.kill("SIGTERM");
		await closed;
		expect(stdout, stderr).toMatch(relayed);
	}, 100_000);
});

// Local First PRD REQ-3: the callback answers while the worker lives, not only during spool work,
// and a drained worker stays up while its callback served a call in the last 2 minutes (9-minute cap).
describe("Claude worker callback with an empty spool", () => {
	const answer = { choices: [{ message: { role: "assistant", content: "child answer" } }] };

	async function postCallback(model: { baseUrl: string; credential: string }, text: string) {
		const response = await fetch(`${model.baseUrl}/chat/completions`, {
			method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${model.credential}` },
			body: JSON.stringify({ model: "claude-exec", messages: [{ role: "system", content: "system" }, { role: "user", content: text }] }),
		});
		const raw = await response.text();
		let body: unknown = raw;
		try { body = JSON.parse(raw); } catch { /* keep the raw text in the failure diff */ }
		return { status: response.status, body };
	}

	// Registers through the real sidecar. Worker time is the injected clock; each callback request
	// arrives at its scheduled offset (ms after start) while the worker sleeps, as a service call does.
	function callbackWorker(callsAt: number[], probeAtRegistration = true) {
		const startedAt = Date.now();
		let clock = startedAt;
		let sleeps = 0;
		let model: { baseUrl: string; credential: string } | undefined;
		const prompts: string[] = [];
		const served: Array<{ at: number; status: number; body: unknown }> = [];
		const init = client.init.bind(client);
		client.init = async (scope, value) => {
			const result = await init(scope, value);
			model = value.model;
			if (!model) throw new Error("worker registration missing model");
			if (probeAtRegistration) served.push({ at: 0, ...await postCallback(model, "REGISTRATION_PROBE") });
			return result;
		};
		const deps: WorkerDependencies = {
			async connect() { return client; },
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
				expect(cwd).toBe(join(root, "sno-mem-claude", "child"));
				prompts.push(prompt.split("\n").at(-1) ?? "");
				return { kind: "ok", text: "child answer" };
			},
		};
		return { deps, served, prompts, startedAt, get exitedAfter() { return clock - startedAt; } };
	}

	// The callback runs one child at a time. A call whose requester gave up while it waited in line used to start a
	// child anyway, spending the user's model quota on an answer nobody read.
	it("does not run the model for a call its requester gave up on while it waited", async () => {
		const fixture = callbackWorker([], false);
		const children: string[] = [];
		const connect = fixture.deps.connect;
		fixture.deps.connect = async () => {
			const connected = await connect();
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
						body: JSON.stringify({ model: "claude-exec", messages: [{ role: "user", content: "GAVE_UP" }] }) }).catch(() => {});
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
		const fixture = callbackWorker([30_000, 150_000, 200_000]);
		expect(await runWorker(fixture.deps)).toBe("drained");
		expect(fixture.served).toEqual([0, 30_000, 150_000, 200_000].map(at => ({ at, status: 200, body: answer })));
		expect(fixture.prompts).toEqual(["user: REGISTRATION_PROBE", "user: CALL_AT_30000", "user: CALL_AT_150000", "user: CALL_AT_200000"]);
		expect(fixture.exitedAfter).toBe(200_000 + 2 * 60_000);
		expect(existsSync(workerLockPath())).toBe(false);
	}, 60_000);

	// The service dispatches REM after registration returns, so its first call can arrive only once
	// the worker has drained its spool (Done test: the pass reaches its end with the spool empty).
	it("waits after registration for a first call that arrives once the spool is empty", async () => {
		const fixture = callbackWorker([90_000], false);
		await runWorker(fixture.deps);
		expect(fixture.served.map(({ at, status }) => ({ at, status }))).toEqual([{ at: 90_000, status: 200 }]);
		expect(fixture.exitedAfter).toBe(90_000 + 2 * 60_000);
	}, 60_000);

	// A call every minute keeps the worker alive; it answers every call up to the cap and exits at
	// exactly nine minutes, never earlier and never later.
	it("keeps answering while called and exits exactly at the nine-minute cap", async () => {
		const everyMinute = Array.from({ length: 10 }, (_, index) => (index + 1) * 60_000);
		const fixture = callbackWorker(everyMinute);
		await runWorker(fixture.deps);
		expect(fixture.served.map(({ at, status }) => ({ at, status }))).toEqual(
			[0, ...everyMinute.filter(offset => offset <= 9 * 60_000)].map(at => ({ at, status: 200 })));
		expect(fixture.exitedAfter).toBe(9 * 60_000);
	}, 60_000);
});

describe("worker lock files", () => {
	it("waits while a worker from before an upgrade still holds the lock under the old lock kind", async () => {
		// A worker started before an upgrade held its guard with flock, which the new lock cannot see on Linux; both
		// workers then drained the same spool, and the second unlink rewrote a committed record for another capture.
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
	it("admits one racer and recovers when a reclaim marker's owner is dead", async () => {
		const path = join(root, "race.lock");
		const locks = await Promise.all([acquirePidFileLock(path, 60_000), acquirePidFileLock(path, 60_000)]);
		const winners = locks.filter(lock => lock !== undefined);
		expect(winners).toHaveLength(1);
		await winners[0]?.release();
		await writeFile(path, "2147483647 1\n");
		await writeFile(`${path}.reclaim`, "2147483647 1\n");
		const reclaimed = await acquirePidFileLock(path, 60_000);
		expect(reclaimed).toBeDefined();
		await reclaimed?.release();
	});
});
