/** @file memory-tool-access.ts
 * @purpose Resolves tool caller identity and enforces memory scope visibility.
 * @boundary Scope and agent-access checks only.
 */

import type { MemoryScopePolicy } from "./memory-tool-dependencies";
import { SnoStationMemError } from "./memory-tool-dependencies";

export function assertAccessibleScope(
	scopePolicy: MemoryScopePolicy,
	scope: string,
	agentId?: string,
): string {
	// Compute the normalized normalized once so later tool execution checks use one value.
	const normalized = scope.trim();
	// Guard this branch early so the remaining tool execution path works with normalized inputs.
	if (!scopePolicy.validateScope(normalized) || !scopePolicy.isAccessible(normalized, agentId)) {
		// Surface this invalid tool execution state as an explicit typed failure.
		throw new SnoStationMemError("invalid_scope", `Scope not accessible: ${normalized}`);
	}
	// Centralize the tool execution fallback value at the boundary of this helper.
	return normalized;
}

export function resolveAgentId(runtimeAgentId: unknown, fallback?: string): string | undefined {
	/** Treats literal "undefined" as absent because some host contexts serialize missing ids. */
	const normalize = (value: unknown): string | undefined => {
		// Guard this branch early so the remaining tool execution path works with normalized inputs.
		if (typeof value !== "string") return undefined;
		const normalized = value.trim();
		// Guard normalized here so the remaining tool execution path works with normalized inputs.
		if (!normalized || normalized === "undefined") {
			// Signal an intentional miss with undefined instead of overloading an empty value.
			return undefined;
		}
		// Centralize the tool execution fallback value at the boundary of this helper.
		return normalized;
	};

	// Centralize the tool execution fallback value at the boundary of this helper.
	return normalize(runtimeAgentId) ?? normalize(fallback);
}

export type ResolvedAgentAccess = {
	agentId?: string;
};

export function resolveAgentAccess(
	runtimeAgentId: unknown,
	fallback?: string,
): ResolvedAgentAccess {
	// Return the normalized tool execution payload expected by callers.
	return {
		agentId: resolveAgentId(runtimeAgentId, fallback),
	};
}

export function hasMissingToolIdentity(access: ResolvedAgentAccess): boolean {
	// Centralize the tool execution fallback value at the boundary of this helper.
	return access.agentId === undefined;
}

export function assertAccessibleScopeForTool(
	scopePolicy: MemoryScopePolicy,
	scope: string,
	access: ResolvedAgentAccess,
): string {
	// Guard guard condition here so the remaining tool execution path works with normalized inputs.
	if (hasMissingToolIdentity(access)) {
		// Surface this invalid tool execution state as an explicit typed failure.
		throw new SnoStationMemError("invalid_scope", `Scope not accessible: ${scope.trim()}`);
	}
	// Apply scope policy before any store lookup can reveal or mutate memory.
	return assertAccessibleScope(scopePolicy, scope, access.agentId);
}

export function resolveReadableScopesForTool(
	scopePolicy: MemoryScopePolicy,
	access: ResolvedAgentAccess,
): string[] {
	// Guard guard condition here so the remaining tool execution path works with normalized inputs.
	if (hasMissingToolIdentity(access)) {
		// Return a stable tool execution list shape for downstream consumers.
		return [];
	}
	// Centralize the tool execution fallback value at the boundary of this helper.
	return scopePolicy.resolveAgentScopes(access.agentId);
}

export function isScopeAccessibleForTool(
	scopePolicy: MemoryScopePolicy,
	scope: string,
	access: ResolvedAgentAccess,
): boolean {
	// Guard guard condition here so the remaining tool execution path works with normalized inputs.
	if (hasMissingToolIdentity(access)) {
		// Centralize the tool execution fallback value at the boundary of this helper.
		return false;
	}
	// Centralize the tool execution fallback value at the boundary of this helper.
	return scopePolicy.isAccessible(scope, access.agentId);
}

export function getDefaultScopeForTool(
	scopePolicy: MemoryScopePolicy,
	access: ResolvedAgentAccess,
): string {
	// Guard guard condition here so the remaining tool execution path works with normalized inputs.
	if (hasMissingToolIdentity(access)) {
		// Surface this invalid tool execution state as an explicit typed failure.
		throw new SnoStationMemError("invalid_scope", "No accessible scope available for memory_store.");
	}
	const defaultScope = scopePolicy.getDefaultScope(access.agentId);
	// Apply scope policy before any store lookup can reveal or mutate memory.
	return assertAccessibleScope(scopePolicy, defaultScope, access.agentId);
}

export function getStoreScopeFilterForTool(
	scopePolicy: MemoryScopePolicy,
	access: ResolvedAgentAccess,
): string[] | undefined {
	// Guard guard condition here so the remaining tool execution path works with normalized inputs.
	if (hasMissingToolIdentity(access)) {
		// Return a stable tool execution list shape for downstream consumers.
		return [];
	}
	// Centralize the tool execution fallback value at the boundary of this helper.
	return scopePolicy.getScopeFilter?.(access.agentId);
}
