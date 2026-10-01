/** @file multi-agent-scope.ts
 * @purpose Resolves team-aware memory scopes for SnoStationMem runtime integrations.
 * @boundary Workspace identity, session context, and plugin scope configuration.
 * @see scopes.ts, sno-station-mem-plugin-runtime.ts, types.ts.
 */

/**
 * Multi-Agent Shared Memory Scope Integration
 *
 * Provides env-var-driven scope extension for multi-agent setups.
 * When SNO_STATION_MEM_SHARED_SCOPES is set, agents gain access to the specified
 * team scopes in addition to their own default scopes.
 *
 * Note: this extends `getAccessibleScopes()`, which MemoryScopePolicy's
 * `isAccessible()` and `getScopeFilter()` both delegate to. So the extra
 * scopes affect both read and write access checks. The default *write target*
 * (getDefaultScope) is NOT changed — agents still write to their own scope
 * unless they explicitly specify a team scope.
 */

import type { MemoryScopePolicy } from "./scopes";

/**
 * Parse the SNO_STATION_MEM_SHARED_SCOPES env var value into a list of scope names.
 * Supports comma-separated values, trims whitespace, and filters empty strings.
 */
export function parseMultiAgentScopes(envValue: string | undefined): string[] {
	// Guard this branch early so the remaining scope policy path works with normalized inputs.
	if (!envValue) return [];
	// Centralize the scope policy fallback value at the boundary of this helper.
	return envValue
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Register Multi-agent scopes and extend the scope manager's accessible scopes.
 *
 * 1. Registers scope definitions for any scopes not already defined.
 * 2. Configures first-class extra accessible scopes on the scope manager.
 */
export function applyMultiAgentScopes(scopePolicy: MemoryScopePolicy, scopes: string[]): void {
	// Treat the empty collection as a first-class outcome instead of widening behavior.
	if (scopes.length === 0) return;

	// Register scope definitions for unknown scopes
	for (const scope of scopes) {
		// Handle the absent-value case explicitly before the happy path depends on it.
		if (!scopePolicy.getScopeDefinition(scope)) {
			// This scope policy step establishes state that later reads and cleanup paths depend on.
			scopePolicy.addScopeDefinition(scope, {
				description: `Multi-agent shared scope: ${scope}`,
			});
		}
	}

	// This scope policy step establishes state that later reads and cleanup paths depend on.
	scopePolicy.setExtraAccessibleScopes(scopes);
}
