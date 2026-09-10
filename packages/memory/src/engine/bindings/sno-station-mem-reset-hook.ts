/** @file sno-station-mem-reset-hook.ts
 * @purpose Clears per-session recall state before reset.
 * @boundary The before_reset cleanup path only.
 */

import type {
	PluginHookAgentContext,
	PluginHookBeforeResetEvent,
} from "./sno-station-mem-hook-types";
import {
	type createScopePolicy,
	type Embedder,
	type MemoryStore,
	type SnoStationMemPluginApi,
	type PluginConfig,
} from "./sno-station-mem-runtime-dependencies";
import { clearSessionState, resolveRuntimeSessionId } from "./sno-station-mem-session-state";

/** Stores reset-time session context before the host discards conversation state. */
export async function onBeforeReset(
	_api: SnoStationMemPluginApi,
	_config: PluginConfig,
	_store: MemoryStore,
	_embedder: Embedder,
	_scopePolicy: ReturnType<typeof createScopePolicy>,
	recallHistory: Map<string, Map<string, number>>,
	turnCounter: Map<string, number>,
	_event: PluginHookBeforeResetEvent,
	ctx: PluginHookAgentContext,
	_stateDir: string,
): Promise<void> {
	const sessionId = resolveRuntimeSessionId(ctx);
	clearSessionState(sessionId, recallHistory, turnCounter);
}
