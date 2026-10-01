/** Real LLM API required. No mocking. Missing keys = FAIL. */

import { describe, expect, it } from "vitest";
import defaultPlugin, {
	memClawPlugin,
} from "../../../../apps/mem-claw/index.ts";

describe("plugin entrypoint exports", () => {
	it("preserves the default export for OpenClaw plugin loading", () => {
		expect(defaultPlugin).toBe(memClawPlugin);
		expect(defaultPlugin.register).toBe(memClawPlugin.register);
	});
});
