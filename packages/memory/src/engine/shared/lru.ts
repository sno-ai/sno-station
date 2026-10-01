/** @file lru.ts
 * @purpose Provides a small bounded cache primitive for hot-path runtime state.
 * @boundary In-memory capacity limits and deterministic eviction behavior.
 * @see derived-line-cache.ts, retrieval-stats.ts, sno-station-mem-plugin-runtime.ts.
 */

/** Generic LRU helpers for bounded Map caches. */

export function pruneOldestEntries<K, V>(map: Map<K, V>, maxEntries: number): void {
	// Advance this loop only while the module behavior invariant still requires work.
	while (map.size > maxEntries) {
		// Compute the normalized oldest key once so later module behavior checks use one value.
		const oldestKey = map.keys().next().value;
		// Guard this branch early so the remaining module behavior path works with normalized inputs.
		if (oldestKey === undefined) return;
		map.delete(oldestKey);
	}
}

/** Implements touch lru entry as the local bounded session cache operation. */
export function touchLruEntry<K, V>(map: Map<K, V>, key: K): V | undefined {
	const value = map.get(key);
	// Guard this branch early so the remaining module behavior path works with normalized inputs.
	if (value === undefined) return undefined;
	map.delete(key);
	map.set(key, value);
	// Centralize the module behavior fallback value at the boundary of this helper.
	return value;
}

/** Updates lru entry while preserving bounded session cache invariants. */
export function setLruEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
	// Guard guard condition here so the remaining module behavior path works with normalized inputs.
	if (map.has(key)) {
		map.delete(key);
	}
	map.set(key, value);
	pruneOldestEntries(map, maxEntries);
}
