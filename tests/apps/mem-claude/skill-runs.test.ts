/**
 * QCG-8: a Claude Code session that invoked skills ends, and its skill runs are counted from the
 * transcript by the skin's session-end hook, written to the observe ledger, and uploaded by the
 * sidecar into `<profile>/buffer.db`. Real built hook CLI, real sidecar, a real transcript
 * trimmed to its Skill tool_use lines, their tool_results, and its first and last lines. The
 * observe base URL is a closed loopback port, so nothing leaves the machine.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const sessionId = "46731ba4-4166-4125-8e04-5a3d541c1db3";
const transcript = join(import.meta.dirname, "fixtures", `skill-runs-${sessionId}.jsonl`);

// Measured with jq on the transcript: Skill tool_use lines in order, the gap to the next Skill
// line (the last one to the transcript's last timestamp, 2026-08-16T06:54:28.006Z), and the
// matching tool_result's is_error (true on the 6th and the 8th).
const EXPECTED: [string, number, "ok" | "fail"][] = [
	["aslc-start", 20834763, "ok"],
	["aslc-radar-screen", 705889, "ok"],
	["codex-reviewer", 783088430, "ok"],
	["codex-reviewer", 152991646, "ok"],
	["codex-reviewer", 1942509, "ok"],
	["prd-creator-mid", 318934, "fail"],
	["adlc-build", 48522, "ok"],
	["prd-creator", 561673, "fail"],
	["openspec-new-change", 6024838, "ok"],
	["ts-coder", 388511, "ok"],
	["python-coder", 4216917, "ok"],
	["ts-coder", 3694535, "ok"],
];
// Direct units of sno-skills/registry.yaml, and names that appear nowhere in it.
const CATEGORY: Record<string, string> = {
	"aslc-start": "other", "aslc-radar-screen": "other", "codex-reviewer": "other", "openspec-new-change": "other",
	"prd-creator": "T", "ts-coder": "M", "python-coder": "M",
};

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

function sessionEnd(cwd: string): void {
	const run = spawnSync(process.execPath, [claudeCli, "session-end"], {
		encoding: "utf8", timeout: 60_000, env,
		input: JSON.stringify({ session_id: sessionId, cwd, transcript_path: transcript }),
	});
	expect(run.status, `session-end: ${run.stderr}`).toBe(0);
}

function expectTwelveSkillRuns(rows: Row[]): void {
	const runs = rows.filter(row => row.event_type === "skill.run");
	expect(runs.map(row => [row.payload.skill_name, row.payload.duration_ms, row.payload.outcome])).toEqual(EXPECTED);
	for (const run of runs) {
		expect(run.lane).toBe("skill");
		expect(run.payload.harness).toBe("claude-code");
		expect(run.payload.skill_version).toMatch(/^([0-9a-f]{12}|local)$/);
		const name = String(run.payload.skill_name);
		expect(run.payload.category).toEqual(CATEGORY[name] ?? expect.stringMatching(/^(J|M|S|H|T|R|other)$/));
	}
}

function skillRunsReported(): unknown {
	const state = JSON.parse(readFileSync(join(profile, "sno-mem-claude", "sessions", `${sessionId}.json`), "utf8")) as Record<string, unknown>;
	return state.skillRunsReported;
}

describe("Claude Code skill runs counted from the session transcript", () => {
	it("uploads twelve skill.run rows on the first session end and none on the second", async () => {
		const repository = join(root, "repo");
		mkdirSync(repository);
		execFileSync("git", ["init", "-q", repository]);

		sessionEnd(repository);
		await settleAfterSessionEnd(1);
		expectTwelveSkillRuns(buffered());
		expect(skillRunsReported()).toBe(12);

		sessionEnd(repository);
		await settleAfterSessionEnd(2);
		expect(buffered().filter(row => row.event_type === "skill.run")).toHaveLength(12);
		expect(ledgerRows().filter(row => row.event_type === "skill.run")).toHaveLength(12);
		expect(skillRunsReported()).toBe(12);
	}, 240_000);

	it("counts the same twelve runs when the session's directory is not a git repository", async () => {
		const plain = join(root, "not-a-repo");
		mkdirSync(plain);

		sessionEnd(plain);
		expectTwelveSkillRuns(ledgerRows());
		expect(skillRunsReported()).toBe(12);
	}, 120_000);
});
