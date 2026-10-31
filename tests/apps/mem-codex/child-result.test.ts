import { describe, expect, it } from "vitest";
import { codexChildResult } from "../../../apps/mem-codex/src/worker.js";

describe("Codex child failures", () => {
	it.each([
		["Not logged in", "auth"],
		["Your refresh token has expired. Please log out and sign in again.", "auth"],
		["You’ve hit your usage limit. Upgrade to Pro", "exhausted"],
		["Usage limit reached", "exhausted"],
	])("classifies %s", (message, category) => {
		expect(codexChildResult(1, "", message)).toMatchObject({ kind: "error", category });
	});
	it.each(["ERROR: connection refused", "connection refused"])("does not classify echoed user text as a model failure: %s", error => {
		expect(codexChildResult(1, "", `user\nExplain usage limits and not logged in errors.\n${error}`)).toMatchObject({ kind: "error", category: "transport" });
	});
	it("keeps ordinary failures and successful text unchanged", () => {
		expect(codexChildResult(1, "", "connection refused")).toMatchObject({ kind: "error", category: "transport" });
		expect(codexChildResult(0, "", "")).toMatchObject({ kind: "error", category: "transport", message: "empty-output" });
		expect(codexChildResult(0, "Not logged in", "")).toEqual({ kind: "ok", text: "Not logged in" });
	});
});
