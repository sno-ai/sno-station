/** @file sno-station-mem-session-state.ts
 * @purpose Manages per-session runtime keys, observability aliases, recall history cleanup.
 * @boundary Pure session-id normalization and in-memory LRU cleanup only.
 */

import type { PluginHookAgentContext } from "./sno-station-mem-hook-types";

// Session-local LRU state for recall history and turn counters.

/** Normalizes SDK session identifiers into the key used by local LRU state. */
export function resolveRuntimeSessionId(ctx: PluginHookAgentContext): string {
	// Centralize the module behavior fallback value at the boundary of this helper.
	return (ctx.sessionKey?.trim() ? ctx.sessionKey : ctx.sessionId) ?? "default";
}

/** Returns only host-provided session identity for observability correlation. */
export function resolveObserveRuntimeSessionId(ctx: PluginHookAgentContext): string | undefined {
	return resolveObserveRuntimeSessionIds(ctx)[0];
}

export function resolveObserveRuntimeSessionIds(ctx: PluginHookAgentContext): string[] {
	const runtimeSessionIds: string[] = [];
	const seen = new Set<string>();
	for (const value of [ctx.sessionId, ctx.sessionKey]) {
		const normalized = value?.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		runtimeSessionIds.push(normalized);
	}
	return runtimeSessionIds;
}

/** Drops recall history and turn counters together when a session lifecycle ends. */
export function clearSessionState(
	sessionId: string,
	recallHistory: Map<string, Map<string, number>>,
	turnCounter: Map<string, number>,
): void {
	recallHistory.delete(sessionId);
	turnCounter.delete(sessionId);
}
