import { describe, expect, it } from "vitest";
import { parseInput } from "../../../../packages/memory/src/contract";

const scope = { principal: "test", project: "/workspace", session: "session-1" };

describe("init registration", () => {
	it.each(["hermes", "claude-code", "codex", "openclaw"])("accepts %s without copied settings", skinId => {
		expect(parseInput("init", { scope, registration: { skinId } })).toEqual({
			scope,
			registration: { skinId },
		});
	});

	it("accepts a connected host model", () => {
		const model = { baseUrl: "http://127.0.0.1:19213/v1", credential: "test", model: "host" };
		expect(parseInput("init", { scope, registration: { skinId: "codex", model } })).toEqual({
			scope,
			registration: { skinId: "codex", model },
		});
	});

	it.each(["inheritInstalled", "settings", "routing"])("rejects removed field %s", field => {
		expect(() => parseInput("init", {
			scope,
			registration: { skinId: "hermes", [field]: {} },
		})).toThrow("invalid-input");
	});
});
