/** @file memory-tool-registration.ts
 * @purpose Public memory tool registration entrypoint and grouped tool exports.
 * @boundary Composition only; individual tool logic lives in focused modules.
 */

import { registerMemoryRecall } from "./memory-recall-tool";
import { registerMemoryCorrect } from "./memory-correct-tool";
import { registerMemorySave } from "./memory-store-tool";
import type { SnoStationMemPluginApi } from "./memory-tool-dependencies";
import type { ToolContext } from "./memory-tool-schemas";

export * from "./memory-correct-tool";
export * from "./memory-recall-tool";
export * from "./memory-store-tool";
export * from "./memory-tool-schemas";

/** Installs the complete memory tool surface on the host plugin API. */
export function registerAllMemoryTools(api: SnoStationMemPluginApi, ctx: ToolContext): void {
	registerMemoryRecall(api, ctx);
	registerMemorySave(api, ctx);
	registerMemoryCorrect(api, ctx);
}
