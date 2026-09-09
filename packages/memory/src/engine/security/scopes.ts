/** @file scopes.ts
 * @purpose Public compatibility exports for memory scope policy.
 * @boundary Keep existing imports stable while focused modules own behavior.
 */

export {
	createScopePolicy,
	MemoryScopePolicy,
} from "./memory-scope-policy";
export {
	createAgentScope,
	createCustomScope,
	createProjectScope,
	createUserScope,
	filterScopesForAgent,
	isScopeAccessible,
	parseScopeId,
	resolveScopeFilter,
} from "./scope-helpers";
export {
	_resetLegacyFallbackWarningState,
	isSystemBypassId,
	parseAgentIdFromSessionKey,
} from "./scope-identity";
export {
	DEFAULT_SCOPE_CONFIG,
	SCOPE_PATTERNS,
	type ScopeConfig,
	type ScopeDefinition,
	type ScopePolicy,
} from "./scope-policy-types";
