import { expect, it } from "vitest";
import { sanitizeLogAttributes } from "../../../packages/utils/src/log-encoder.ts";

it("keeps a failed host model call's category and reason readable, and still hides free text", () => {
	const out = sanitizeLogAttributes({
		failure_category: "transport", failure_reason: "no-agent-endpoint", error: "[R5] agent-llm transport: no-agent-endpoint",
	}) as Record<string, unknown>;
	expect(out["failure_category"]).toBe("transport");
	expect(out["failure_reason"]).toBe("no-agent-endpoint");
	expect(out["error"]).toMatchObject({ length: 43 });
});
