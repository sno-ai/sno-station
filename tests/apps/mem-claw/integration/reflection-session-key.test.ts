import { describe, expect, it } from "vitest";
import { parseAgentIdFromSessionKey } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";

describe("parseAgentIdFromSessionKey", () => {
	it("extracts only the agent id from agent session keys", () => {
		expect(parseAgentIdFromSessionKey("agent:main:session-1")).toBe("main");
		expect(parseAgentIdFromSessionKey("agent:worker:pipeline-test")).toBe(
			"worker",
		);
	});

	it("handles session-prefixed keys and empty input", () => {
		expect(parseAgentIdFromSessionKey("session:main:12345:subagent:worker-1")).toBe(
			"main",
		);
		expect(parseAgentIdFromSessionKey("")).toBeUndefined();
		expect(parseAgentIdFromSessionKey(undefined)).toBeUndefined();
	});

	it("rejects reserved bypass ids from session-key fallback", () => {
		expect(parseAgentIdFromSessionKey("agent:system:session-1")).toBeUndefined();
		expect(parseAgentIdFromSessionKey("session:undefined:12345")).toBeUndefined();
	});
});
