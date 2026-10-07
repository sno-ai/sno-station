/**
 * A Codex turn ends and its working time reaches the SDK's buffer: the built Stop hook reads the
 * rollout file, appends one session.activity row to the observe ledger, and the session-end hook's
 * sidecar call validates it with the SDK schema and stores it in `<profile>/buffer.db`. A second Stop
 * over the same rollout adds nothing. The observe base URL is a closed loopback
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
const codexCli = join(repoRoot, "apps/mem-codex/dist/cli.js");

const sessionId = "01a1142e-d0b9-7622-b703-a6cb1a6ae323";
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
	root = mkdtempSync(join(tmpdir(), "mem-codex-activity-"));
	profile = join(root, "profile");
	mkdirSync(profile);
	writeSettingsFixture(profile, { mode: "local-first", rerank: { mode: "none" }, embedding: { cacheDir: MODEL_CACHE },
		capture: { ambient: false },
		telemetry: { observe: { enabled: true, baseUrl: await closedLoopbackUrl() } } });
	// The hooks, and the service started below, run in this environment; the store list lives under HOME.
	previousEnv = { SNO_PROFILE_DIR: process.env.SNO_PROFILE_DIR, HOME: process.env.HOME,
		SNO_STATION_MEM_NODE_ENV: process.env.SNO_STATION_MEM_NODE_ENV };
	process.env.SNO_PROFILE_DIR = profile;
	process.env.HOME = join(root, "home");
	process.env.SNO_STATION_MEM_NODE_ENV = "test";
	env = { ...process.env };
	// The hook's own cold start of the service can exceed its session-end deadline; start it first.
	const started = await connect({ skinId: "codex" });
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
const row = (type: string, minutes: number, payload: unknown): string => `${JSON.stringify({ timestamp: stamp(minutes), type, payload })}\n`;
const typed = (minutes: number, text: string): string => row("event_msg", minutes, {
	type: "item_completed", item: { type: "UserMessage", id: "u", content: [{ type: "text", text }] },
});
const work = (minutes: number): string => row("event_msg", minutes, { type: "token_count", info: null });

describe("Codex session.activity through the Stop hook", () => {
	it("stores one session.activity event for the turn and none on a second Stop", async () => {
		const repository = join(root, "repo");
		mkdirSync(repository);
		execFileSync("git", ["init", "-q", repository]);
		const codexHome = join(root, "codex");
		const directory = join(codexHome, "sessions", "2026", "10", "07");
		mkdirSync(directory, { recursive: true });
		// The person types at minute 0; a Reach ring arrives at minute 10; after a 20-minute pause the agent works on until minute 40.
		const ring = "REACH-RING Guide: /g. Seat: hand.x@gpt1. 354e30cd typed by the mail transport, not by the owner. Read Message-ID <a@b> now.";
		writeFileSync(join(directory, `rollout-2026-10-07T08-00-00-${sessionId}.jsonl`),
			row("session_meta", 0, { id: sessionId, source: "cli", originator: "codex-tui" }) + typed(0, "first") + work(4) + typed(10, ring)
			+ work(12) + work(32) + work(40));
		const hook = (command: string, input: Record<string, unknown>): void => {
			const run = spawnSync(process.execPath, [codexCli, command], {
				encoding: "utf8", timeout: 60_000, env: { ...env, CODEX_HOME: codexHome },
				input: JSON.stringify({ session_id: sessionId, cwd: repository, ...input }),
			});
			expect(run.status, `${command}: ${run.stderr}`).toBe(0);
		};
		const stop = (): void => hook("stop", { turn_id: "t1", last_assistant_message: "done" });

		stop();
		expect(ledgerRows().filter(r => r.event_type === "session.activity")).toHaveLength(1);
		// Stop does not reach the sidecar; the sidecar forwards the ledger when a session ends.
		hook("session-end", {});
		await settleAfterSessionEnd(1);
		const stored = buffered().filter(r => r.event_type === "session.activity");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.lane).toBe("memory");
		expect(stored[0]?.payload).toEqual({ harness: "codex", window_start_ms: T0, window_end_ms: T0 + 40 * MIN,
			// 0-4, 4-10, 10-12 and 32-40 minutes count; the 20-minute gap does not.
			active_ms: 20 * MIN,
			// Everything after the ring: 10-12 and 32-40 minutes.
			team_driven_ms: 10 * MIN, runs_over_12h: 0, longest_run_ms: 12 * MIN, human_messages: 1 });

		stop();
		expect(ledgerRows().filter(r => r.event_type === "session.activity")).toHaveLength(1);
	}, 240_000);
});
