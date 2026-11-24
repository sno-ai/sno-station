import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeContinuityContext } from "../../../../packages/memory/config/work-continuity";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "continuity-due-"));
	mkdirSync(join(root, "station", "handoff"), { recursive: true });
	writeFileSync(join(root, "station", "handoff", "due-session.md"), "## Next\nCheck the release report.\n");
	writeFileSync(join(root, "settings.json"), JSON.stringify({ recall: { sessionStart: { timeoutMs: 2000 } } }));
	const program = join(root, "sno");
	writeFileSync(program, `#!/bin/sh
cat >/dev/null
if [ "$*" = "heartbeat --due --problems" ]; then
  touch "$SNO_PROFILE_DIR/problems-read"
  case "$DUE_TEST_RESULT" in
    fail) echo 'due records unavailable' >&2; exit 7 ;;
    empty) exit 0 ;;
  esac
  printf '%s\n' 'Daily report: not started: login expired' 'Release check: unfinished: build failed'
fi
`, { mode: 0o700 });
	vi.stubEnv("SNO_PROFILE_DIR", root);
	vi.stubEnv("SNO_EXECUTABLE", program);
	vi.stubEnv("DUE_TEST_RESULT", "problems");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe.each(["claude", "codex"] as const)("%s timed-task session context", harness => {
	it("delivers problem lines and instructions for writing a timed task", async () => {
		const output = await composeContinuityContext(harness, "SessionStart",
			{ session_id: "due-session", cwd: root }, async () => "");
		const text = JSON.parse(output).hookSpecificOutput.additionalContext;
		expect(text).toContain("Timed tasks did not run as planned:\nDaily report: not started: login expired\nRelease check: unfinished: build failed");
		expect(text).toContain("## Due");
		expect(text).toContain("file edit tool");
		expect(text).toContain("at: YYYY-MM-DD HH:MM <IANA time zone>");
		expect(text).toContain("repeat: daily");
		expect(text).toContain("repeat: weekly");
		expect(text).toContain("do: <the action, one line>");
		expect(text).toContain("separated from other entries by a blank line");
		expect(text).toContain('never write "last:"');
		expect(text).toContain("## Next\nCheck the release report.\n");
	});

	it("explains how to copy the full timed task action for cancellation", async () => {
		const output = await composeContinuityContext(harness, "SessionStart",
			{ session_id: "due-session", cwd: root }, async () => "");
		const text = JSON.parse(output).hookSpecificOutput.additionalContext;
		expect(text).toContain('the do text runs from after "do: " to the " | next: " that follows it');
		expect(text).toContain('the do text may itself contain " | "');
		expect(text).not.toContain('to the next " | "');
	});

	it("logs a failed problem read and still delivers the brief and memory", async () => {
		vi.stubEnv("DUE_TEST_RESULT", "fail");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const output = await composeContinuityContext(harness, "SessionStart",
			{ session_id: "due-session", cwd: root }, async () => JSON.stringify({
				hookSpecificOutput: { additionalContext: "The release owner is Sam." },
			}));
		const text = JSON.parse(output).hookSpecificOutput.additionalContext;
		expect(text).toContain("## Next\nCheck the release report.\n");
		expect(text).toContain("The release owner is Sam.");
		expect(text).not.toContain("Timed tasks did not run as planned:");
		expect(log.mock.calls.flat().join("\n")).toContain('"operation":"heartbeat --due"');
		expect(log.mock.calls.flat().join("\n")).toContain("due records unavailable");
	});

	it("omits the problem heading when no timed tasks have problems", async () => {
		vi.stubEnv("DUE_TEST_RESULT", "empty");
		const output = await composeContinuityContext(harness, "SessionStart",
			{ session_id: "due-session", cwd: root }, async () => "");
		const text = JSON.parse(output).hookSpecificOutput.additionalContext;
		expect(text).not.toContain("Timed tasks did not run as planned:");
		expect(text).toContain("## Next\nCheck the release report.\n");
	});

	it("does not query timed tasks for an ordinary prompt", async () => {
		const output = await composeContinuityContext(harness, "UserPromptSubmit",
			{ session_id: "due-session", cwd: root }, async () => "");
		const text = JSON.parse(output).hookSpecificOutput.additionalContext;
		expect(existsSync(join(root, "problems-read"))).toBe(false);
		expect(text).not.toContain("## Due");
		expect(text).not.toContain("Daily report: not started: login expired");
		expect(text).toContain("## Next\nCheck the release report.\n");
	});
});
