/**
 * Local First PRD REQ-6: a session boundary ("reset") sent by a coding host makes the memory side
 * write the reflection of the PREVIOUS session, read in that host's own format — the Codex
 * session log, the Claude Code transcript, or the messages sent with the boundary (Hermes).
 * Real contract path (MemoryRuntimePool → MemoryContractRuntime.onSessionEnd), real SQLite,
 * reflection turned on through explicit registration settings, mode local-first so R1 is off
 * and the template fallback body is written. The OpenClaw session file is the positive control.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema";
import { bindStore } from "../../../../packages/memory/src/engine/shared/paths";
import { MemoryRuntimePool } from "../../../../packages/memory/src/sidecar/memory-runtime";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const CODEX_ROLLOUT = join(repoRoot, "tests/apps/mem-codex/fixtures/rollout-2026-09-22T05-51-48-01a0c7ab-9f72-7380-b1ba-ef29c7756de7.jsonl");
const CODEX_OLD_SESSION = "01a0c7ab-9f72-7380-b1ba-ef29c7756de7";
const CLAUDE_TRANSCRIPT = join(repoRoot, "tests/apps/mem-claude/fixtures/transcript-7c1e4b52-3a9d-4f0e-9b6a-2d8f1c5e7a93.jsonl");
const CLAUDE_OLD_SESSION = "7c1e4b52-3a9d-4f0e-9b6a-2d8f1c5e7a93";
const FALLBACK_MARKER = "(fallback) Reflection generation failed; storing minimal pointer only.";
const BOUNDARY_AT = Date.parse("2026-09-26T10:00:00.000Z");

let root: string;
let workspace: string;
let database: ReturnType<typeof createTestDb>;
let pool: MemoryRuntimePool | undefined;
const previousProfile = process.env.SNO_PROFILE_DIR;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "session-boundary-reflection-"));
	workspace = join(root, "workspace");
	mkdirSync(workspace);
	database = createTestDb();
	process.env.SNO_PROFILE_DIR = root;
	await bindStore(database.dbPath, { mode: "local-first", retrieval: { rerank: "none" } });
	mkdirSync(join(root, "sno-station-mem"), { recursive: true });
	pool = await MemoryRuntimePool.open();
	const config = pluginConfigSchema.parse({ ...pool.config, mode: "local-first", sessionStrategy: "memoryReflection" });
	const { mode, remEnhanced: _remEnhanced, language: _language, ...settings } = config;
	await pool.invoke("init", { scope: scope("init-session"), registration: { skinId: "session-boundary",
		settings, routing: { mode, language: "en" } } }, "session-boundary");
});

afterEach(async () => {
	await pool?.close();
	pool = undefined;
	database.cleanup();
	rmSync(root, { recursive: true, force: true });
	if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousProfile;
});

function scope(sessionId: string, host: Record<string, unknown> = {}) {
	return { principal: "caller", project: workspace, session: sessionId, host: { sessionId, workspace, ...host } };
}

async function resetBoundary(sessionId: string, sessionFile: string | undefined, messages: unknown[] = [], skinId = "session-boundary"): Promise<void> {
	const host = { boundary: "reset", at: BOUNDARY_AT, ...(sessionFile === undefined ? {} : { sessionFile }) };
	expect(await pool?.invoke("onSessionEnd", { scope: scope(sessionId, host), messages }, skinId))
		.toEqual({ degraded: false, completed: true });
}

/** Every reflection file written under the workspace, as its text. */
function writtenReflections(): string[] {
	const base = join(workspace, "memory", "reflections");
	if (!existsSync(base)) return [];
	return readdirSync(base).flatMap(day => readdirSync(join(base, day)).map(file => readFileSync(join(base, day, file), "utf8")));
}

function expectOneReflectionOf(sessionId: string): void {
	const written = writtenReflections();
	expect(written).toHaveLength(1);
	expect(written[0]).toContain("# Reflection: 2026-09-26 10:00:00 UTC");
	expect(written[0]).toContain(`- Session ID: ${sessionId}\n`);
	expect(written[0]).toContain("- Command: reset\n");
	expect(written[0]).toContain(FALLBACK_MARKER);
}

describe("reflection of the previous session on a reset boundary (local-first, explicit memoryReflection)", () => {
	it("control: reads an OpenClaw session file and writes the previous session's reflection", async () => {
		const sessionFile = join(root, "openclaw-session.jsonl");
		writeFileSync(sessionFile, [
			{ type: "message", message: { role: "user", content: "Release branches are cut from main every Tuesday." } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Noted: Tuesday cuts from main." }] } },
		].map(line => JSON.stringify(line)).join("\n"));
		await resetBoundary("openclaw-old-session", sessionFile);
		expectOneReflectionOf("openclaw-old-session");
	});

	it("(a) reads a Codex session log (response_item lines) and writes the previous session's reflection", async () => {
		const sessionFile = join(root, "codex-home", "sessions", "2026", "09", "22", "rollout-2026-09-22T05-51-48-01a0c7ab-9f72-7380-b1ba-ef29c7756de7.jsonl");
		mkdirSync(join(sessionFile, ".."), { recursive: true });
		copyFileSync(CODEX_ROLLOUT, sessionFile);
		await resetBoundary(CODEX_OLD_SESSION, sessionFile);
		expectOneReflectionOf(CODEX_OLD_SESSION);
	});

	it("(b) reads a Claude Code transcript (type user|assistant lines) and writes the previous session's reflection", async () => {
		const sessionFile = join(root, "claude-projects", "-home-lh-code-billing-service", `${CLAUDE_OLD_SESSION}.jsonl`);
		mkdirSync(join(sessionFile, ".."), { recursive: true });
		copyFileSync(CLAUDE_TRANSCRIPT, sessionFile);
		await resetBoundary(CLAUDE_OLD_SESSION, sessionFile);
		expectOneReflectionOf(CLAUDE_OLD_SESSION);
	});

	it("(c) uses the messages sent with the boundary when the host has no session file", async () => {
		await resetBoundary("hermes-old-session", undefined, [
			{ role: "user", content: "Release branches for the billing service are cut from main every Tuesday.", at: BOUNDARY_AT - 60_000 },
			{ role: "assistant", content: "Noted: Tuesday release cuts come from main.", at: BOUNDARY_AT - 59_000 },
			{ role: "user", content: "And the changelog lives in docs/CHANGELOG.md.", at: BOUNDARY_AT - 30_000 },
			{ role: "assistant", content: "Understood, I will log release changes in docs/CHANGELOG.md.", at: BOUNDARY_AT - 29_000 },
		]);
		expectOneReflectionOf("hermes-old-session");
	});

	it("(d) Hermes skin: the reset reflection goes under the profile root's project folder, never the workspace", async () => {
		const config = pluginConfigSchema.parse({ ...pool?.config, mode: "local-first", sessionStrategy: "memoryReflection" });
		const { mode, remEnhanced: _remEnhanced, language: _language, ...settings } = config;
		await pool?.invoke("init", { scope: scope("hermes-init"), registration: { skinId: "hermes",
			settings, routing: { mode, language: "en" } } }, "hermes");
		// Exactly what sno-mem-hermes keeps on on_session_end and posts on the reset path: role, content, at (ms, float),
		// every role in system|developer|user|assistant|tool, with no session file on the boundary.
		await resetBoundary("hermes-profile-old-session", undefined, [
			{ role: "system", content: "You are Hermes, a helpful coding agent.", at: BOUNDARY_AT - 120_000.25 },
			{ role: "user", content: "Release branches for the billing service are cut from main every Tuesday.", at: BOUNDARY_AT - 60_000.5 },
			{ role: "assistant", content: "Noted: Tuesday release cuts come from main.", at: BOUNDARY_AT - 59_000.5 },
			{ role: "tool", content: "docs/CHANGELOG.md", at: BOUNDARY_AT - 45_000.5 },
			{ role: "user", content: "And the changelog lives in docs/CHANGELOG.md.", at: BOUNDARY_AT - 30_000.5 },
			{ role: "assistant", content: "Understood, I will log release changes in docs/CHANGELOG.md.", at: BOUNDARY_AT - 29_000.5 },
		], "hermes");
		// REQ-6: <profile>/memory/projects/<basename(workspace)>-<first 12 hex of sha256(workspace)>/memory/reflections/<date>/
		const project = `${basename(workspace)}-${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`;
		const base = join(root, "memory", "projects", project, "memory", "reflections");
		expect(existsSync(base)).toBe(true);
		const written = readdirSync(base).flatMap(day => readdirSync(join(base, day)).map(file => readFileSync(join(base, day, file), "utf8")));
		expect(written).toHaveLength(1);
		expect(written[0]).toContain("- Session ID: hermes-profile-old-session\n");
		expect(written[0]).toContain("- Command: reset\n");
		expect(existsSync(join(workspace, "memory"))).toBe(false);
	});
});

/** A loopback host model callback: keeps the user prompt of every call and answers with a fixed reflection. */
async function hostRecorder() {
	const prompts: string[] = [];
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
		prompts.push(body.messages.filter(message => message.role === "user").map(message => message.content).join("\n"));
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ model: "loopback-model", choices: [{ message: { role: "assistant", content: "Reflection body from the loopback host." } }],
			usage: { prompt_tokens: 1, completion_tokens: 1 } }));
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing recorder port");
	return { prompts, url: `http://127.0.0.1:${address.port}`, close: async () => {
		server.closeAllConnections();
		await new Promise<void>(done => server.close(() => done()));
	} };
}

describe("the reflection prompt carries the previous session's own conversation (agent-native, R1 on the host)", () => {
	let host: Awaited<ReturnType<typeof hostRecorder>>;
	beforeEach(async () => {
		host = await hostRecorder();
		const config = pluginConfigSchema.parse({ ...pool?.config, mode: "agent-native", sessionStrategy: "memoryReflection" });
		const { mode, remEnhanced: _remEnhanced, language: _language, ...settings } = config;
		await pool?.invoke("init", { scope: scope("reflection-host-init"), registration: { skinId: "reflection-host", settings,
			routing: { mode, language: "en" },
			model: { baseUrl: `${host.url}/host/v1/`, credential: "loopback-credential", model: "loopback-model" } } }, "reflection-host");
	});
	afterEach(async () => { await host.close(); });
	// Reflection debounces a session for 30 s process-wide, so these ids differ from the tests above.

	/** Everything the host was asked for R1 in this test, and the reflection written from its answer. */
	function r1Input(): { prompt: string; written: string[] } {
		return { prompt: host.prompts.join("\n"), written: writtenReflections() };
	}

	it("Codex session log: user and assistant messages reach R1; developer, reasoning and event lines do not", async () => {
		const sessionFile = join(root, "codex-home", "rollout-2026-09-22T05-51-48-01a0c7ab-9f72-7380-b1ba-ef29c7756de7.jsonl");
		mkdirSync(join(sessionFile, ".."), { recursive: true });
		copyFileSync(CODEX_ROLLOUT, sessionFile);
		await resetBoundary("codex-r1-old-session", sessionFile, [], "reflection-host");
		const { prompt, written } = r1Input();
		expect(host.prompts.length).toBeGreaterThan(0);
		// user (response_item, role user) and assistant (response_item, role assistant, output_text)
		expect(prompt).toContain("User focus: Diff deletes per-service checkRateLimit after valid internal key and service-id.");
		expect(prompt).toContain("Target: app/api/v1/internal/credits/middleware.ts");
		// developer message, reasoning item, session_meta base instructions, turn_context / event_msg fields
		expect(prompt).not.toContain("<multi_agent_role>");
		expect(prompt).not.toContain("gAAAAABqsheA2CdYvrIsPJBX5WAdXWd3r4f0");
		expect(prompt).not.toContain("You are Codex, an agent based on GPT-6");
		expect(prompt).not.toContain("model_context_window");
		expect(written).toHaveLength(1);
		expect(written[0]).toContain("Reflection body from the loopback host.");
	});

	it("Claude Code transcript: user and assistant text reach R1; thinking, tool plumbing and meta lines do not", async () => {
		const sessionFile = join(root, "claude-projects", `${CLAUDE_OLD_SESSION}.jsonl`);
		mkdirSync(join(sessionFile, ".."), { recursive: true });
		copyFileSync(CLAUDE_TRANSCRIPT, sessionFile);
		await resetBoundary("claude-r1-old-session", sessionFile, [], "reflection-host");
		const { prompt, written } = r1Input();
		expect(host.prompts.length).toBeGreaterThan(0);
		expect(prompt).toContain("Release branches for the billing service are cut from main every Tuesday, and the changelog lives in docs/CHANGELOG.md. Which branch am I on right now?");
		expect(prompt).toContain("Noted: release cuts come from main on Tuesdays and the changelog is docs/CHANGELOG.md.");
		expect(prompt).toContain("You are on main, so Tuesday's billing release branch can be cut from here.");
		// tool_use input, tool_use id / tool_result, thinking signature, system turn_duration, attachment
		expect(prompt).not.toContain("git branch --show-current");
		expect(prompt).not.toContain("toolu_01Hc7XkPq2Lw9Rt4Vb6Nm3Zs");
		expect(prompt).not.toContain("EqQBCkYIBhgCKkBxs2Lr");
		expect(prompt).not.toContain("turn_duration");
		expect(prompt).not.toContain("output_style");
		expect(written).toHaveLength(1);
		expect(written[0]).toContain("Reflection body from the loopback host.");
	});

	it("Hermes boundary messages: user and assistant turns reach R1; system and tool messages do not", async () => {
		await resetBoundary("hermes-r1-old-session", undefined, [
			{ role: "system", content: "You are Hermes, a helpful coding agent.", at: BOUNDARY_AT - 120_000.25 },
			{ role: "user", content: "Release branches for the billing service are cut from main every Tuesday.", at: BOUNDARY_AT - 60_000.5 },
			{ role: "assistant", content: "Noted: Tuesday release cuts come from main.", at: BOUNDARY_AT - 59_000.5 },
			{ role: "tool", content: "grep: 2 matches in scripts/release.sh", at: BOUNDARY_AT - 45_000.5 },
			{ role: "user", content: "And the changelog lives in docs/CHANGELOG.md.", at: BOUNDARY_AT - 30_000.5 },
		], "reflection-host");
		const { prompt, written } = r1Input();
		expect(host.prompts.length).toBeGreaterThan(0);
		expect(prompt).toContain("Release branches for the billing service are cut from main every Tuesday.");
		expect(prompt).toContain("Noted: Tuesday release cuts come from main.");
		expect(prompt).toContain("And the changelog lives in docs/CHANGELOG.md.");
		expect(prompt).not.toContain("You are Hermes, a helpful coding agent.");
		expect(prompt).not.toContain("grep: 2 matches in scripts/release.sh");
		expect(written).toHaveLength(1);
		expect(written[0]).toContain("Reflection body from the loopback host.");
	});
});
