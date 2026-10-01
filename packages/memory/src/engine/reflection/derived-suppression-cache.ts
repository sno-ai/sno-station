/** @file derived-suppression-cache.ts
 * @purpose Tracks short-lived derived-injection suppression after session
 * boundary reflections (`/new`, `/reset`). The just-closed session may have
 * generated fresh derived deltas — keep those out of the immediately opened
 * prompt window so reflection content does not leak across the boundary.
 * @boundary Suppression key identity, TTL, and size limits.
 * @see derived-line-cache.ts, reflection-command-hooks.ts, reflection-injection-hooks.ts.
 */

export const DEFAULT_REFLECTION_BOUNDARY_DERIVED_SUPPRESSION_MS = 120_000;

export type ReflectionDerivedSuppressionEntry = {
	updatedAt: number;
	until: number;
	reason: string;
};

export type ReflectionDerivedSuppressionCache = Map<
	string,
	ReflectionDerivedSuppressionEntry
>;

/**
 * Returns the active suppression entry for a session key, or undefined when
 * none is active or it has expired. Expired entries are evicted on read so
 * the next derived injection path runs normally.
 */
export function getReflectionDerivedSuppression(
	cache: ReflectionDerivedSuppressionCache,
	sessionKey: string,
	now: number = Date.now(),
): ReflectionDerivedSuppressionEntry | undefined {
	const entry = cache.get(sessionKey);
	if (!entry) return undefined;
	if (entry.until <= now) {
		cache.delete(sessionKey);
		return undefined;
	}
	return entry;
}

/**
 * Records suppression for `sessionKey` so subsequent derived injection in the
 * suppression window is skipped. Overwrites any existing entry.
 */
export function setReflectionDerivedSuppression(
	cache: ReflectionDerivedSuppressionCache,
	sessionKey: string,
	entry: ReflectionDerivedSuppressionEntry,
): void {
	if (cache.has(sessionKey)) cache.delete(sessionKey);
	cache.set(sessionKey, entry);
}

/** Drops the suppression entry for `sessionKey` if present. */
export function deleteReflectionDerivedSuppression(
	cache: ReflectionDerivedSuppressionCache,
	sessionKey: string,
): void {
	cache.delete(sessionKey);
}

/**
 * TTL-prunes expired suppression entries and trims to `maxSessions` by
 * insertion-order, mirroring `pruneReflectionDerivedCache`.
 */
export function pruneReflectionDerivedSuppression(
	cache: ReflectionDerivedSuppressionCache,
	ttlMs: number,
	maxSessions: number,
	now: number = Date.now(),
): void {
	for (const [key, entry] of cache.entries()) {
		if (now > entry.until || now - entry.updatedAt > ttlMs) {
			cache.delete(key);
		}
	}
	while (cache.size > maxSessions) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/**
 * Returns true when an action string represents a session-boundary reflection
 * action (`new` / `reset`). The normalization mirrors upstream — strip an
 * optional `command:` prefix and lower-case the result.
 */
export function isSessionBoundaryReflectionAction(action: unknown): boolean {
	if (typeof action !== "string") return false;
	const normalized = action.trim().toLowerCase();
	if (!normalized) return false;
	const last = normalized.split(":").pop() ?? normalized;
	return last === "new" || last === "reset";
}
