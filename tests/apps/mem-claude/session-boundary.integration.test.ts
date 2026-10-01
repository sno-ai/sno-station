/**
 * Local First PRD REQ-6, Claude Code: `/clear` fires SessionEnd with `reason: "clear"` and the
 * OLD session's own `session_id` / `transcript_path`. mem-claude must send `host.boundary:
 * "reset"` for that session, and with reflection turned on (settings.json `capture.sessionStrategy`)
 * the reflection of that session is written from its Claude transcript.
 * Real hook source, real in-process sidecar from source, real SQLite; mode local-first, so the
 * reflection body is the template fallback. The first case is the harness's positive control.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { connect, type MemoryClient } from "../../../packages/memory/src/contract/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionEnd, sessionStart } from "../../../apps/mem-claude/src/hooks.js";
import { readSession } from "../../../apps/mem-claude/src/session-state.js";
import { startRemSidecar } from "../../../packages/memory/src/sidecar/server";
import { createTestDb } from "../mem-claw/helpers/test-db";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../..");
// The machine's own model cache (read from the account, not HOME): no per-test model download.
const MODEL_CACHE = join(userInfo().homedir, ".cache", "sno-station", "models");
const OLD_SESSION = "7c1e4b52-3a9d-4f0e-9b6a-2d8f1c5e7a93";
const TRANSCRIPT_FIXTURE = join(repoRoot, "tests/apps/mem-claude/fixtures", `transcript-${OLD_SESSION}.jsonl`);
const FALLBACK_MARKER = "(fallback) Reflection generation failed; storing minimal pointer only.";

let root: string;
let workspace: string;
let database: ReturnType<typeof createTestDb>;
let sidecar: Awaited<ReturnType<typeof startRemSidecar>> | undefined;
let client: MemoryClient;
const previousProfile = process.env.SNO_PROFILE_DIR;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "mem-claude-boundary-"));
	// A workspace outside any git repository, so workspaceRoot() keeps it as the project path.
	workspace = join(root, "billing-service");
	mkdirSync(workspace);
	database = createTestDb();
	process.env.SNO_PROFILE_DIR = root;
	writeSettingsFixture(root, { mode: "local-first", rerank: { mode: "none" }, capture: { sessionStrategy: "memoryReflection" },
		store: { path: database.dbPath, encryptionKey: database.encryptionKey }, embedding: { cacheDir: MODEL_CACHE } });
	mkdirSync(join(root, "sno-station-mem"), { recursive: true });
	sidecar = await startRemSidecar();
	const connected = await connect({ skinId: "claude-code" });
	if (connected.degraded) throw new Error(connected.reason);
	client = connected;
	await client.init({ principal: "caller", project: workspace, session: "init", host: { workspace } }, { skinId: "claude-code" });
});

afterEach(async () => {
	await sidecar?.stop();
	sidecar = undefined;
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

/** REQ-6: a coding skin's reflection goes under the profile root, one folder per project
 * (`memory/projects/<workspace name>-<first 12 hex of sha256(workspace)>`), never the repository. */
function writtenReflections(): string[] {
	const project = `${basename(workspace)}-${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
	const base = join(root, "memory", "projects", project, "memory", "reflections");
	if (!existsSync(base)) return [];
	return readdirSync(base).flatMap(day => readdirSync(join(base, day)).map(file => readFileSync(join(base, day, file), "utf8")));
}

async function expectOneReflectionOf(sessionId: string): Promise<void> {
	// A correct hook may hand reflection off to the sidecar and return before the file is written.
	await vi.waitFor(() => expect(writtenReflections()).toHaveLength(1), { timeout: 15_000, interval: 200 });
	const [written] = writtenReflections();
	expect(written).toContain(`- Session ID: ${sessionId}\n`);
	expect(written).toContain("- Command: reset\n");
	expect(written).toContain(FALLBACK_MARKER);
	expect(existsSync(join(workspace, "memory"))).toBe(false);
}

describe("mem-claude SessionEnd reason clear", () => {
	it("reports why the previous session could not end during a degraded startup", async () => {
		const transcript = join(root, "prior-transcript.jsonl");
		writeFileSync(transcript, "");
		await sessionStart({ session_id: "degraded-previous", cwd: workspace, source: "startup", transcript_path: transcript });
		await sidecar?.stop();
		sidecar = undefined;
		const settingsPath = join(root, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		settings.recall.sessionStart.timeoutMs = 300;
		settings.memoryPackage.path = join(root, "unavailable-memory-package");
		writeFileSync(settingsPath, JSON.stringify(settings));
		const result = spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "apps/mem-claude/src/cli.ts"), "session-start"], {
			cwd: repoRoot, env: process.env, encoding: "utf8", timeout: 10_000,
			input: JSON.stringify({ session_id: "degraded-next", cwd: workspace, source: "startup", transcript_path: transcript }),
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe("");
		const observable = result.stderr.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
		expect(observable.some(event => event.event === "session-boundary" && typeof event.reason === "string" && event.reason.length > 0), result.stderr).toBe(true);
	});
	it("control: this sidecar and registration write a reflection for a reset boundary the engine can read", async () => {
		const sessionFile = join(root, "openclaw-session.jsonl");
		writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: "Release cuts come from main on Tuesdays." } }));
		await client.onSessionEnd([], { principal: "caller", project: workspace, session: "control-old",
			host: { sessionId: "control-old", workspace, sessionFile, boundary: "reset", at: Date.now() } });
		await expectOneReflectionOf("control-old");
	});

	it("sends boundary reset for the ended session and its reflection is written from the Claude transcript", async () => {
		const transcriptPath = join(root, ".claude", "projects", "-tmp-billing-service", `${OLD_SESSION}.jsonl`);
		mkdirSync(join(transcriptPath, ".."), { recursive: true });
		copyFileSync(TRANSCRIPT_FIXTURE, transcriptPath);
		// Claude Code 2.1.283 SessionEnd payload for /clear (= /reset, /new): the OLD session's own identity.
		await sessionEnd({
			session_id: OLD_SESSION,
			transcript_path: transcriptPath,
			cwd: workspace,
			permission_mode: "default",
			hook_event_name: "SessionEnd",
			reason: "clear",
		});
		// The hook reached the sidecar and was answered (not a validation or connection failure).
		expect((await readSession(OLD_SESSION)).receipt.SessionEnd).toMatchObject({ invocations: 1, degraded: {} });
		await expectOneReflectionOf(OLD_SESSION);
	});
});
