import { executeMemoryCorrectTool, toolHostContext } from "./http-memory-tools";
import { Type, type SnoStationMemPluginApi } from "./memory-tool-dependencies";
import type { ToolContext, ToolResult } from "./memory-tool-schemas";

export function registerMemoryCorrect(api: SnoStationMemPluginApi, ctx: ToolContext): void {
	api.registerTool(toolCtx => {
		const access = toolHostContext(toolCtx);
		return {
			name: "memory_correct", label: "Memory Correct",
			description: "Correct a wrong identified memory by creating a fresh successor and retiring its old id atomically. Recall first when its id is not visible. If already superseded, your new wording was not applied: get or recall that successor, then correct it only if the wording still differs. Background and plugin code never correct on their own; no model delete action exists.",
			parameters: Type.Object({ id: Type.String({ description: "Memory id to correct" }),
				content: Type.String({ description: "Corrected fact" }) }),
			async execute(id, params): Promise<ToolResult> {
				return executeMemoryCorrectTool(ctx, access, id, params);
			},
		};
	}, { name: "memory_correct" });
}
