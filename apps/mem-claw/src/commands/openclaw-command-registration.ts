import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyToolResponse } from "./openclaw-command-helpers";

export function registerCompletionTools(api: OpenClawPluginApi): void {
	for (const name of ["memory_recall", "memory_store", "memory_correct", "memory_search", "memory_get"]) {
		api.registerTool({ name, label: name, description: "Completion-mode stub",
			parameters: Type.Object({}), async execute() { return emptyToolResponse(); },
		}, { name });
	}
}
