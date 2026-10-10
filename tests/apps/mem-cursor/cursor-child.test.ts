import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cursorChildResult, runCursorChild } from "../../../apps/mem-cursor/src/worker.ts";

// Outputs of `cursor-agent -p --output-format json` measured on Linux (2026-10-09) and macOS (2026-10-10).
describe("cursor-agent print-mode result to host-model answer", () => {
	it("returns the result text of a successful run", () => {
		const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 7083, result: " Probe code SLOW-0: HARRIER-0\n",
			session_id: "b11ae661-667d-4f2b-888f-2a5bc9d3d8ea", usage: { inputTokens: 14855, outputTokens: 179 } });
		expect(cursorChildResult(0, stdout, "")).toEqual({ kind: "ok", text: "Probe code SLOW-0: HARRIER-0" });
	});

	it("names a locked macOS keychain as an unreadable login, never as quota", () => {
		const stderr = "\u001b[33mError: Your macOS login keychain is locked.\u001b[0m\nRun \u001b[36msecurity unlock-keychain\u001b[0m and try again.\n";
		expect(cursorChildResult(1, "", stderr)).toEqual({ kind: "error", category: "auth", message: "Cursor CLI login unreadable (keychain locked)" });
	});

	it("names a used-up plan as exhausted", () => {
		expect(cursorChildResult(1, "", "ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.\n"))
			.toEqual({ kind: "error", category: "exhausted", message: "Cursor usage limit reached" });
	});

	it("reports other failures as transport errors", () => {
		expect(cursorChildResult(1, "", "Workspace Trust Required")).toEqual({ kind: "error", category: "transport", message: "cursor-agent-exit-1" });
		expect(cursorChildResult(0, "not json", "")).toEqual({ kind: "error", category: "transport", message: "invalid-json" });
		expect(cursorChildResult(0, JSON.stringify({ type: "result", is_error: true, result: "boom" }), "")).toEqual({ kind: "error", category: "transport", message: "cursor-is-error" });
		expect(cursorChildResult(0, JSON.stringify({ type: "result", is_error: false, result: "  " }), "")).toEqual({ kind: "error", category: "transport", message: "empty-output" });
	});
});

describe("the isolated cursor-agent child", () => {
	it("leaves no helper process running after it answers", async () => {
		// A stand-in for cursor-agent that, like the real one, starts a helper which outlives it and holds its output open.
		const root = mkdtempSync(join(tmpdir(), "mem-cursor-child-group-"));
		const pidFile = join(root, "helper.pid");
		writeFileSync(join(root, "cursor-agent"), `#!/bin/sh\nsleep 300 &\necho $! > "${pidFile}"\ncat > /dev/null\nprintf '{"type":"result","is_error":false,"result":"pong"}\\n'\n`);
		chmodSync(join(root, "cursor-agent"), 0o755);
		const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
		process.env.PATH = `${root}:${saved.PATH ?? ""}`;
		process.env.HOME = join(root, "home");
		try {
			expect(await runCursorChild("user: reply pong", 20_000)).toEqual({ kind: "ok", text: "pong" });
			const helper = Number(readFileSync(pidFile, "utf8"));
			expect(() => process.kill(helper, 0)).toThrow(/ESRCH/);
		} finally {
			process.env.PATH = saved.PATH;
			process.env.HOME = saved.HOME;
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
