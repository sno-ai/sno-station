/** @file memory-scope-policy.ts
 * @purpose Implements mutable memory scope policy management.
 * @boundary Scope config validation and access decisions only.
 */

import {
	isSystemBypassId,
	normalizeAgentAccessMap,
	normalizeExtraAccessibleScopes,
	withOwnReflectionScope,
} from "./scope-identity";
import {
	DEFAULT_SCOPE_CONFIG,
	SCOPE_PATTERNS,
	type ScopeConfig,
	type ScopeDefinition,
	type ScopePolicy,
} from "./scope-policy-types";

export class MemoryScopePolicy implements ScopePolicy {
	private config: ScopeConfig;
	private readonly warn?: (message: string, fields?: Record<string, unknown>) => void;

	constructor(
		config: Partial<ScopeConfig> = {},
		warn?: (message: string, fields?: Record<string, unknown>) => void,
	) {
		this.warn = warn;
		this.config = {
			default: config.default ?? DEFAULT_SCOPE_CONFIG.default,
			definitions: {
				...DEFAULT_SCOPE_CONFIG.definitions,
				...(config.definitions ?? {}),
			},
			agentAccess: {
				...normalizeAgentAccessMap(DEFAULT_SCOPE_CONFIG.agentAccess),
				...normalizeAgentAccessMap(config.agentAccess),
			},
			extraAccessibleScopes: normalizeExtraAccessibleScopes(
				config.extraAccessibleScopes ?? DEFAULT_SCOPE_CONFIG.extraAccessibleScopes,
			),
		};

		if (!this.config.definitions.global) {
			this.config.definitions.global = {
				description: "Shared knowledge across all agents",
			};
		}

		this.validateConfiguration();
	}

	private validateConfiguration(): void {
		if (
			!this.config.definitions[this.config.default] &&
			!this.isBuiltInScope(this.config.default)
		) {
			throw new Error(
				`Default scope '${this.config.default}' not found in definitions or built-in scopes`,
			);
		}

		for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
			const trimmedAgentId = agentId.trim();
			if (isSystemBypassId(trimmedAgentId)) {
				throw new Error(
					`Reserved bypass agent ID '${trimmedAgentId}' cannot have explicit access configured.`,
				);
			}
			for (const scope of scopes) {
				if (!this.config.definitions[scope] && !this.isBuiltInScope(scope)) {
					this.warn?.("invalid_scope_in_agent_access", {
						agentId,
						scope,
					});
				}
			}
		}

		for (const scope of this.config.extraAccessibleScopes) {
			if (!this.config.definitions[scope] && !this.isBuiltInScope(scope)) {
				this.warn?.("invalid_scope_in_extra_accessible_scopes", { scope });
			}
		}
	}

	private isBuiltInScope(scope: string): boolean {
		if (scope === "global") return true;
		const prefixes = ["agent:", "custom:", "project:", "user:", "reflection:"];
		return prefixes.some((p) => scope.startsWith(p) && scope.length > p.length);
	}

	getAccessibleScopes(agentId?: string): string[] {
		const mergeExtraAccessibleScopes = (scopes: string[]): string[] => {
			if (this.config.extraAccessibleScopes.length === 0) return scopes;
			const merged = [...scopes];
			for (const scope of this.config.extraAccessibleScopes) {
				if (!merged.includes(scope)) merged.push(scope);
			}
			return merged;
		};

		if (isSystemBypassId(agentId)) {
			return mergeExtraAccessibleScopes(this.getAllScopes());
		}

		if (!agentId?.trim()) {
			return mergeExtraAccessibleScopes([this.config.default]);
		}

		const normalizedAgentId = agentId.trim();
		if (isSystemBypassId(normalizedAgentId)) {
			return mergeExtraAccessibleScopes(this.getAllScopes());
		}
		const explicitAccess = this.config.agentAccess[normalizedAgentId];
		if (explicitAccess) {
			return mergeExtraAccessibleScopes(withOwnReflectionScope(explicitAccess, normalizedAgentId));
		}

		return mergeExtraAccessibleScopes(
			withOwnReflectionScope(
				["global", SCOPE_PATTERNS.AGENT(normalizedAgentId)],
				normalizedAgentId,
			),
		);
	}

	resolveAgentScopes(agentId?: string): string[] {
		return this.getAccessibleScopes(agentId);
	}

	getScopeFilter(agentId?: string): string[] | undefined {
		if (isSystemBypassId(agentId)) return undefined;
		if (!agentId?.trim()) return [this.config.default];
		const normalizedAgentId = agentId.trim();
		if (isSystemBypassId(normalizedAgentId)) return undefined;
		return this.getAccessibleScopes(normalizedAgentId);
	}

	getDefaultScope(agentId?: string): string {
		if (!agentId?.trim()) return this.config.default;
		const normalizedAgentId = agentId.trim();
		if (isSystemBypassId(normalizedAgentId)) {
			throw new Error(
				`Reserved bypass agent ID '${normalizedAgentId}' must provide an explicit write scope.`,
			);
		}

		const agentScope = SCOPE_PATTERNS.AGENT(normalizedAgentId);
		const accessible = this.getAccessibleScopes(normalizedAgentId);
		return accessible.includes(agentScope) ? agentScope : this.config.default;
	}

	isAccessible(scope: string, agentId?: string): boolean {
		if (isSystemBypassId(agentId)) return this.validateScope(scope);
		return this.getAccessibleScopes(agentId).includes(scope);
	}

	validateScope(scope: string): boolean {
		if (typeof scope !== "string" || scope.trim().length === 0) return false;
		const trimmed = scope.trim();
		return this.config.definitions[trimmed] !== undefined || this.isBuiltInScope(trimmed);
	}

	getAllScopes(): string[] {
		return Object.keys(this.config.definitions);
	}

	getScopeDefinition(scope: string): ScopeDefinition | undefined {
		return this.config.definitions[scope];
	}

	addScopeDefinition(scope: string, definition: ScopeDefinition): void {
		if (!this.validateScopeFormat(scope)) {
			throw new Error(`Invalid scope format: ${scope}`);
		}
		this.config.definitions[scope] = definition;
	}

	removeScopeDefinition(scope: string): boolean {
		if (scope === "global") throw new Error("Cannot remove global scope");
		if (!this.config.definitions[scope]) return false;
		delete this.config.definitions[scope];
		for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
			const filtered = scopes.filter((s) => s !== scope);
			if (filtered.length !== scopes.length) {
				this.config.agentAccess[agentId] = filtered;
			}
		}
		return true;
	}

	setAgentAccess(agentId: string, scopes: string[]): void {
		if (!agentId || typeof agentId !== "string") {
			throw new Error("Invalid agent ID");
		}
		const normalizedAgentId = agentId.trim();
		if (!normalizedAgentId) throw new Error("Invalid agent ID");
		if (isSystemBypassId(normalizedAgentId)) {
			throw new Error(
				`Reserved bypass agent ID cannot have explicit access configured: ${agentId}`,
			);
		}
		for (const scope of scopes) {
			if (!this.validateScope(scope)) throw new Error(`Invalid scope: ${scope}`);
		}
		this.config.agentAccess[normalizedAgentId] = [...scopes];
	}

	removeAgentAccess(agentId: string): boolean {
		const normalizedAgentId = agentId.trim();
		if (!this.config.agentAccess[normalizedAgentId]) return false;
		delete this.config.agentAccess[normalizedAgentId];
		return true;
	}

	setExtraAccessibleScopes(scopes: string[]): void {
		const normalizedScopes = normalizeExtraAccessibleScopes(scopes);
		for (const scope of normalizedScopes) {
			if (!this.validateScope(scope)) throw new Error(`Invalid scope: ${scope}`);
		}
		this.config.extraAccessibleScopes = normalizedScopes;
	}

	private validateScopeFormat(scope: string): boolean {
		if (!scope || typeof scope !== "string") return false;
		const trimmed = scope.trim();
		if (trimmed.length === 0 || trimmed.length > 100) return false;
		return /^[a-zA-Z0-9._:-]+$/.test(trimmed);
	}

	exportConfig(): ScopeConfig {
		return {
			default: this.config.default,
			definitions: JSON.parse(JSON.stringify(this.config.definitions)) as Record<
				string,
				ScopeDefinition
			>,
			agentAccess: JSON.parse(JSON.stringify(this.config.agentAccess)) as Record<string, string[]>,
			extraAccessibleScopes: [...this.config.extraAccessibleScopes],
		};
	}

	importConfig(config: Partial<ScopeConfig>): void {
		if (config.definitions) {
			for (const key of Object.keys(config.definitions)) {
				if (!this.validateScopeFormat(key) && !this.isBuiltInScope(key)) {
					throw new Error(`Invalid scope format in imported config: ${key}`);
				}
			}
		}

		const previous = this.config;
		const next: ScopeConfig = {
			default: config.default ?? previous.default,
			definitions: {
				...previous.definitions,
				...(config.definitions ?? {}),
			},
			agentAccess: {
				...normalizeAgentAccessMap(previous.agentAccess),
				...normalizeAgentAccessMap(config.agentAccess),
			},
			extraAccessibleScopes: normalizeExtraAccessibleScopes(
				config.extraAccessibleScopes ?? previous.extraAccessibleScopes,
			),
		};

		this.config = next;
		try {
			this.validateConfiguration();
		} catch (error) {
			this.config = previous;
			throw error;
		}
	}

	getStats(): {
		totalScopes: number;
		agentsWithCustomAccess: number;
		scopesByType: Record<string, number>;
	} {
		const scopes = this.getAllScopes();
		const scopesByType: Record<string, number> = {
			global: 0,
			agent: 0,
			custom: 0,
			project: 0,
			user: 0,
			reflection: 0,
			other: 0,
		};

		for (const scope of scopes) {
			if (scope === "global") {
				scopesByType.global = (scopesByType.global ?? 0) + 1;
			} else if (scope.startsWith("agent:")) {
				scopesByType.agent = (scopesByType.agent ?? 0) + 1;
			} else if (scope.startsWith("custom:")) {
				scopesByType.custom = (scopesByType.custom ?? 0) + 1;
			} else if (scope.startsWith("project:")) {
				scopesByType.project = (scopesByType.project ?? 0) + 1;
			} else if (scope.startsWith("user:")) {
				scopesByType.user = (scopesByType.user ?? 0) + 1;
			} else if (scope.startsWith("reflection:")) {
				scopesByType.reflection = (scopesByType.reflection ?? 0) + 1;
			} else {
				scopesByType.other = (scopesByType.other ?? 0) + 1;
			}
		}

		return {
			totalScopes: scopes.length,
			agentsWithCustomAccess: Object.keys(this.config.agentAccess).length,
			scopesByType,
		};
	}
}

export function createScopePolicy(
	config: Partial<ScopeConfig> = {},
	warn?: (message: string, fields?: Record<string, unknown>) => void,
): MemoryScopePolicy {
	return new MemoryScopePolicy(config, warn);
}
