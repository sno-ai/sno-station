/**
 * QCG-7: a row written by `sno observe append` in one process is uploaded by the memory sidecar
 * in another process when the Claude Code skin's session-end hook runs, and lands as one
 * `events` row in `<profile>/buffer.db`. Everything is real: the `sno` binary on SNO_BIN, the
 * built sidecar, the built hook CLI; the observe base URL is a closed loopback port, so no row
 * ever leaves the machine and the proof reads buffer.db before any successful flush.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const memoryCli = join(repoRoot, "packages/memory/dist/cli.js");
const claudeCli = join(repoRoot, "apps/mem-claude/dist/cli.js");
const transcript = join(repoRoot, "tests/apps/mem-claude/fixtures/skill-runs-46731ba4-4166-4125-8e04-5a3d541c1db3.jsonl");
const snoBin = process.env.SNO_BIN ?? "";

type Envelope = { event_type: string; lane: string; ts_edge_ms: number; payload: Record<string, unknown> };

let root: string;
let profile: string;
let repository: string;
let env: NodeJS.ProcessEnv;

async function closedLoopbackUrl(): Promise<string> {
	const server = createServer();
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no loopback port");
	await new Promise<void>(done => server.close(() => done()));
	return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
	expect(snoBin, "SNO_BIN must name the sno binary under test").not.toBe("");
	expect(existsSync(snoBin), `SNO_BIN ${snoBin} does not exist`).toBe(true);
	root = mkdtempSync(join(tmpdir(), "observe-v2-ledger-upload-"));
	profile = join(root, "profile");
	repository = join(root, "repo");
	mkdirSync(profile);
	mkdirSync(repository);
	execFileSync("git", ["init", "-q", repository]);
	env = {
		...process.env,
		SNO_PROFILE_DIR: profile,
		SNO_OBSERVE_ENABLED: "true",
		SNO_OBSERVE_BASE_URL: await closedLoopbackUrl(),
		SNO_STATION_MEM_NODE_ENV: "test",
	};
	const bind = spawnSync(process.execPath, [memoryCli, "bind", join(root, "memory.sqlite")], {
		encoding: "utf8", timeout: 20_000, env: { ...env, SNO_STATION_CORE_TESTING: "1" },
		input: JSON.stringify({ mode: "local-first", retrieval: { rerank: "none" },
			embedding: { provider: "local-onnx", dimensions: 1024, dtype: "q8" }, memoryTelemetry: { enabled: false, currentKeyVersion: 1 } }),
	});
	expect(bind.status, bind.stderr).toBe(0);
	// The hook's own cold start of the sidecar can exceed its session-end deadline; start it first.
	const start = spawnSync(process.execPath, [memoryCli, "sidecar", "start"], { encoding: "utf8", timeout: 90_000, env });
	expect(start.status, start.stderr).toBe(0);
}, 120_000);

afterEach(() => {
	const discovery = join(profile, "station", "sidecar.json");
	if (existsSync(discovery)) {
		const { pid } = JSON.parse(readFileSync(discovery, "utf8")) as { pid: number };
		try { process.kill(pid, "SIGTERM"); }
		catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
	}
	rmSync(root, { recursive: true, force: true });
});

function envelopes(): Envelope[] {
	const path = join(profile, "buffer.db");
	if (!existsSync(path)) return [];
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const rows = db.prepare("SELECT payload FROM events ORDER BY rowid").all() as { payload: Buffer }[];
		return rows.map(row => JSON.parse(row.payload.toString("utf8")) as Envelope);
	} finally { db.close(); }
}

function count(type: string): number {
	return envelopes().filter(envelope => envelope.event_type === type).length;
}

function sessionEndSnapshots(): number {
	return envelopes().filter(envelope => envelope.event_type === "memory.snapshot" && envelope.payload.snapshot_reason === "session_end").length;
}

/** Waits for the sidecar's own session-end snapshot (the hook reached onSessionEnd), then for the buffer to settle. */
async function settleAfterSessionEnd(snapshots: number): Promise<void> {
	for (let waited = 0; waited < 30_000 && sessionEndSnapshots() < snapshots; waited += 250) await delay(250);
	expect(sessionEndSnapshots(), "the sidecar never ran onSessionEnd for this hook call").toBeGreaterThanOrEqual(snapshots);
	let last = -1;
	for (let stable = 0, waited = 0; stable < 6 && waited < 30_000; waited += 250) {
		await delay(250);
		const now = envelopes().length;
		stable = now === last ? stable + 1 : 0;
		last = now;
	}
}

function sessionEnd(sessionId: string): void {
	const run = spawnSync(process.execPath, [claudeCli, "session-end"], {
		encoding: "utf8", timeout: 60_000, env,
		input: JSON.stringify({ session_id: sessionId, cwd: repository, transcript_path: transcript }),
	});
	expect(run.status, `session-end: ${run.stderr}`).toBe(0);
}

describe("observe v2 ledger upload through the Claude Code skin session end", () => {
	it("uploads one rsi.run row appended by sno and never uploads it twice", async () => {
		const append = spawnSync(snoBin, ["observe", "append", "rsi.run", "--sessions_read=12", "--duration_ms=4400", "--trigger=timer", "--outcome=ok"], {
			encoding: "utf8", timeout: 10_000, env,
		});
		expect(append.status, `sno observe append: ${append.stderr}`).toBe(0);
		const ledger = join(profile, "observe", "ledger.jsonl");
		const [line, ...rest] = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
		expect(rest).toEqual([]);
		const row = JSON.parse(line ?? "") as { ts_ms: number; event_type: string; lane: string; payload: Record<string, unknown> };
		expect(row).toMatchObject({ event_type: "rsi.run", lane: "rsi" });

		sessionEnd("observe-v2-qcg7-first");
		await settleAfterSessionEnd(1);
		const uploaded = envelopes().filter(envelope => envelope.event_type === "rsi.run");
		expect(uploaded).toHaveLength(1);
		expect(uploaded[0]?.lane).toBe("rsi");
		expect(uploaded[0]?.payload).toEqual({ sessions_read: 12, duration_ms: 4400, trigger: "timer", outcome: "ok" });
		expect(uploaded[0]?.ts_edge_ms).toBe(row.ts_ms);
		expect(readFileSync(join(profile, "observe", "ledger.synced"), "utf8").trim()).toBe(String(statSync(ledger).size));

		sessionEnd("observe-v2-qcg7-second");
		await settleAfterSessionEnd(2);
		expect(count("rsi.run")).toBe(1);
	}, 240_000);
});
