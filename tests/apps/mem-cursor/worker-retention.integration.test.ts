import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type MemoryClient } from "../../../packages/memory/src/contract/client";
import { startRemSidecar } from "../../../packages/memory/src/sidecar/server";
import { runCursorChild, runWorker } from "../../../apps/mem-cursor/src/worker";
import { runWorker as runClaudeWorker } from "../../../apps/mem-claude/src/worker";
import { runWorker as runCodexWorker } from "../../../apps/mem-codex/src/worker";
import { createTestDb } from "../mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";
import { untilModelReady } from "../../packages/memory/integration/fixtures/model-ready";

let root: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>>;
let client: MemoryClient;
const savedPath = process.env.PATH;
let clock = Date.now();

beforeAll(async () => {
	database = createTestDb();
	root = mkdtempSync(join(tmpdir(), "cursor-retention-"));
	process.env.SNO_PROFILE_DIR = root;
	process.env.PATH = `${root}:${savedPath}`;
	writeSettingsFixture(root, { mode: "agent-native", rerank: { mode: "none" }, rem: { tick: false },
		store: { path: database.dbPath, encryptionKey: database.encryptionKey },
		telemetry: { observe: { enabled: false }, memoryUsage: { enabled: false } } });
	mkdirSync(join(root, "sno-station-mem"), { recursive: true });
	for (const skin of ["cursor", "claude", "codex"]) mkdirSync(join(root, `sno-mem-${skin}`, "spool"), { recursive: true });
	// Only the external model executable is substituted. Worker, HTTP callback, sidecar and storage are real.
	writeFileSync(join(root, "cursor-agent"), `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const mode = fs.readFileSync(${JSON.stringify(join(root, "mode"))}, 'utf8');
  fs.appendFileSync(${JSON.stringify(join(root, "calls"))}, mode + '\\n');
  if (mode !== 'ok') { console.error(mode); process.exitCode = 1; return; }
  const data = JSON.parse(prompt.split('<take>\\n').at(-1)?.split('\\n</take>')[0] ?? 'null');
  let answer;
  if (prompt.includes('Task: user-subject guard.')) {
    answer = { decisions: data.map(({record_index}) => ({record_index, durable_self_statement: true})) };
  } else if (prompt.includes('facts:\\n')) {
    answer = { enrichments: data.map(({id, fact}) => ({id, kind: 'standing', attribute: 'preference.food', value: fact,
      ends_current: false, importance: 'medium', changes_current_state: false, todo: 'none', close_reason: null,
      single_claim: true, relations: [], time: {kind: 'none'}, ended_time: {kind: 'none'}})) };
  } else if (prompt.includes('"claims_found"') && prompt.includes('transcript:\\n')) {
    const turns = data.filter(turn => turn.role === 'user');
    answer = {claims_found: turns.map(turn => turn.turn_index),
      decisions: turns.map(turn => ({turn_index: turn.turn_index, progress_only: false})),
      facts: turns.map((turn, id) => ({id, fact: turn.content, subject: 'user', subject_kind: 'user',
        temporal_phrase: null, ended_at_phrase: null, source_span: {turn_index: turn.turn_index, quote: turn.content}}))};
  } else { answer = {records: []}; }
  console.log(JSON.stringify({is_error: false, result: JSON.stringify(answer)}));
});
`);
	chmodSync(join(root, "cursor-agent"), 0o755);
	sidecar = await startRemSidecar();
	const connected = await connect({ skinId: "cursor" });
	if (connected.degraded) throw new Error(connected.reason);
	client = connected;
	await client.init({ principal: client.principal, project: "global", session: "setup" }, { skinId: "cursor" });
	await untilModelReady(({ scope, query, options }) => client.getRecall(query, { principal: client.principal, ...scope }, options), 30_000);
}, 60_000);

afterAll(async () => {
	await sidecar?.stop();
	database?.cleanup();
	process.env.PATH = savedPath;
	if (root) rmSync(root, { recursive: true, force: true });
});

// Advance only the worker's existing idle/retry clock; model execution and filesystem operations use real time.
describe.each(["cursor", "claude", "codex"] as const)("%s worker retention", skin => {
const spoolDirectory = () => join(root, `sno-mem-${skin}`, "spool");
const workerLockPath = () => join(root, `sno-mem-${skin}`, "worker.lock");
const run = async () => {
	const connected = await connect({ skinId: skin });
	if (connected.degraded) throw new Error(connected.reason);
	const dependencies = { connect: async () => connected, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
	if (skin === "cursor") return runWorker({ ...dependencies, runChild: runCursorChild });
	// Exercise each real worker with the real Cursor child adapter; only cursor-agent is substituted.
	return (skin === "claude" ? runClaudeWorker : runCodexWorker)({ ...dependencies,
		runChild: (prompt, _cwd, timeoutMs) => runCursorChild(prompt, timeoutMs) });
};

it.each([
	["quota", "ActionRequiredError: You've hit your usage limit", "I prefer jasmine tea."],
	["logged-out", "Error: Authentication required. Run 'cursor-agent login'.", "I prefer roasted coffee."],
	["expired-login", "ConnectError: [unauthenticated] Login expired", "I prefer ripe pears."],
	["locked-login", "Error: Your macOS login keychain is locked.", "I prefer brown rice."],
])("retains %s failures across worker exits and saves after recovery", async (name, failure, preference) => {
	const id = `${skin}-${name}`;
	const fact = `${preference.slice(0, -1)} while using ${skin}.`;
	const path = join(spoolDirectory(), `${id}.json`);
	const record = { sessionId: id, turnId: id, project: "global", childCwd: root, user: fact, assistant: "Noted.",
		at: Date.now() - 60 * 60_000, attempts: 2, state: "pending" };
	writeFileSync(path, JSON.stringify(record));
	writeFileSync(join(root, "mode"), failure);
	try {
		const result = await run();
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
		expect(result).toBe("failed");
		expect(existsSync(workerLockPath())).toBe(false);
		// A second run while still unavailable must not consume the final attempt either.
		expect(await run()).toBe("failed");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
		writeFileSync(join(root, "mode"), "ok");
		expect(await run()).toBe("drained");
		expect(existsSync(path)).toBe(false);
		expect(database.sqlite.prepare("SELECT trim(text, char(10) || ' ') AS text FROM nodix_memories WHERE trim(text, char(10) || ' ') = ?").get(fact)).toEqual({ text: fact });
	} finally { rmSync(path, { force: true }); }
}, 60_000);

it("still removes ordinary failures after three attempts", async () => {
	const path = join(spoolDirectory(), "transport.json");
	writeFileSync(path, JSON.stringify({ sessionId: `${skin}-transport`, turnId: `${skin}-transport`, project: "global", childCwd: root,
		user: "I prefer fresh apples.", assistant: "Noted.", at: Date.now() - 60 * 60_000, attempts: 0, state: "pending" }));
	writeFileSync(join(root, "mode"), "Workspace Trust Required");
	expect(await run()).toBe("drained");
	expect(existsSync(path)).toBe(false);
	expect(database.sqlite.prepare("SELECT text FROM nodix_memories WHERE trim(text, char(10) || ' ') = ?").get("I prefer fresh apples.")).toBeUndefined();
}, 60_000);

});
