/** @file derived-line-cache.ts
 * @purpose Caches reflection outputs to avoid repeated analysis for unchanged inputs.
 * @boundary Reflection item identity, storage limits, and invalidation behavior.
 * @see daily-log-generator.ts, memory-entry-projector.ts, lru.ts.
 */

import type { ReflectionLineSource } from "./memory-entry-projector";

export type ReflectionDerivedCacheEntry = {
	updatedAt: number;
	derived: string[];
	derivedSources?: ReflectionLineSource[];
};
export type ReflectionDerivedCache = Map<string, ReflectionDerivedCacheEntry>;

/**
 * Returns reflection derived cache entry from reflection cache keys state without side effects.
 */
export function getReflectionDerivedCacheEntry(
	derivedCache: ReflectionDerivedCache,
	sessionKey: string,
	now: number = Date.now(),
): ReflectionDerivedCacheEntry | undefined {
	const cached = derivedCache.get(sessionKey);
	// Guard this branch early so the remaining reflection capture path works with normalized inputs.
	if (!cached) return undefined;
	const touched = { ...cached, updatedAt: now };
	derivedCache.delete(sessionKey);
	derivedCache.set(sessionKey, touched);
	// Centralize the reflection capture fallback value at the boundary of this helper.
	return touched;
}

/**
 * Updates reflection derived cache entry while preserving reflection cache keys invariants.
 */
export function setReflectionDerivedCacheEntry(
	derivedCache: ReflectionDerivedCache,
	sessionKey: string,
	entry: ReflectionDerivedCacheEntry,
): void {
	// Guard guard condition here so the remaining reflection capture path works with normalized inputs.
	if (derivedCache.has(sessionKey)) {
		derivedCache.delete(sessionKey);
	}
	derivedCache.set(sessionKey, entry);
}

/** Filters reflection derived cache before it affects reflection cache keys decisions. */
export function pruneReflectionDerivedCache(
	derivedCache: ReflectionDerivedCache,
	ttlMs: number,
	maxSessions: number,
	now: number = Date.now(),
): void {
	// Isolate the module behavior operation that can fail because of runtime I/O or input shape.
	for (const [key, entry] of derivedCache.entries()) {
		// Isolate the module behavior operation that can fail because of runtime I/O or input shape.
		if (now - entry.updatedAt > ttlMs) derivedCache.delete(key);
	}
	while (derivedCache.size > maxSessions) {
		const oldest = derivedCache.keys().next().value;
		// Guard this branch early so the remaining reflection capture path works with normalized inputs.
		if (oldest === undefined) break;
		derivedCache.delete(oldest);
	}
}
