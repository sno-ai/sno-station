/** @file scope-policy-types.ts
 * @purpose Defines scope policy contracts, defaults, and identifier patterns.
 * @boundary Types and static scope constants only.
 */

export interface ScopeDefinition {
	description?: string;
	metadata?: Record<string, unknown>;
}

export interface ScopeConfig {
	default: string;
	definitions: Record<string, ScopeDefinition>;
	agentAccess: Record<string, string[]>;
	extraAccessibleScopes: string[];
}

export interface ScopePolicy {
	getAccessibleScopes(agentId?: string): string[];
	/** Store-layer filter: undefined = full bypass, [] = deny-all, array = restrict. */
	getScopeFilter?(agentId?: string): string[] | undefined;
	getDefaultScope(agentId?: string): string;
	isAccessible(scope: string, agentId?: string): boolean;
	validateScope(scope: string): boolean;
	getAllScopes(): string[];
	getScopeDefinition(scope: string): ScopeDefinition | undefined;
}

export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
	default: "global",
	definitions: {
		global: {
			description: "Shared knowledge across all agents",
		},
	},
	agentAccess: {},
	extraAccessibleScopes: [],
};

export const SCOPE_PATTERNS = {
	GLOBAL: "global",
	AGENT: (agentId: string): string => `agent:${agentId}`,
	CUSTOM: (name: string): string => `custom:${name}`,
	REFLECTION: (agentId: string): string => `reflection:agent:${agentId}`,
	PROJECT: (projectId: string): string => `project:${projectId}`,
	USER: (userId: string): string => `user:${userId}`,
} as const;
