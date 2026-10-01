import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { toolHostContext } from "../../../../apps/mem-claw/src/tools/http-memory-tools.ts";
import { registerMemorySave } from "../../../../apps/mem-claw/src/tools/memory-store-tool.ts";


it("preserves gateway administrator scopes without an agent identity", () => {
	const context = toolHostContext({ gatewayClientScopes: ["operator.admin"] });
	expect(context.gatewayClientScopes).toEqual(["operator.admin"]);
});

describe("memory_store category boundary", () => {
	it("registers only the canonical content input", () => {
		let registered: AnyAgentTool | undefined;
		const api = { registerTool(factory: unknown) {
			registered = typeof factory === "function" ? factory({ agentId: "boundary-test" }) : factory;
		} } as unknown as OpenClawPluginApi;
		registerMemorySave(api, { stateDir: "/tmp", connection: {} as never });
		if (!registered) throw new Error("expected memory_store registration");
		expect(Object.keys(registered.parameters.properties)).toEqual(["content"]);
		expect(registered.parameters.required).toEqual(["content"]);
	});
});
