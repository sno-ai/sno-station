/**
 * The Cursor IDE runs Claude Code hooks with Cursor-shaped input (PRD §2, evidence ide-mac-2026-10-08). Sno's
 * Claude Code hooks must answer nothing and write nothing there; the control shows the same hook acts on Claude input.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const repoRoot = resolve(import.meta.dirname, "../../..");
let root: string;
let profile: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mem-claude-cursor-input-"));
	profile = join(root, "profile");
	mkdirSync(join(root, "repo"));
	writeSettingsFixture(profile, { recall: { auto: false }, memoryPackage: { path: join(root, "no-memory-package") } });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(event: string, input: unknown) {
	const result = spawnSync(process.execPath, ["--import", "tsx", join(repoRoot, "apps/mem-claude/src/cli.ts"), event], {
		cwd: repoRoot, input: JSON.stringify(input), encoding: "utf8", timeout: 20_000,
		env: { PATH: process.env.PATH ?? "", HOME: root, SNO_PROFILE_DIR: profile },
	});
	expect(result.status, result.stderr).toBe(0);
	return result.stdout;
}

const sessions = () => join(profile, "sno-mem-claude", "sessions");

describe("mem-claude hooks under the Cursor IDE", () => {
	it("answer nothing and write no session state for Cursor-shaped input", () => {
		const cursor = { conversation_id: "e1d3e85e-60ac-48c4-b5a2-38e7b41856f4", session_id: "e1d3e85e-60ac-48c4-b5a2-38e7b41856f4",
			generation_id: "573a4a0a-0bd5-4987-b3d8-a673de0c9c6a", model: "cursor-grok-4.6-medium", cursor_version: "3.23.23",
			workspace_roots: [join(root, "repo")], transcript_path: null, cwd: "" };
		expect(run("user-prompt-submit", { ...cursor, hook_event_name: "beforeSubmitPrompt", prompt: "Remember tabs." })).toBe("");
		expect(run("stop", { ...cursor, hook_event_name: "stop", status: "completed", loop_count: 0 })).toBe("");
		expect(run("post-tool-use", { ...cursor, hook_event_name: "postToolUse", tool_name: "Shell", tool_use_id: "e82c2d09", tool_input: {}, tool_output: "{}" })).toBe("");
		expect(existsSync(sessions())).toBe(false);
	});

	it("control: the same hook acts on Claude Code input", () => {
		const output = run("user-prompt-submit", { session_id: "7c1e4b52-3a9d-4f0e-9b6a-2d8f1c5e7a93", cwd: join(root, "repo"), prompt_id: "p1", prompt: "Remember tabs." });
		expect(JSON.parse(output).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
		expect(existsSync(join(sessions(), "7c1e4b52-3a9d-4f0e-9b6a-2d8f1c5e7a93.json"))).toBe(true);
	});
});
