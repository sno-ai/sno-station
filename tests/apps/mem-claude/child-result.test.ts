import { describe, expect, it } from "vitest";
import { claudeChildResult } from "../../../apps/mem-claude/src/worker.js";

describe("Claude child failures", () => {
	it.each([
		["Not logged in · Please run /login", "auth"],
		['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "auth"],
		["OAuth token revoked · Please run /login", "auth"],
		["Login expired · Please run /login", "auth"],
		["You've hit your limit · resets 3pm", "exhausted"],
		["Your credit balance is too low to access the Anthropic API.", "exhausted"],
	])("classifies %s", (message, category) => {
		expect(claudeChildResult(1, JSON.stringify({ is_error: true, result: message }), "")).toMatchObject({ kind: "error", category });
		expect(claudeChildResult(0, JSON.stringify({ is_error: true, result: message }), "")).toMatchObject({ kind: "error", category });
	});
	it("keeps ordinary failures and successful text unchanged", () => {
		expect(claudeChildResult(1, "", "connection refused")).toMatchObject({ kind: "error", category: "transport" });
		expect(claudeChildResult(0, "bad json", "")).toMatchObject({ kind: "error", category: "transport", message: "invalid-json" });
		expect(claudeChildResult(0, JSON.stringify({ is_error: false, result: "Not logged in", usage: { input_tokens: 5, output_tokens: 3 } }), "")).toEqual({ kind: "ok", text: "Not logged in", usage: { inputTokens: 5, outputTokens: 3 } });
	});
});
