/**
 * Integration tests for error-signal harvesting (error-signals.ts).
 *
 * Pure function + in-memory tracker tests. No DB, no embeddings, no mocking.
 * All functions are deterministic — real crypto hashing, real regex matching.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS } from "../../../../packages/memory/config/index.ts";
import {
	containsErrorSignal,
	normalizeErrorSignature,
	summarizeErrorText,
	extractTextFromToolResult,
	sha256Hex,
	createErrorSignalTracker,
} from "../../../../packages/memory/src/engine/security/error-signals.ts";
import type { ReflectionErrorSignal } from "../../../../packages/memory/src/engine/security/error-signals.ts";

// ── Helper: build a ReflectionErrorSignal with defaults ─────────────────

function makeSignal(overrides: Partial<ReflectionErrorSignal> = {}): ReflectionErrorSignal {
	const signature = overrides.signature ?? "some error signature";
	return {
		at: overrides.at ?? Date.now(),
		toolName: overrides.toolName ?? "bash",
		summary: overrides.summary ?? "something failed",
		source: overrides.source ?? "tool_error",
		signature,
		signatureHash: overrides.signatureHash ?? sha256Hex(signature),
	};
}

// ── 1. containsErrorSignal — detects common error patterns ──────────────

describe("containsErrorSignal", () => {
	it("detects all documented error patterns", () => {
		const positives = [
			"[error] something went wrong",
			"Error: ENOENT no such file",
			"Exception: divide by zero",
			"Fatal: not a git repository",
			"Traceback (most recent call last):",
			"TypeError: Cannot read properties of undefined",
			"ReferenceError: foo is not defined",
			"SyntaxError: Unexpected token '<'",
			"npm ERR! code ERESOLVE",
			"bash: command not found",
			"ls: no such file or directory",
			"Permission denied (publickey)",
			"Process exited with non-zero exit code 1",
			"exit code 127",
			'{"status": "error", "message": "timeout"}',
			'{"status": "failed"}',
			"isError: true",
			"错误: 配置文件未找到",
			"错误：数据库连接失败",
			"异常: 空指针引用",
			"异常：未处理的异常",
			"报错: 模块未加载",
			"报错：语法错误",
			"失败: 测试未通过",
			"失败：部署失败",
		];

		for (const text of positives) {
			expect(containsErrorSignal(text)).toBe(true);
		}
	});

	// ── 2. containsErrorSignal — returns false for normal text ────────

	it("returns false for normal text without error signals", () => {
		const negatives = [
			"The build completed successfully.",
			"All 42 tests passed.",
			"User logged in at 14:30.",
			"TypeScript compilation finished in 2.3s.",
			"Server listening on port 3000.",
			"Deployed to production: v1.2.3.",
			"Memory usage: 128MB RSS, 64MB heap.",
			"Function returned the expected value.",
			"",
			"   ",
		];

		for (const text of negatives) {
			expect(containsErrorSignal(text)).toBe(false);
		}
	});
});

// ── 3. normalizeErrorSignature ──────────────────────────────────────────

describe("normalizeErrorSignature", () => {
	it("replaces paths, numbers, hex, collapses whitespace, truncates, and redacts secrets", () => {
		// Unix path → <path>
		expect(normalizeErrorSignature("failed at /home/user/project/src/plugin/openclaw-plugin-runtime.ts")).toContain(
			"<path>",
		);
		expect(normalizeErrorSignature("failed at /home/user/project/src/plugin/openclaw-plugin-runtime.ts")).not.toContain(
			"/home/user",
		);

		// Windows path → <path>
		expect(
			normalizeErrorSignature("failed at C:\\Users\\dev\\project\\file.ts"),
		).toContain("<path>");
		expect(
			normalizeErrorSignature("failed at C:\\Users\\dev\\project\\file.ts"),
		).not.toContain("C:\\Users");

		// Numbers → <n>
		expect(normalizeErrorSignature("exit code 127")).toContain("<n>");
		expect(normalizeErrorSignature("exit code 127")).not.toMatch(/\b127\b/);

		// Hex → <hex>
		expect(normalizeErrorSignature("address 0xDEADBEEF")).toContain("<hex>");
		expect(normalizeErrorSignature("address 0xDEADBEEF")).not.toContain("0xDEADBEEF");

		// Whitespace collapsed
		expect(normalizeErrorSignature("error   in   module")).toBe("error in module");

		// Truncation at 240 chars
		const longText = "x".repeat(300);
		expect(normalizeErrorSignature(longText).length).toBeLessThanOrEqual(240);

		// Secret redaction (Bearer token)
		const withBearer = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
		const normalized = normalizeErrorSignature(withBearer);
		expect(normalized).not.toContain("eyJhbGciOiJIUzI1NiIs");
		expect(normalized).toContain("[redacted_secret]");

		// Lowercased
		expect(normalizeErrorSignature("TypeError")).toBe("typeerror");

		// Empty/falsy input
		expect(normalizeErrorSignature("")).toBe("");
	});
});

// ── 4. summarizeErrorText ───────────────────────────────────────────────

describe("summarizeErrorText", () => {
	it("clips at 220 chars, redacts secrets, returns '(empty tool error)' for empty input", () => {
		// Empty / whitespace-only → sentinel
		expect(summarizeErrorText("")).toBe("(empty tool error)");
		expect(summarizeErrorText("   ")).toBe("(empty tool error)");
		expect(summarizeErrorText("\n\t\n")).toBe("(empty tool error)");

		// Short text passes through (whitespace collapsed)
		expect(summarizeErrorText("Error: file not found")).toBe("Error: file not found");
		expect(summarizeErrorText("Error:  multiple   spaces")).toBe("Error: multiple spaces");

		// Multiline collapsed to single line
		expect(summarizeErrorText("line1\nline2\nline3")).toBe("line1 line2 line3");

		// Clips at 220 chars with "..."
		const longText = "A".repeat(250);
		const summary = summarizeErrorText(longText);
		expect(summary.length).toBe(220);
		expect(summary).toMatch(/\.\.\.$/);

		// Custom maxLen
		const custom = summarizeErrorText("A".repeat(50), 30);
		expect(custom.length).toBe(30);
		expect(custom).toMatch(/\.\.\.$/);

		// Secret redaction
		const withSecret = "Error: key=sk-proj-<REDACTED>";
		const summarized = summarizeErrorText(withSecret);
		expect(summarized).not.toContain("sk-proj-");
		expect(summarized).toContain("[REDACTED_SECRET]");
	});
});

// ── 5. extractTextFromToolResult ────────────────────────────────────────

describe("extractTextFromToolResult", () => {
	it("extracts text from MCP-style objects, handles null/undefined/string/nested", () => {
		// null → ""
		expect(extractTextFromToolResult(null)).toBe("");

		// undefined → ""
		expect(extractTextFromToolResult(undefined)).toBe("");

		// string passthrough
		expect(extractTextFromToolResult("hello world")).toBe("hello world");

		// Non-object types → ""
		expect(extractTextFromToolResult(42)).toBe("");
		expect(extractTextFromToolResult(true)).toBe("");

		// MCP-style { content: [{ type: "text", text: "..." }] }
		expect(
			extractTextFromToolResult({
				content: [{ type: "text", text: "error message" }],
			}),
		).toBe("error message");

		// Multiple text items joined with newline
		expect(
			extractTextFromToolResult({
				content: [
					{ type: "text", text: "line1" },
					{ type: "text", text: "line2" },
				],
			}),
		).toBe("line1\nline2");

		// Non-text items skipped
		expect(
			extractTextFromToolResult({
				content: [
					{ type: "image", url: "http://example.com/img.png" },
					{ type: "text", text: "only text" },
				],
			}),
		).toBe("only text");

		// content array with non-object items skipped
		expect(
			extractTextFromToolResult({
				content: [null, undefined, "not-an-object", { type: "text", text: "ok" }],
			}),
		).toBe("ok");

		// Fallback to obj.text when content is not an array
		expect(extractTextFromToolResult({ text: "fallback text" })).toBe("fallback text");

		// Object with neither content array nor text → ""
		expect(extractTextFromToolResult({ foo: "bar" })).toBe("");

		// Empty content array → ""
		expect(extractTextFromToolResult({ content: [] })).toBe("");
	});
});

// ── 6. sha256Hex ────────────────────────────────────────────────────────

describe("sha256Hex", () => {
	it("produces deterministic hex output for known input", () => {
		// Known SHA-256 of empty string
		expect(sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);

		// Known SHA-256 of "hello"
		expect(sha256Hex("hello")).toBe(
			"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		);

		// Deterministic: same input → same output
		const a = sha256Hex("test input");
		const b = sha256Hex("test input");
		expect(a).toBe(b);

		// Different input → different output
		expect(sha256Hex("foo")).not.toBe(sha256Hex("bar"));

		// Returns 64-character lowercase hex string
		const hash = sha256Hex("anything");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

// ── 7. createErrorSignalTracker — addSignal + getPendingSignals ─────────

describe("createErrorSignalTracker — addSignal + getPendingSignals", () => {
	it("caps the pending slice at maxEntries; dedup skips same signatureHash; clearSession removes state", () => {
		const tracker = createErrorSignalTracker();
		const session = "sess-1";

		// Add 3 distinct signals
		const sig1 = makeSignal({ signature: "err-a", signatureHash: sha256Hex("err-a") });
		const sig2 = makeSignal({ signature: "err-b", signatureHash: sha256Hex("err-b") });
		const sig3 = makeSignal({ signature: "err-c", signatureHash: sha256Hex("err-c") });

		tracker.addSignal(session, sig1, true);
		tracker.addSignal(session, sig2, true);
		tracker.addSignal(session, sig3, true);

		// Draining read caps at maxEntries=2 → the most-recent 2 pending signals, and advances the marker.
		const pending = tracker.getPendingSignals(session, 2);
		expect(pending).toHaveLength(2);
		expect(pending[0]?.signature).toBe("err-b");
		expect(pending[1]?.signature).toBe("err-c");

		// Marker advanced past all 3 entries: a subsequent read has nothing new to drain.
		expect(tracker.getPendingSignals(session, 10)).toHaveLength(0);

		// Dedup: adding sig1 again with dedupeEnabled=true → nothing new is appended, so nothing to drain.
		tracker.addSignal(session, sig1, true);
		expect(tracker.getPendingSignals(session, 10)).toHaveLength(0);

		// Dedup disabled: adding sig1 again with dedupeEnabled=false → 1 new entry appended and drained.
		tracker.addSignal(session, sig1, false);
		const afterDup = tracker.getPendingSignals(session, 10);
		expect(afterDup).toHaveLength(1);
		expect(afterDup[0]?.signature).toBe("err-a");

		// clearSession removes everything (no session → empty drain).
		tracker.clearSession(session);
		expect(tracker.getPendingSignals(session, 10)).toHaveLength(0);
	});

	it("does not re-return already-injected signals on subsequent reads", () => {
		const tracker = createErrorSignalTracker();
		const session = "replay-guard";

		const sig1 = makeSignal({ signature: "err-1", signatureHash: sha256Hex("err-1") });
		const sig2 = makeSignal({ signature: "err-2", signatureHash: sha256Hex("err-2") });

		tracker.addSignal(session, sig1, true);
		tracker.addSignal(session, sig2, true);

		// First read drains both pending signals.
		const first = tracker.getPendingSignals(session, 10);
		expect(first.map((e) => e.signature)).toEqual(["err-1", "err-2"]);

		// Immediate second read must NOT replay them (the bug being fixed).
		expect(tracker.getPendingSignals(session, 10)).toHaveLength(0);

		// A newly added signal is the only thing the next read returns.
		const sig3 = makeSignal({ signature: "err-3", signatureHash: sha256Hex("err-3") });
		tracker.addSignal(session, sig3, true);
		const third = tracker.getPendingSignals(session, 10);
		expect(third.map((e) => e.signature)).toEqual(["err-3"]);
	});

	it("ignores addSignal with empty session key", () => {
		const tracker = createErrorSignalTracker();
		const sig = makeSignal();

		tracker.addSignal("", sig, false);
		tracker.addSignal("  ", sig, false);

		// No sessions created
		expect(tracker.getPendingSignals("", 10)).toHaveLength(0);
	});

	it("caps entries at MAX_ENTRIES_PER_SESSION (30) and evicts oldest", () => {
		const tracker = createErrorSignalTracker();
		const session = "cap-test";

		// Add 35 distinct signals
		for (let i = 0; i < 35; i++) {
			const sig = makeSignal({
				signature: `err-${i}`,
				signatureHash: sha256Hex(`err-${i}`),
			});
			tracker.addSignal(session, sig, true);
		}

		const all = tracker.getPendingSignals(session, 100);
		expect(all).toHaveLength(30);

		// First 5 should have been evicted — oldest entry should be err-5
		expect(all[0]?.signature).toBe("err-5");
		expect(all[29]?.signature).toBe("err-34");
	});
});

// ── 8. createErrorSignalTracker — prune ─────────────────────────────────

describe("createErrorSignalTracker — prune", () => {
	it("removes sessions older than TTL and excess sessions beyond maxSessions", () => {
		const tracker = createErrorSignalTracker();

		// Create 5 sessions with controlled updatedAt by accessing them in order
		// We need to manipulate timing, so we add signals to create sessions,
		// then use getState to update timestamps.
		const sessions = ["s1", "s2", "s3", "s4", "s5"];
		for (const s of sessions) {
			tracker.addSignal(s, makeSignal(), false);
		}

		// All 5 sessions exist (getState is a non-draining read; it also refreshes updatedAt in s1..s5 order,
		// leaving s1 oldest and s5 newest for the prune-by-maxSessions assertion below).
		for (const s of sessions) {
			const state = tracker.getState(s);
			expect(state.entries.length).toBeGreaterThanOrEqual(1);
		}

		// Prune with a very large TTL → nothing removed (no TTL expiry).
		tracker.prune(999_999_999, 100);

		// Prune by maxSessions: allow only 2 → 3 oldest removed.
		tracker.prune(999_999_999, 2);

		// getPendingSignals drains, so read each session exactly once to count survivors.
		let remaining = 0;
		const survivors: string[] = [];
		for (const s of sessions) {
			if (tracker.getPendingSignals(s, 10).length > 0) {
				remaining++;
				survivors.push(s);
			}
		}
		expect(remaining).toBe(2);

		// The 2 survivors are the most-recently-touched sessions (s4, s5).
		expect(survivors).toEqual(["s4", "s5"]);
	});

	it("TTL-based prune removes stale sessions", () => {
		const tracker = createErrorSignalTracker();

		// Create a session, then manually age it via getState timestamp manipulation
		tracker.addSignal("old-session", makeSignal(), false);

		// Force the updatedAt to be old by directly accessing internal state
		const state = tracker.getState("old-session");
		// Set updatedAt to 10 seconds ago
		state.updatedAt = Date.now() - 10_000;

		// Create a fresh session
		tracker.addSignal("new-session", makeSignal(), false);

		// Prune with 5s TTL → old-session removed, new-session stays
		tracker.prune(5_000, 100);

		expect(tracker.getPendingSignals("old-session", 10)).toHaveLength(0);
		expect(tracker.getPendingSignals("new-session", 10).length).toBeGreaterThanOrEqual(1);
	});

	it("caps tracked sessions even when prune is never called", () => {
		const tracker = createErrorSignalTracker();
		const totalSessions = DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS + 30;

		for (let i = 0; i < totalSessions; i++) {
			tracker.addSignal(`session-${i}`, makeSignal({ signature: `err-${i}` }), true);
		}

		// getPendingSignals drains, so read each session exactly once. The oldest 30 sessions
		// (session-0 .. session-29) are evicted; the newest DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS survive.
		let remaining = 0;
		const evicted: number[] = [];
		for (let i = 0; i < totalSessions; i++) {
			const hasSignals = tracker.getPendingSignals(`session-${i}`, 10).length > 0;
			if (hasSignals) {
				remaining += 1;
			} else {
				evicted.push(i);
			}
		}

		expect(remaining).toBe(DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS);
		// The 30 oldest (session-0 .. session-29) were evicted; the newest one survived.
		expect(evicted).toEqual(Array.from({ length: 30 }, (_, i) => i));
	});

	it("respects a configured max tracked session cap", () => {
		const tracker = createErrorSignalTracker({ maxTrackedSessions: 2 });

		for (const sessionKey of ["session-a", "session-b", "session-c"]) {
			tracker.addSignal(sessionKey, makeSignal({ signature: sessionKey }), true);
		}

		expect(tracker.getPendingSignals("session-a", 10)).toHaveLength(0);
		expect(tracker.getPendingSignals("session-b", 10).length).toBeGreaterThanOrEqual(1);
		expect(tracker.getPendingSignals("session-c", 10).length).toBeGreaterThanOrEqual(1);
	});
});
