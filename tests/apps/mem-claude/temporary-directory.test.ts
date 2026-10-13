/**
 * Scripts and tests run one-shot agent sessions; measured 2026-10-13, 616 of 785 queued Claude turns came from
 * temporary directories and 184 of 283 queued Codex turns from `codex exec`. The Claude Code and Codex hooks
 * must answer nothing and write nothing for such runs; each control shows the same hook acts on a conversation.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../..");
let temporary: string;
let lasting: string;
let profile: string;

beforeEach(() => {
	temporary = mkdtempSync(join(tmpdir(), "mem-temporary-workspace-"));
	mkdirSync(join(homedir(), ".cache"), { recursive: true });
	lasting = mkdtempSync(join(homedir(), ".cache", "mem-lasting-workspace-"));
	profile = join(lasting, "profile");
	writeSettingsFixture(profile, { recall: { auto: false }, memoryPackage: { path: join(lasting, "no-memory-package") } });
});
afterEach(() => {
	rmSync(temporary, { recursive: true, force: true });
	rmSync(lasting, { recursive: true, force: true });
});

function run(app: "mem-claude" | "mem-codex", event: string, input: unknown, extraEnv: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "apps", app, "src/cli.ts"), event], {
		cwd: repoRoot, input: JSON.stringify(input), encoding: "utf8", timeout: 20_000,
		env: { PATH: process.env.PATH ?? "", HOME: lasting, TMPDIR: tmpdir(), SNO_PROFILE_DIR: profile, ...extraEnv },
	});
	expect(result.status, result.stderr).toBe(0);
	return result.stdout;
}

const prompts = {
	"mem-claude": (cwd: string) => ({ session_id: "5b0e6c1e-8f0a-4d7e-9a51-3c2b7e9d4f10", cwd, prompt_id: "p1", prompt: "Remember tabs." }),
	"mem-codex": (cwd: string) => ({ session_id: "5b0e6c1e-8f0a-4d7e-9a51-3c2b7e9d4f10", cwd, turn_id: "t1", prompt: "Remember tabs." }),
};
const sessions = (app: string) => join(profile, `sno-${app}`, "sessions");

describe.each(["mem-claude", "mem-codex"] as const)("%s hooks in a temporary directory", (app) => {
	it("answer nothing and write no session state", () => {
		const workspace = join(temporary, "scripted-run");
		mkdirSync(workspace);
		expect(run(app, "user-prompt-submit", prompts[app](workspace))).toBe("");
		expect(existsSync(sessions(app))).toBe(false);
	});

	it("control: the same hook records a workspace outside the temporary directory", () => {
		const workspace = join(lasting, "billing-service");
		mkdirSync(workspace);
		expect(JSON.parse(run(app, "user-prompt-submit", prompts[app](workspace))).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
		expect(existsSync(sessions(app))).toBe(true);
	});
});

describe("scripted agent runs outside the temporary directory", () => {
	// Measured 2026-10-13: 184 of 283 queued Codex turns were one-turn `codex exec` runs writing commit messages.
	function codexTranscript(source: string): string {
		const path = join(lasting, `rollout-${source}.jsonl`);
		writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: "019a", originator: "codex_exec", source } })}\n`);
		return path;
	}

	it("mem-claude answers nothing for a `claude -p` run", () => {
		const workspace = join(lasting, "billing-service");
		mkdirSync(workspace);
		expect(run("mem-claude", "user-prompt-submit", prompts["mem-claude"](workspace), { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" })).toBe("");
		expect(existsSync(sessions("mem-claude"))).toBe(false);
	});

	it("mem-claude does not record a background task notification as the user's prompt", () => {
		const workspace = join(lasting, "billing-service");
		mkdirSync(workspace);
		const notification = { ...prompts["mem-claude"](workspace), prompt: "<task-notification> <task-id>b3j8</task-id> <status>completed</status>" };
		expect(run("mem-claude", "user-prompt-submit", notification, { CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("");
		expect(existsSync(sessions("mem-claude"))).toBe(false);
	});

	it("mem-codex answers nothing for a `codex exec` run", () => {
		const workspace = join(lasting, "billing-service");
		mkdirSync(workspace);
		const input = { ...prompts["mem-codex"](workspace), transcript_path: codexTranscript("exec") };
		expect(run("mem-codex", "user-prompt-submit", input)).toBe("");
		expect(existsSync(sessions("mem-codex"))).toBe(false);
	});

	it("mem-codex answers nothing for a `codex exec --ephemeral` run, which has no transcript", () => {
		const workspace = join(lasting, "billing-service");
		mkdirSync(workspace);
		expect(run("mem-codex", "user-prompt-submit", { ...prompts["mem-codex"](workspace), transcript_path: null })).toBe("");
		expect(existsSync(sessions("mem-codex"))).toBe(false);
	});

	it("SNO_CAPTURE_SCRIPTED=1 records scripted runs, for the real-agent release journeys", () => {
		const workspace = join(lasting, "billing-service");
		mkdirSync(workspace);
		const claude = run("mem-claude", "user-prompt-submit", prompts["mem-claude"](workspace), { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", SNO_CAPTURE_SCRIPTED: "1" });
		expect(JSON.parse(claude).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
		const codex = run("mem-codex", "user-prompt-submit", { ...prompts["mem-codex"](workspace), transcript_path: null }, { SNO_CAPTURE_SCRIPTED: "1" });
		expect(JSON.parse(codex).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
	});

	it("control: mem-codex records an interactive session", () => {
		const workspace = join(lasting, "billing-service");
		mkdirSync(workspace);
		const input = { ...prompts["mem-codex"](workspace), transcript_path: codexTranscript("cli") };
		expect(JSON.parse(run("mem-codex", "user-prompt-submit", input)).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
		expect(existsSync(sessions("mem-codex"))).toBe(true);
	});
});
