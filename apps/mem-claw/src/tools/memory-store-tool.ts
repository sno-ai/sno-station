import { executeMemorySaveTool, toolHostContext } from "./http-memory-tools";
import { Type, type SnoStationMemPluginApi } from "./memory-tool-dependencies";
import type { ToolContext, ToolResult } from "./memory-tool-schemas";

export function registerMemorySave(api: SnoStationMemPluginApi, ctx: ToolContext): void {
	api.registerTool(toolCtx => {
		const access = toolHostContext(toolCtx);
		return {
			name: "memory_store", label: "Memory Remember",
			description: "Remember content explicitly requested by the user. Returns the stored id. Leave an unidentified new or changed fact to turn capture.",
			parameters: Type.Object({ content: Type.String({ description: "Information to remember" }) }),
			async execute(id, params): Promise<ToolResult> {
				return executeMemorySaveTool(ctx, access, id, params);
			},
		};
	}, { name: "memory_store" });
}
