/**
 * The built hook command run the way Cursor runs it: Cursor-shaped JSON on stdin (field sets taken from the
 * IDE 3.24.9 and CLI 2026.10.01 hook logs in the PRD evidence), the surface told apart only by the environment.
 * Recall is off and the memory package path points nowhere, so no sidecar starts; what is checked is what the
 * hooks answer, the shared conversation record, and the capture spool they leave for the worker.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../..");
const CLI = join(repoRoot, "apps/mem-cursor/dist/cli.js");
const IDE_ENV = { CURSOR_VERSION: "3.24.9", CURSOR_EXTENSION_HOST_ROLE: "user" };
const CLI_ENV = { CURSOR_VERSION: "2026.10.01-e373342", CURSOR_INVOKED_AS: "cursor-agent" };

let root: string;
let profile: string;
let repo: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mem-cursor-hooks-"));
	profile = join(root, "profile");
	repo = join(root, "billing-service");
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	repo = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	writeSettingsFixture(profile, { recall: { auto: false }, memoryPackage: { path: join(root, "no-memory-package") } });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function hook(event: string, input: unknown, env: Record<string, string>): { stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [CLI, event], {
		input: typeof input === "string" ? input : JSON.stringify(input),
		encoding: "utf8",
		timeout: 20_000,
		env: { PATH: process.env.PATH ?? "", HOME: root, SNO_PROFILE_DIR: profile, ...env },
	});
	expect(result.status, result.stderr).toBe(0);
	return { stdout: result.stdout.trim(), stderr: result.stderr };
}

function base(conversation: string, generation: string, model: string, cursorVersion: string, roots = [repo]) {
	return { conversation_id: conversation, session_id: conversation, generation_id: generation, model,
		cursor_version: cursorVersion, workspace_roots: roots, user_email: "dev@example.com", transcript_path: null };
}

const record = (id: string) => JSON.parse(readFileSync(join(profile, "cursor", "conversations", `${id}.json`), "utf8"));
const spool = (): Array<Record<string, unknown>> => {
	const directory = join(profile, "sno-mem-cursor", "spool");
	return existsSync(directory) ? readdirSync(directory).sort().map(name => JSON.parse(readFileSync(join(directory, name), "utf8"))) : [];
};

describe("IDE hooks", () => {
	const id = "11111111-2222-4333-8444-555555555555";
	const generation = "473a9b98-f2ad-412a-8317-490191f19b8e";
	const transcript = "/Users/dev/.cursor/projects/billing-service/agent-transcripts/x/x.jsonl";

	it("pairs the prompt and reply of a completed turn by generation_id and answers Cursor JSON", () => {
		const ide = (generationId: string) => base(id, generationId, "cursor-grok-4.6-medium", "3.24.9");
		expect(hook("session-start", { ...ide(""), is_background_agent: false, composer_mode: "agent", hook_event_name: "sessionStart" }, IDE_ENV).stdout).toBe("{}");
		expect(hook("user-prompt-submit", { ...ide(generation), composer_mode: "agent", attachments: [], hook_event_name: "beforeSubmitPrompt",
			prompt: "From now on invoices are rounded half-even." }, IDE_ENV).stdout).toBe("{}");
		hook("after-agent-thought", { ...ide(generation), text: "Checking rounding.", duration_ms: 2579, hook_event_name: "afterAgentThought" }, IDE_ENV);
		hook("after-agent-response", { ...ide(generation), text: "Done: invoices now round half-even.", input_tokens: 48196, hook_event_name: "afterAgentResponse", transcript_path: transcript }, IDE_ENV);
		// A message queued for the next turn arrives before this turn's stop; pairing must follow generation_id.
		hook("user-prompt-submit", { ...ide("0b353f61-5d1e-4f5c-9a1e-3c2b1a0f9e8d"), prompt: "Next: update the changelog." }, IDE_ENV);
		expect(hook("stop", { ...ide(generation), status: "completed", loop_count: 0, hook_event_name: "stop", transcript_path: transcript }, IDE_ENV).stdout).toBe("{}");
		expect(spool()).toEqual([expect.objectContaining({ sessionId: id, turnId: generation, project: repo,
			user: "From now on invoices are rounded half-even.", assistant: "Done: invoices now round half-even.", state: "pending" })]);
		expect(record(id)).toMatchObject({ surface: "ide", project: repo, model: "cursor-grok-4.6-medium", transcript_path: transcript, ended_at: null });
	});

	it("captures nothing from a turn that ended in error", () => {
		const ide = base(id, generation, "cursor-grok-4.6-medium", "3.24.9");
		hook("user-prompt-submit", { ...ide, prompt: "Ship the release notes." }, IDE_ENV);
		hook("after-agent-response", { ...ide, text: "Partial reply before the error." }, IDE_ENV);
		hook("stop", { ...ide, status: "error", loop_count: 0 }, IDE_ENV);
		expect(spool()).toEqual([]);
	});

	it("with capture off, spools nothing and keeps no finished turn text", () => {
		writeSettingsFixture(profile, { recall: { auto: false }, capture: { ambient: false }, memoryPackage: { path: join(root, "no-memory-package") } });
		const ide = base(id, generation, "cursor-grok-4.6-medium", "3.24.9");
		hook("user-prompt-submit", { ...ide, prompt: "Ship the release notes." }, IDE_ENV);
		hook("after-agent-response", { ...ide, text: "Shipped." }, IDE_ENV);
		hook("stop", { ...ide, status: "completed", loop_count: 0 }, IDE_ENV);
		expect(spool()).toEqual([]);
		const state = JSON.parse(readFileSync(join(profile, "sno-mem-cursor", "sessions", `${id}.json`), "utf8"));
		expect([state.prompts, state.replies]).toEqual([{}, {}]);
	});

	it("does nothing for a conversation that never had sessionStart or beforeSubmitPrompt (a subagent)", () => {
		const subagent = base("0b353f61-aaaa-4bbb-8ccc-dddddddddddd", generation, "grok-4.6", "3.24.9");
		expect(hook("after-agent-response", { ...subagent, text: "subagent reply" }, IDE_ENV).stdout).toBe("{}");
		expect(hook("stop", { ...subagent, status: "completed", loop_count: 0 }, IDE_ENV).stdout).toBe("{}");
		expect(existsSync(join(profile, "cursor", "conversations", `${subagent.conversation_id}.json`))).toBe(false);
		expect(spool()).toEqual([]);
	});

	it("records but never captures a conversation outside a git repository", () => {
		const plain = join(root, "plain");
		mkdirSync(plain);
		const ide = base(id, generation, "cursor-grok-4.6-medium", "3.24.9", [plain]);
		hook("user-prompt-submit", { ...ide, prompt: "Remember the deploy window is Tuesday." }, IDE_ENV);
		hook("after-agent-response", { ...ide, text: "Noted." }, IDE_ENV);
		const { stderr } = hook("stop", { ...ide, status: "completed", loop_count: 0 }, IDE_ENV);
		expect(record(id).project).toBeNull();
		expect(stderr).toContain("no-git-root");
		expect(spool()).toEqual([]);
	});

	it("never captures a Reach keep-alive turn or counts it as working time", () => {
		const ide = (generationId: string) => base(id, generationId, "cursor-grok-4.6-medium", "3.24.9");
		const keepAlive = "keepalive-0001";
		expect(hook("user-prompt-submit", { ...ide(keepAlive), prompt: "[Sno Reach keep-alive]\nAnswer with one word and stop." }, IDE_ENV).stdout).toBe("{}");
		hook("after-agent-response", { ...ide(keepAlive), text: "ok" }, IDE_ENV);
		hook("stop", { ...ide(keepAlive), status: "completed", loop_count: 0 }, IDE_ENV);
		expect(spool()).toEqual([]);
		expect(existsSync(join(profile, "observe", "ledger.jsonl"))).toBe(false);
		// Control: an ordinary turn in the same conversation is captured and counted.
		hook("user-prompt-submit", { ...ide(generation), prompt: "Keep invoices in cents." }, IDE_ENV);
		hook("after-agent-response", { ...ide(generation), text: "Done." }, IDE_ENV);
		hook("stop", { ...ide(generation), status: "completed", loop_count: 0 }, IDE_ENV);
		expect(spool().map(turn => turn.user)).toEqual(["Keep invoices in cents."]);
		const rows = readFileSync(join(profile, "observe", "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(rows.map(row => row.payload.human_messages)).toEqual([1]);
	});

	it("answers {} to unreadable input", () => {
		expect(hook("user-prompt-submit", "{not json", IDE_ENV).stdout).toBe("{}");
		expect(hook("stop", { generation_id: generation }, IDE_ENV).stdout).toBe("{}");
	});
});

describe("CLI hooks", () => {
	const id = "a6898c09-a207-45da-97bb-b549e3cee246";
	const user = (query: string) => JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `<timestamp>Friday, Oct 9, 2026, 4:38 AM (UTC)</timestamp>\n<user_query>\n${query}\n</user_query>` }] } });
	const reply = (text: string) => JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } });

	it("keeps the model Auto picked, captures complete transcript turns at stop and the rest at sessionEnd", () => {
		const transcript = join(root, "agent-transcripts", id, `${id}.jsonl`);
		mkdirSync(join(transcript, ".."), { recursive: true });
		const cli = (generation: string, model = "default") => base(id, generation, model, "2026.10.01-e373342");
		hook("session-start", { ...cli(id), is_background_agent: false, hook_event_name: "sessionStart" }, CLI_ENV);
		hook("user-prompt-submit", { ...cli("778de69f"), prompt: "Use pnpm here.", attachments: [] }, CLI_ENV);
		hook("after-agent-thought", { ...cli("778de69f", "cursor-grok-4.5-high"), model_id: "grok-4.5", text: "thinking" }, CLI_ENV);
		hook("user-prompt-submit", { ...cli("12dc3e2b"), prompt: "And Node 24." }, CLI_ENV);
		expect(record(id)).toMatchObject({ surface: "cli", model: "cursor-grok-4.5-high" });
		writeFileSync(transcript, `${[user("Use pnpm here."), reply("pnpm it is."), JSON.stringify({ type: "turn_ended", status: "success" }),
			user("[Sno Reach keep-alive]\nAnswer with the single word idle and end your turn."), reply("idle"), JSON.stringify({ type: "turn_ended", status: "success" }),
			user("And Node 24."), reply("Pinned Node 24 in .nvmrc.")].join("\n")}\n`);
		hook("stop", { ...cli("12dc3e2b"), status: "completed", loop_count: 0, transcript_path: transcript }, CLI_ENV);
		expect(spool().map(turn => [turn.turnId, turn.user, turn.assistant])).toEqual([["u1", "Use pnpm here.", "pnpm it is."]]);
		hook("session-end", { ...cli(id), reason: "completed", final_status: "completed", transcript_path: transcript }, CLI_ENV);
		expect(spool().map(turn => [turn.turnId, turn.user, turn.assistant])).toEqual([
			["u1", "Use pnpm here.", "pnpm it is."], ["u3", "And Node 24.", "Pinned Node 24 in .nvmrc."]]);
		expect(record(id).ended_at).not.toBeNull();
		// Working time comes from our own hook times: one row at stop, one closing row at sessionEnd.
		const rows = readFileSync(join(profile, "observe", "ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
			.filter(row => row.event_type === "session.activity");
		expect(rows.map(row => [row.agent_id, row.payload.harness])).toEqual([["cursor", "cursor"], ["cursor", "cursor"]]);
		expect(rows.reduce((sum, row) => sum + row.payload.human_messages, 0)).toBe(2);
		expect(rows.reduce((sum, row) => sum + row.payload.active_ms, 0)).toBeGreaterThan(0);
	});
});
