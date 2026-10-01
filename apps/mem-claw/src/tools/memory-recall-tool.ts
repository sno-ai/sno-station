import { executeMemoryRecallTool, toolHostContext } from "./http-memory-tools";
import { Type, type SnoStationMemPluginApi } from "./memory-tool-dependencies";
import type { ToolContext, ToolResult } from "./memory-tool-schemas";

export function registerMemoryRecall(api: SnoStationMemPluginApi, ctx: ToolContext): void {
	api.registerTool(toolCtx => {
		const access = toolHostContext(toolCtx);
		return {
			name: "memory_recall", label: "Memory Recall",
			description: "Recall relevant memories, including visibly retired history. Recall first when an identified memory's id is not visible.",
			parameters: Type.Object({ query: Type.String({ description: "Relevant remembered fact" }) }),
			async execute(id, params): Promise<ToolResult> {
				return executeMemoryRecallTool(ctx, access, id, params);
			},
		};
	}, { name: "memory_recall" });
}
