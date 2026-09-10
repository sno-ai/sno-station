/** @file scope-helpers.ts
 * @purpose Provides scope identifier builders and filter utility functions.
 * @boundary Stateless helpers around the ScopePolicy interface.
 */

import { createLogger, privateLogReference } from "@snoai/utils/logger";

import { isSystemBypassId, shouldWarnLegacyFallbackBypassId } from "./scope-identity";
import { SCOPE_PATTERNS, type ScopePolicy } from "./scope-policy-types";

const log = createLogger("sno-station-mem:scopes");

export function createAgentScope(agentId: string): string {
	return SCOPE_PATTERNS.AGENT(agentId);
}

export function createCustomScope(name: string): string {
	return SCOPE_PATTERNS.CUSTOM(name);
}

export function createProjectScope(projectId: string): string {
	return SCOPE_PATTERNS.PROJECT(projectId);
}

export function createUserScope(userId: string): string {
	return SCOPE_PATTERNS.USER(userId);
}

export function parseScopeId(scope: string): { type: string; id: string } | undefined {
	if (scope === "global") return { type: "global", id: "" };
	const colonIndex = scope.indexOf(":");
	if (colonIndex === -1) return undefined;
	return {
		type: scope.substring(0, colonIndex),
		id: scope.substring(colonIndex + 1),
	};
}

export function isScopeAccessible(scope: string, allowedScopes: string[]): boolean {
	return allowedScopes.includes(scope);
}

export function resolveScopeFilter(
	scopePolicy: Pick<ScopePolicy, "getAccessibleScopes"> & {
		getScopeFilter?: (agentId?: string) => string[] | undefined;
	},
	agentId?: string,
): string[] | undefined {
	if (typeof scopePolicy.getScopeFilter === "function") {
		return scopePolicy.getScopeFilter(agentId);
	}
	const fallbackScopes = scopePolicy.getAccessibleScopes(agentId);
	if (!isSystemBypassId(agentId) && Array.isArray(fallbackScopes) && fallbackScopes.length === 0) {
		log.warn("resolveScopeFilter: non-bypass agent resolved to empty scope list", {
			agent_reference: privateLogReference(agentId), scope_count: 0,
		}, {
			event_name: "sno_station_mem.scope-helpers.resolvescopefilter.non.bypass.agent.resolved.to.empty.scope.list",
			file: "packages/sno-station-mem/src/engine/security/scope-helpers.ts",
			function: "resolveScopeFilter",
			site_id: "scope-helpers.resolveScopeFilter.0d7f91dae7",
		});
		return [];
	}
	if (isSystemBypassId(agentId) && Array.isArray(fallbackScopes)) {
		const key = String(agentId);
		if (shouldWarnLegacyFallbackBypassId(key)) {
			log.warn("resolveScopeFilter: legacy ScopePolicy lacks getScopeFilter, normalizing to bypass", {
				agent_reference: privateLogReference(key), reason_code: "legacy_scope_policy_bypass",
			}, {
				event_name: "sno_station_mem.scope-helpers.resolvescopefilter.legacy.scopepolicy.lacks.getscopefilter.normalizing",
				file: "packages/sno-station-mem/src/engine/security/scope-helpers.ts",
				function: "resolveScopeFilter",
				site_id: "scope-helpers.resolveScopeFilter.720935590d",
			});
		}
		return undefined;
	}
	return fallbackScopes;
}

export function filterScopesForAgent(
	scopes: string[],
	agentId?: string,
	scopePolicy?: ScopePolicy,
): string[] {
	if (!scopePolicy || !agentId) return scopes;
	return scopes.filter((scope) => scopePolicy.isAccessible(scope, agentId));
}
