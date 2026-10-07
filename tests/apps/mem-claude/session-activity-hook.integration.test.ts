/**
 * A Claude Code session ends and its working time reaches the SDK's buffer: the built SessionEnd
 * hook reads the transcript, appends one session.activity row to the observe ledger, and the real
 * sidecar validates it with the SDK schema and stores it in `<profile>/buffer.db`. A second
 * session end over the same transcript adds nothing. The observe base URL is a closed loopback
 * port, so nothing leaves the machine.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { connect } from "@snoai/memory/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../..");
// The machine's own model cache (read from the account, not HOME): no per-test model download.
const MODEL_CACHE = join(userInfo().homedir, ".cache", "sno-station", "models");
const claudeCli = join(repoRoot, "apps/mem-claude/dist/cli.js");

const sessionId = "6a1f3b52-0c7e-4d3a-9b1e-2f4c8d7e5a10";
type Row = { event_type: string; lane: string; payload: Record<string, unknown> };

let root: string;
let profile: string;
let env: NodeJS.ProcessEnv;
let previousEnv: Record<string, string | undefined>;

async function closedLoopbackUrl(): Promise<string> {
	const server = createServer();
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no loopback port");
	await new Promise<void>(done => server.close(() => done()));
	return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "mem-claude-skill-runs-"));
	profile = join(root, "profile");
	mkdirSync(profile);
	writeSettingsFixture(profile, { mode: "local-first", rerank: { mode: "none" }, embedding: { cacheDir: MODEL_CACHE },
		telemetry: { observe: { enabled: true, baseUrl: await closedLoopbackUrl() } } });
	// The hooks, and the service started below, run in this environment; the store list lives under HOME.
	previousEnv = { SNO_PROFILE_DIR: process.env.SNO_PROFILE_DIR, HOME: process.env.HOME,
		SNO_STATION_MEM_NODE_ENV: process.env.SNO_STATION_MEM_NODE_ENV };
	process.env.SNO_PROFILE_DIR = profile;
	process.env.HOME = join(root, "home");
	process.env.SNO_STATION_MEM_NODE_ENV = "test";
	env = { ...process.env };
	// The hook's own cold start of the service can exceed its session-end deadline; start it first.
	const started = await connect({ skinId: "claude-code" });
	if (started.degraded) throw new Error(started.error ?? started.reason);
}, 120_000);

afterEach(() => {
	const discovery = join(profile, "station", "sidecar.json");
	if (existsSync(discovery)) {
		const { pid } = JSON.parse(readFileSync(discovery, "utf8")) as { pid: number };
		try { process.kill(pid, "SIGTERM"); }
		catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
	}
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function buffered(): Row[] {
	const path = join(profile, "buffer.db");
	if (!existsSync(path)) return [];
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const rows = db.prepare("SELECT payload FROM events ORDER BY rowid").all() as { payload: Buffer }[];
		return rows.map(row => JSON.parse(row.payload.toString("utf8")) as Row);
	} finally { db.close(); }
}

function ledgerRows(): Row[] {
	const path = join(profile, "observe", "ledger.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Row);
}

function sessionEndSnapshots(): number {
	return buffered().filter(row => row.event_type === "memory.snapshot" && row.payload.snapshot_reason === "session_end").length;
}

/** Waits for the sidecar's own session-end snapshot (the hook reached onSessionEnd), then for the buffer to settle. */
async function settleAfterSessionEnd(snapshots: number): Promise<void> {
	for (let waited = 0; waited < 30_000 && sessionEndSnapshots() < snapshots; waited += 250) await delay(250);
	expect(sessionEndSnapshots(), "the sidecar never ran onSessionEnd for this hook call").toBeGreaterThanOrEqual(snapshots);
	let last = -1;
	for (let stable = 0, waited = 0; stable < 6 && waited < 30_000; waited += 250) {
		await delay(250);
		const now = buffered().length;
		stable = now === last ? stable + 1 : 0;
		last = now;
	}
}

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 7, 8, 0, 0);
const stamp = (minutes: number): string => new Date(T0 + minutes * MIN).toISOString();
const entry = (type: "user" | "assistant", minutes: number, content: unknown): string => `${JSON.stringify({
	type, timestamp: stamp(minutes), entrypoint: "cli", sessionId, isSidechain: false,
	...(type === "user" ? { origin: { kind: "human" }, promptSource: "typed" } : {}), message: { role: type, content },
})}\n`;

describe("Claude Code session.activity through the SessionEnd hook", () => {
	it("stores one session.activity event for the session and none on a second session end", async () => {
		const repository = join(root, "repo");
		mkdirSync(repository);
		execFileSync("git", ["init", "-q", repository]);
		const transcriptPath = join(root, `${sessionId}.jsonl`);
		// The person types at minute 0; a Reach ring arrives at minute 10; after a 20-minute pause the agent works on until minute 40.
		const ring = "REACH-RING Guide: /g. Seat: hand.x@gpt1. 354e30cd typed by the mail transport, not by the owner. Read Message-ID <a@b> now.";
		writeFileSync(transcriptPath, entry("user", 0, "first") + entry("assistant", 4, "ok") + entry("user", 10, ring)
			+ entry("assistant", 12, "ok") + entry("assistant", 32, "ok") + entry("assistant", 40, "ok"));
		const end = (): void => {
			const run = spawnSync(process.execPath, [claudeCli, "session-end"], {
				encoding: "utf8", timeout: 60_000, env,
				input: JSON.stringify({ session_id: sessionId, cwd: repository, transcript_path: transcriptPath }),
			});
			expect(run.status, `session-end: ${run.stderr}`).toBe(0);
		};

		end();
		await settleAfterSessionEnd(1);
		const expected = { harness: "claude-code", window_start_ms: T0, window_end_ms: T0 + 40 * MIN,
			// 0-4, 4-10, 10-12 and 32-40 minutes count; the 20-minute gap does not.
			active_ms: 20 * MIN,
			// Everything after the ring: 10-12 and 32-40 minutes.
			team_driven_ms: 10 * MIN, runs_over_12h: 0, longest_run_ms: 0, human_messages: 1 };
		const stored = buffered().filter(row => row.event_type === "session.activity");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.lane).toBe("memory");
		expect(stored[0]?.payload).toEqual(expected);
		expect(ledgerRows().filter(row => row.event_type === "session.activity")).toHaveLength(1);

		end();
		await settleAfterSessionEnd(2);
		expect(buffered().filter(row => row.event_type === "session.activity")).toHaveLength(1);
		expect(ledgerRows().filter(row => row.event_type === "session.activity")).toHaveLength(1);
	}, 240_000);
});
