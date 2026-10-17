import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { connect, type MemoryClient, type Turn } from "@snoai/memory/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as claude from "../../../apps/mem-claude/src/worker";
import * as codex from "../../../apps/mem-codex/src/worker";
import * as cursor from "../../../apps/mem-cursor/src/worker";
import { startRemSidecar } from "../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";
import { untilModelReady } from "../../packages/memory/integration/fixtures/model-ready";
import { LOCAL_EMBEDDING_CACHE_DIR_DEFAULT } from "../../../packages/embedder/src/constants.ts";

let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;

beforeEach(async () => {
	database = createTestDb();
	root = await mkdtemp(join(tmpdir(), "worker-session-batch-"));
	vi.stubEnv("SNO_PROFILE_DIR", root);
	writeSettingsFixture(root, { mode: "agent-native",
		store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		embedding: { cacheDir: LOCAL_EMBEDDING_CACHE_DIR_DEFAULT },
		rerank: { mode: "none" }, rem: { tick: false },
		telemetry: { observe: { enabled: false }, memoryUsage: { enabled: false } },
	});
	sidecar = await startRemSidecar();
	vi.spyOn(console, "log").mockImplementation(() => {});
}, 60_000);

afterEach(async () => {
	await sidecar?.stop();
	sidecar = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	database?.cleanup();
	if (root) await rm(root, { recursive: true, force: true });
});

describe.each([
	["claude", "claude-code", claude], ["codex", "codex", codex], ["cursor", "cursor", cursor],
] as const)("%s conversation batches through the real sidecar", (skin, skinId, worker) => {
	async function fixture() {
		const directory = join(root, `sno-mem-${skin}`, "spool");
		await mkdir(directory, { recursive: true });
		const connected = await connect({ skinId });
		if (connected.degraded) throw new Error(connected.error ?? connected.reason);
		const client: MemoryClient = connected;
		await untilModelReady(({ scope, query, options }) =>
			client.getRecall(query, { principal: client.principal, ...scope }, options), 30_000);
		let clock = 1791820800000;
		const requests: Array<{ session: string; turn: Turn; committed: boolean }> = [];
		const prompts: string[] = [];
		const capture = client.capture.bind(client);
		client.capture = async (turn, scope) => {
			const result = await capture(turn, scope);
			requests.push({ session: scope.session, turn, committed: !result.degraded && result.committed });
			return result;
		};
		async function spool(name: string, sessionId: string, turnId: string, at: number) {
			await writeFile(join(directory, name), JSON.stringify({ sessionId, turnId, project: root,
				childCwd: root, user: `I am checking build ${turnId}.`, assistant: `Build ${turnId} is running.`,
				at, attempts: 0, state: "pending" }));
		}
		const deps = {
			async connect() { return client; }, now: () => clock,
			async sleep(ms: number) { clock += ms; },
			async runChild(prompt: string) {
				prompts.push(prompt);
				const turns = JSON.parse(prompt.split("transcript:\n").at(-1)?.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "null") as Array<{ role: string; turn_index: number }>;
				return { kind: "ok" as const, text: JSON.stringify({ claims_found: [],
					decisions: turns.filter(turn => turn.role === "user").map(turn => ({ turn_index: turn.turn_index, progress_only: false })), facts: [] }) };
			},
		};
		return { directory, client, requests, prompts, spool, deps };
	}

	function ledger() {
		return (database.sqlite.prepare("SELECT conversation_id, raw_chunk, state FROM nodix_atomic_extraction_ledger ORDER BY conversation_id, rowid").all() as Array<{ conversation_id: string; raw_chunk: string; state: string }>)
			.map(row => ({ session: row.conversation_id, state: row.state,
				texts: (JSON.parse(row.raw_chunk).turns as Array<{ content: string }>).map(turn => turn.content.trim()) }));
	}

	it("sends all three pending turns in one request and commits one extraction window", async () => {
		const f = await fixture();
		await f.spool("0003.json", "session-one", "three", 1791820800002);
		await f.spool("0001.json", "session-one", "one", 1791820800000);
		await f.spool("0002.json", "session-one", "two", 1791820800001);
		expect(await worker.runWorker(f.deps)).toBe("drained");
		expect(f.requests.map(request => ({ session: request.session, committed: request.committed,
			texts: request.turn.messages.map(message => message.content) }))).toEqual([
			{ session: "session-one", committed: true, texts: ["I am checking build one.", "Build one is running.",
				"I am checking build two.", "Build two is running.", "I am checking build three.", "Build three is running."] },
		]);
		expect(ledger()).toEqual([{ session: "session-one", state: "complete", texts: [
			"I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running.",
			"I am checking build three.", "Build three is running.",
		] }]);
		expect(await readdir(f.directory)).toEqual([]);
	}, 60_000);

	it("sends two requests for interleaved turns from two sessions", async () => {
		const f = await fixture();
		await f.spool("0001.json", "session-one", "one", 1791820800000);
		await f.spool("0002.json", "session-two", "two", 1791820800001);
		await f.spool("0003.json", "session-one", "three", 1791820800002);
		expect(await worker.runWorker(f.deps)).toBe("drained");
		expect(f.requests.map(request => ({ session: request.session, committed: request.committed,
			texts: request.turn.messages.map(message => message.content) }))).toEqual([
			{ session: "session-one", committed: true, texts: ["I am checking build one.", "Build one is running.", "I am checking build three.", "Build three is running."] },
			{ session: "session-two", committed: true, texts: ["I am checking build two.", "Build two is running."] },
		]);
		expect(ledger()).toEqual([
			{ session: "session-one", state: "complete", texts: ["I am checking build one.", "Build one is running.", "I am checking build three.", "Build three is running."] },
			{ session: "session-two", state: "complete", texts: ["I am checking build two.", "Build two is running."] },
		]);
		expect(await readdir(f.directory)).toEqual([]);
	}, 60_000);

	it("captures ten pending turns in one request and one complete ledger window", async () => {
		const f = await fixture();
		for (const [index, name] of ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].entries())
			await f.spool(`${String(index).padStart(4, "0")}.json`, "session-ten", name, 1791820800000 + index);
		expect(await worker.runWorker(f.deps)).toBe("drained");
		const expected = ["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running.",
			"I am checking build three.", "Build three is running.", "I am checking build four.", "Build four is running.",
			"I am checking build five.", "Build five is running.", "I am checking build six.", "Build six is running.",
			"I am checking build seven.", "Build seven is running.", "I am checking build eight.", "Build eight is running.",
			"I am checking build nine.", "Build nine is running.", "I am checking build ten.", "Build ten is running."];
		expect(f.requests.map(request => ({ session: request.session, committed: request.committed,
			texts: request.turn.messages.map(message => message.content) })))
			.toEqual([{ session: "session-ten", committed: true, texts: expected }]);
		expect(ledger()).toEqual([{ session: "session-ten", state: "complete", texts: expected }]);
		expect(await readdir(f.directory)).toEqual([]);
	}, 60_000);

	it("keeps every message when an oversized batch uses the existing input splitting", async () => {
		const f = await fixture();
		await f.spool("0001.json", "session-long", "one", 1791820800000);
		await f.spool("0002.json", "session-long", "two", 1791820800001);
		const path = join(f.directory, "0001.json");
		const record = JSON.parse(await readFile(path, "utf8"));
		record.user = Array.from({ length: 1200 }, () => "The build is running steadily.").join("\n\n");
		await writeFile(path, JSON.stringify(record));
		expect(await worker.runWorker(f.deps)).toBe("drained");
		expect(f.requests.map(request => ({ session: request.session, committed: request.committed,
			lengths: request.turn.messages.map(message => String(message.content).length) })))
			.toEqual([{ session: "session-long", committed: true, lengths: [38398, 21, 24, 21] }]);
		expect(ledger().map(row => ({ session: row.session, state: row.state, lengths: row.texts.map(text => text.length) })))
			.toEqual([{ session: "session-long", state: "complete", lengths: [38398, 21, 24, 21] }]);
		expect(await readdir(f.directory)).toEqual([]);
	}, 60_000);

	it("keeps the whole batch after a lost response and retries without extracting twice", async () => {
		const f = await fixture();
		await f.spool("0001.json", "session-one", "one", 1791820800000);
		await f.spool("0002.json", "session-one", "two", 1791820800001);
		const capture = f.client.capture.bind(f.client);
		let lost = false;
		f.client.capture = async (turn, scope) => {
			const result = await capture(turn, scope);
			if (!lost) { lost = true; throw new Error("capture response lost after commit"); }
			return result;
		};
		const sleep = f.deps.sleep;
		f.deps.sleep = async ms => {
			const names = (await readdir(f.directory)).sort();
			if (names.length) {
				expect(names).toEqual(["0001.json", "0002.json"]);
				const records = await Promise.all(names.map(async name => JSON.parse(await readFile(join(f.directory, name), "utf8"))));
				expect(records.map(record => ({ attempts: record.attempts, state: record.state, retryAt: record.retryAt })))
					.toEqual([{ attempts: 1, state: "pending", retryAt: 1791820802000 }, { attempts: 1, state: "pending", retryAt: 1791820802000 }]);
			}
			await sleep(ms);
		};
		expect(await worker.runWorker(f.deps)).toBe("drained");
		expect(f.requests.map(request => request.turn.messages.map(message => message.content))).toEqual([
			["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running."],
			["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running."],
		]);
		expect(ledger()).toEqual([{ session: "session-one", state: "complete", texts: ["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running."] }]);
		expect(await readdir(f.directory)).toEqual([]);
	}, 60_000);

	it("retries every rejected turn together, then gives up only the first so the rest are tried again alone", async () => {
		const f = await fixture();
		await f.spool("0001.json", "session-one", "one", -1);
		await f.spool("0002.json", "session-one", "two", 1791820800001);
		const capture = f.client.capture.bind(f.client);
		const sent: unknown[][] = [];
		f.client.capture = async (turn, scope) => {
			sent.push(turn.messages.map(message => message.content));
			return capture(turn, scope);
		};
		const sleep = f.deps.sleep;
		const pending: Array<Array<{ attempts: number; retryAt: number }>> = [];
		f.deps.sleep = async ms => {
			const names = (await readdir(f.directory)).sort();
			if (names.length) {
				expect(names).toEqual(["0001.json", "0002.json"]);
				pending.push(await Promise.all(names.map(async name => {
					const record = JSON.parse(await readFile(join(f.directory, name), "utf8"));
					return { attempts: record.attempts, retryAt: record.retryAt };
				})));
			}
			await sleep(ms);
		};
		expect(await worker.runWorker(f.deps)).toBe("drained");
		expect(sent).toEqual([
			["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running."],
			["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running."],
			["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running."],
			["I am checking build two.", "Build two is running."],
		]);
		expect(pending).toEqual([
			[{ attempts: 1, retryAt: 1791820802000 }, { attempts: 1, retryAt: 1791820802000 }],
			[{ attempts: 2, retryAt: 1791820812000 }, { attempts: 2, retryAt: 1791820812000 }],
		]);
		expect(ledger()).toEqual([
			{ session: "session-one", state: "complete", texts: ["I am checking build two.", "Build two is running."] },
		]);
		expect(await readdir(f.directory)).toEqual([]);
	}, 60_000);

	it("resumes the same failed batch after restart before capturing a newly arrived turn", async () => {
		const f = await fixture();
		await f.spool("0001.json", "session-one", "one", 1791820800000);
		await f.spool("0002.json", "session-one", "two", 1791820800001);
		const capture = f.client.capture.bind(f.client);
		let lost = false;
		f.client.capture = async (turn, scope) => {
			const result = await capture(turn, scope);
			if (!lost) {
				lost = true;
				await f.spool("0003.json", "session-one", "three", 1791820800002);
				throw new Error("capture response lost after commit");
			}
			return result;
		};
		await expect(worker.runWorker({ ...f.deps, async sleep() { throw new Error("restart between attempts"); } }))
			.rejects.toThrow("restart between attempts");
		expect((await readdir(f.directory)).sort()).toEqual(["0001.json", "0002.json", "0003.json"]);
		expect(await worker.runWorker(f.deps)).toBe("drained");
		expect(f.requests.map(request => request.turn.messages.map(message => message.content))).toEqual([
			["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running."],
			["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running."],
			["I am checking build three.", "Build three is running."],
		]);
		expect(ledger()).toEqual([
			{ session: "session-one", state: "complete", texts: ["I am checking build one.", "Build one is running.", "I am checking build two.", "Build two is running."] },
			{ session: "session-one", state: "complete", texts: ["I am checking build three.", "Build three is running."] },
		]);
		expect(await readdir(f.directory)).toEqual([]);
	}, 60_000);
});
