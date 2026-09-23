/**
 * QCG-2 (REQ-3, REQ-10, REQ-11): a Claude Code session in a git checkout ends, and its skill runs
 * — a typed slash command with its own Skill call, a typed slash command alone, and a built-in
 * command — land in `<profile>/buffer.db` through the real built hook CLI and the real sidecar,
 * each carrying the checkout's project id. The observe base URL is a closed loopback port, so the
 * proof reads buffer.db before any successful flush. Transcript lines follow the shapes Claude
 * Code writes (a typed command is a user entry whose content string holds `<command-name>`).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const memoryCli = join(repoRoot, "packages/memory/dist/cli.js");
const claudeCli = join(repoRoot, "apps/mem-claude/dist/cli.js");
const sessionId = "7c1e2f40-5b8a-4d3e-9f21-0a6b3c9d8e71";
const PROJECT = `p_${createHash("sha256").update("github.com/example/project").digest("hex").slice(0, 16)}`;

type Envelope = { event_type: string; scope: { project_id?: string }; payload: Record<string, unknown> };

let root: string;
let profile: string;
let checkout: string;
let transcript: string;
let env: NodeJS.ProcessEnv;

async function closedLoopbackUrl(): Promise<string> {
	const server = createServer();
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no loopback port");
	await new Promise<void>(done => server.close(() => done()));
	return `http://127.0.0.1:${address.port}`;
}

function entry(type: "user" | "assistant", timestamp: string, message: Record<string, unknown>): string {
	return JSON.stringify({ type, timestamp, sessionId, cwd: checkout, uuid: `${type}-${timestamp}`, message });
}

const typed = (name: string) =>
	`<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args></command-args>`;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "observe-v2-collection-project-"));
	profile = join(root, "profile");
	checkout = join(root, "checkout");
	const configDir = join(root, "claude");
	mkdirSync(profile);
	mkdirSync(checkout);
	execFileSync("git", ["init", "-q", checkout]);
	execFileSync("git", ["-C", checkout, "remote", "add", "origin", "git@github.com:example/project.git"]);
	for (const name of ["prd-creator", "peer-review"]) {
		mkdirSync(join(configDir, "skills", name), { recursive: true });
		writeFileSync(join(configDir, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
	}
	transcript = join(root, `${sessionId}.jsonl`);
	writeFileSync(transcript, `${[
		entry("user", "2026-09-23T08:00:00.000Z", { role: "user", content: typed("prd-creator") }),
		entry("assistant", "2026-09-23T08:00:02.000Z", { role: "assistant", content: [
			{ type: "tool_use", id: "toolu_prd", name: "Skill", input: { skill: "prd-creator" } }] }),
		entry("user", "2026-09-23T08:00:03.000Z", { role: "user", content: [
			{ type: "tool_result", tool_use_id: "toolu_prd", content: "Launching skill: prd-creator" }] }),
		entry("user", "2026-09-23T08:05:00.000Z", { role: "user", content: typed("peer-review") }),
		entry("assistant", "2026-09-23T08:05:05.000Z", { role: "assistant", content: [{ type: "text", text: "Reviewed." }] }),
		entry("user", "2026-09-23T08:06:00.000Z", { role: "user", content: typed("clear") }),
		entry("assistant", "2026-09-23T08:06:01.000Z", { role: "assistant", content: [{ type: "text", text: "Done." }] }),
	].join("\n")}\n`);
	env = {
		...process.env,
		CLAUDE_CONFIG_DIR: configDir,
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

const snapshots = () => envelopes().filter(e => e.event_type === "memory.snapshot" && e.payload.snapshot_reason === "session_end").length;

async function sessionEnd(expectedSnapshots: number): Promise<void> {
	const run = spawnSync(process.execPath, [claudeCli, "session-end"], {
		encoding: "utf8", timeout: 60_000, env,
		input: JSON.stringify({ session_id: sessionId, cwd: checkout, transcript_path: transcript }),
	});
	expect(run.status, `session-end: ${run.stderr}`).toBe(0);
	for (let waited = 0; waited < 30_000 && snapshots() < expectedSnapshots; waited += 250) await delay(250);
	expect(snapshots(), "the sidecar never ran onSessionEnd for this hook call").toBeGreaterThanOrEqual(expectedSnapshots);
	let last = -1;
	for (let stable = 0, waited = 0; stable < 6 && waited < 30_000; waited += 250) {
		await delay(250);
		const now = envelopes().length;
		stable = now === last ? stable + 1 : 0;
		last = now;
	}
}

const skillRuns = () => envelopes().filter(e => e.event_type === "skill.run")
	.map(e => [e.payload.skill_name, e.scope.project_id]);

describe("skill runs of a Claude Code session carry the checkout's project", () => {
	it("records each typed skill once with the project, skips /clear, and never repeats", async () => {
		await sessionEnd(1);
		expect(skillRuns()).toEqual([["prd-creator", PROJECT], ["peer-review", PROJECT]]);
		await sessionEnd(2);
		expect(skillRuns()).toEqual([["prd-creator", PROJECT], ["peer-review", PROJECT]]);
	}, 240_000);
});
