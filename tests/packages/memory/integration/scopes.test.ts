/** Real LLM API required. No mocking. Missing keys = FAIL. */

import { afterEach, describe, expect, it } from "vitest";
import {
	_resetLegacyFallbackWarningState,
	createScopePolicy,
	filterScopesForAgent,
	isSystemBypassId,
	parseAgentIdFromSessionKey,
	parseScopeId,
	resolveScopeFilter,
	SCOPE_PATTERNS,
	type ScopePolicy,
} from "../../../../apps/mem-claw/src/security/scopes.ts";

afterEach(() => {
	_resetLegacyFallbackWarningState();
});

// ============================================================================
// System Bypass IDs
// ============================================================================

describe("isSystemBypassId", () => {
	it("returns true for 'system'", () => {
		expect(isSystemBypassId("system")).toBe(true);
	});

	it("returns true for 'undefined'", () => {
		expect(isSystemBypassId("undefined")).toBe(true);
	});

	it("returns false for a normal agent ID", () => {
		expect(isSystemBypassId("agent-alpha")).toBe(false);
	});

	it("returns false for undefined (no argument)", () => {
		expect(isSystemBypassId(undefined)).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isSystemBypassId("")).toBe(false);
	});
});

// ============================================================================
// parseAgentIdFromSessionKey
// ============================================================================

describe("parseAgentIdFromSessionKey", () => {
	it("extracts agent ID from simple session key", () => {
		expect(parseAgentIdFromSessionKey("agent:main")).toBe("main");
	});

	it("extracts agent ID from compound session key", () => {
		expect(parseAgentIdFromSessionKey("agent:main:discord:channel:123")).toBe("main");
	});

	it("returns undefined for non-agent session key", () => {
		expect(parseAgentIdFromSessionKey("user:alice")).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(parseAgentIdFromSessionKey(undefined)).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(parseAgentIdFromSessionKey("")).toBeUndefined();
	});

	it("returns undefined for bypass ID 'system'", () => {
		expect(parseAgentIdFromSessionKey("agent:system")).toBeUndefined();
	});

	it("returns undefined for bypass ID 'undefined'", () => {
		expect(parseAgentIdFromSessionKey("agent:undefined")).toBeUndefined();
	});

	it("trims whitespace from session key", () => {
		expect(parseAgentIdFromSessionKey("  agent:main  ")).toBe("main");
	});

	it("returns undefined when agent segment is empty after 'agent:'", () => {
		expect(parseAgentIdFromSessionKey("agent:")).toBeUndefined();
	});
});

// ============================================================================
// Reflection Scope Auto-Grant
// ============================================================================

describe("reflection scope auto-grant", () => {
	it("auto-grants reflection scope for agent with explicit access", () => {
		const mgr = createScopePolicy({
			default: "global",
			definitions: {
				global: { description: "Global" },
				"custom:team": { description: "Team scope" },
			},
			agentAccess: {
				alpha: ["global", "custom:team"],
			},
		});

		const scopes = mgr.getAccessibleScopes("alpha");
		expect(scopes).toContain("reflection:agent:alpha");
		expect(scopes).toContain("global");
		expect(scopes).toContain("custom:team");
	});

	it("auto-grants reflection scope for agent with default access", () => {
		const mgr = createScopePolicy();
		const scopes = mgr.getAccessibleScopes("beta");

		expect(scopes).toContain("reflection:agent:beta");
		expect(scopes).toContain("global");
		expect(scopes).toContain("agent:beta");
	});

	it("does not duplicate reflection scope if already present", () => {
		const mgr = createScopePolicy({
			default: "global",
			definitions: {
				global: { description: "Global" },
				"reflection:agent:gamma": { description: "Gamma reflection" },
			},
			agentAccess: {
				gamma: ["global", "reflection:agent:gamma"],
			},
		});

		const scopes = mgr.getAccessibleScopes("gamma");
		const reflectionCount = scopes.filter((s) => s === "reflection:agent:gamma").length;
		expect(reflectionCount).toBe(1);
	});
});

// ============================================================================
// getScopeFilter semantics
// ============================================================================

describe("getScopeFilter semantics", () => {
	it("returns undefined (bypass) for system agent ID", () => {
		const mgr = createScopePolicy();
		expect(mgr.getScopeFilter("system")).toBeUndefined();
	});

	it("returns undefined (bypass) for padded system agent ID", () => {
		const mgr = createScopePolicy();
		expect(mgr.getScopeFilter(" system ")).toBeUndefined();
	});

	it("returns default-scope filter for missing agent ID", () => {
		const mgr = createScopePolicy();
		expect(mgr.getScopeFilter(undefined)).toEqual(["global"]);
	});

	it("returns undefined (bypass) for 'undefined' string", () => {
		const mgr = createScopePolicy();
		expect(mgr.getScopeFilter("undefined")).toBeUndefined();
	});

	it("returns accessible scopes array for normal agent", () => {
		const mgr = createScopePolicy({
			default: "global",
			definitions: {
				global: { description: "Global" },
				"custom:data": { description: "Data scope" },
			},
			agentAccess: {
				worker: ["global", "custom:data"],
			},
		});

		const filter = mgr.getScopeFilter("worker");
		expect(filter).toBeDefined();
		expect(filter).toContain("global");
		expect(filter).toContain("custom:data");
		expect(filter).toContain("reflection:agent:worker");
	});
});

// ============================================================================
// getDefaultScope
// ============================================================================

describe("getDefaultScope", () => {
	it("returns config default for undefined agent ID", () => {
		const mgr = createScopePolicy({ default: "global" });
		expect(mgr.getDefaultScope(undefined)).toBe("global");
	});

	it("returns agent scope when agent has access to it", () => {
		const mgr = createScopePolicy();
		// Default access includes agent:<id>
		expect(mgr.getDefaultScope("main")).toBe("agent:main");
	});

	it("throws for system bypass agent ID", () => {
		const mgr = createScopePolicy();
		expect(() => mgr.getDefaultScope("system")).toThrow(/Reserved bypass agent ID/);
	});

	it("returns config default when agent has only custom scopes without agent: prefix", () => {
		const mgr = createScopePolicy({
			default: "global",
			definitions: {
				global: { description: "Global" },
				"custom:shared": { description: "Shared" },
			},
			agentAccess: {
				reader: ["custom:shared"],
			},
		});

		expect(mgr.getDefaultScope("reader")).toBe("global");
	});
});

// ============================================================================
// isAccessible
// ============================================================================

describe("isAccessible", () => {
	it("system agent can access any valid scope", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:secret": { description: "Secret" },
			},
		});

		expect(mgr.isAccessible("global", "system")).toBe(true);
		expect(mgr.isAccessible("custom:secret", "system")).toBe(true);
	});

	it("normal agent can only access its accessible scopes", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:restricted": { description: "Restricted" },
			},
			agentAccess: {
				limited: ["global"],
			},
		});

		expect(mgr.isAccessible("global", "limited")).toBe(true);
		expect(mgr.isAccessible("custom:restricted", "limited")).toBe(false);
	});

	it("validates scope format for system agent", () => {
		const mgr = createScopePolicy();
		// Empty string is not a valid scope
		expect(mgr.isAccessible("", "system")).toBe(false);
	});
});

// ============================================================================
// validateScope
// ============================================================================

describe("validateScope", () => {
	it("accepts defined scopes", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "G" },
				"custom:data": { description: "D" },
			},
		});

		expect(mgr.validateScope("global")).toBe(true);
		expect(mgr.validateScope("custom:data")).toBe(true);
	});

	it("accepts built-in scope patterns even without definitions", () => {
		const mgr = createScopePolicy();
		expect(mgr.validateScope("agent:foo")).toBe(true);
		expect(mgr.validateScope("project:bar")).toBe(true);
		expect(mgr.validateScope("user:baz")).toBe(true);
		expect(mgr.validateScope("reflection:agent:foo")).toBe(true);
	});

	it("rejects empty or whitespace-only strings", () => {
		const mgr = createScopePolicy();
		expect(mgr.validateScope("")).toBe(false);
		expect(mgr.validateScope("   ")).toBe(false);
	});
});

// ============================================================================
// addScopeDefinition / removeScopeDefinition lifecycle
// ============================================================================

describe("addScopeDefinition / removeScopeDefinition lifecycle", () => {
	it("adds a new scope definition and it becomes visible", () => {
		const mgr = createScopePolicy();

		mgr.addScopeDefinition("custom:analytics", {
			description: "Analytics scope",
		});

		expect(mgr.getAllScopes()).toContain("custom:analytics");
		expect(mgr.getScopeDefinition("custom:analytics")).toEqual({
			description: "Analytics scope",
		});
	});

	it("rejects invalid scope format", () => {
		const mgr = createScopePolicy();

		expect(() =>
			mgr.addScopeDefinition("invalid scope with spaces", {
				description: "Bad",
			}),
		).toThrow(/Invalid scope format/);
	});

	it("rejects scope longer than 100 characters", () => {
		const mgr = createScopePolicy();
		const longScope = `custom:${"a".repeat(100)}`;

		expect(() => mgr.addScopeDefinition(longScope, { description: "Too long" })).toThrow(
			/Invalid scope format/,
		);
	});

	it("removes a scope definition and cleans up agent access references", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:temp": { description: "Temporary" },
			},
			agentAccess: {
				worker: ["global", "custom:temp"],
			},
		});

		const removed = mgr.removeScopeDefinition("custom:temp");
		expect(removed).toBe(true);
		expect(mgr.getAllScopes()).not.toContain("custom:temp");

		// Agent access should no longer include the removed scope
		const workerScopes = mgr.getAccessibleScopes("worker");
		expect(workerScopes).not.toContain("custom:temp");
		expect(workerScopes).toContain("global");
	});

	it("returns false when removing a non-existent scope", () => {
		const mgr = createScopePolicy();
		expect(mgr.removeScopeDefinition("nonexistent:scope")).toBe(false);
	});

	it("throws when trying to remove the global scope", () => {
		const mgr = createScopePolicy();
		expect(() => mgr.removeScopeDefinition("global")).toThrow(/Cannot remove global scope/);
	});
});

// ============================================================================
// setAgentAccess / removeAgentAccess
// ============================================================================

describe("setAgentAccess / removeAgentAccess", () => {
	it("sets explicit agent access and getAccessibleScopes reflects it", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:vip": { description: "VIP" },
			},
		});

		mgr.setAgentAccess("vip-agent", ["global", "custom:vip"]);

		const scopes = mgr.getAccessibleScopes("vip-agent");
		expect(scopes).toContain("global");
		expect(scopes).toContain("custom:vip");
		expect(scopes).toContain("reflection:agent:vip-agent");
	});

	it("rejects setting access for system bypass IDs", () => {
		const mgr = createScopePolicy();

		expect(() => mgr.setAgentAccess("system", ["global"])).toThrow(/Reserved bypass agent ID/);
		expect(() => mgr.setAgentAccess("undefined", ["global"])).toThrow(/Reserved bypass agent ID/);
	});

	it("rejects setting access with invalid scope", () => {
		const mgr = createScopePolicy();

		expect(() => mgr.setAgentAccess("agent-x", ["global", "totally-invalid"])).toThrow(
			/Invalid scope/,
		);
	});

	it("rejects empty or invalid agent ID", () => {
		const mgr = createScopePolicy();

		expect(() => mgr.setAgentAccess("", ["global"])).toThrow(/Invalid agent ID/);
		expect(() => mgr.setAgentAccess("   ", ["global"])).toThrow(/Invalid agent ID/);
	});

	it("removes agent access and reverts to default behavior", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:special": { description: "Special" },
			},
			agentAccess: {
				"temp-agent": ["global", "custom:special"],
			},
		});

		const removed = mgr.removeAgentAccess("temp-agent");
		expect(removed).toBe(true);

		// After removal, agent should get default scopes (global + agent:temp-agent + reflection)
		const scopes = mgr.getAccessibleScopes("temp-agent");
		expect(scopes).toContain("global");
		expect(scopes).toContain("agent:temp-agent");
		expect(scopes).not.toContain("custom:special");
	});

	it("returns false when removing non-existent agent access", () => {
		const mgr = createScopePolicy();
		expect(mgr.removeAgentAccess("ghost-agent")).toBe(false);
	});
});

// ============================================================================
// setExtraAccessibleScopes
// ============================================================================

describe("setExtraAccessibleScopes", () => {
	it("rejects unregistered non-built-in scopes", () => {
		const mgr = createScopePolicy();

		expect(() => mgr.setExtraAccessibleScopes(["unregistered"])).toThrow(/Invalid scope/);
	});

	it("accepts defined and built-in scopes", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:shared": { description: "Shared" },
			},
		});

		mgr.setExtraAccessibleScopes(["custom:shared", "project:atlas"]);

		const scopes = mgr.getAccessibleScopes("worker");
		expect(scopes).toContain("custom:shared");
		expect(scopes).toContain("project:atlas");
	});
});

// ============================================================================
// getStats
// ============================================================================

describe("getStats", () => {
	it("counts scopes by type correctly", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"agent:alpha": { description: "Alpha agent" },
				"agent:beta": { description: "Beta agent" },
				"custom:team": { description: "Team" },
				"project:acme": { description: "Acme project" },
				"user:alice": { description: "Alice" },
				"reflection:agent:alpha": { description: "Alpha reflection" },
			},
			agentAccess: {
				alpha: ["global", "agent:alpha"],
				beta: ["global", "agent:beta"],
			},
		});

		const stats = mgr.getStats();
		expect(stats.totalScopes).toBe(7);
		expect(stats.agentsWithCustomAccess).toBe(2);
		expect(stats.scopesByType.global).toBe(1);
		expect(stats.scopesByType.agent).toBe(2);
		expect(stats.scopesByType.custom).toBe(1);
		expect(stats.scopesByType.project).toBe(1);
		expect(stats.scopesByType.user).toBe(1);
		expect(stats.scopesByType.reflection).toBe(1);
	});

	it("reports zero agents when no custom access configured", () => {
		const mgr = createScopePolicy();
		const stats = mgr.getStats();

		expect(stats.agentsWithCustomAccess).toBe(0);
		expect(stats.totalScopes).toBeGreaterThanOrEqual(1); // at least global
	});
});

// ============================================================================
// importConfig rollback on failure
// ============================================================================

describe("importConfig rollback on failure", () => {
	it("rolls back to previous config when validation fails", () => {
		const mgr = createScopePolicy({
			default: "global",
			definitions: {
				global: { description: "Global" },
				"custom:stable": { description: "Stable scope" },
			},
		});

		// Attempt to import a config with a default scope that doesn't exist
		expect(() =>
			mgr.importConfig({
				default: "nonexistent-default",
				definitions: {},
			}),
		).toThrow(/Default scope.*not found in definitions/);

		// Original config should be intact
		expect(mgr.getAllScopes()).toContain("global");
		expect(mgr.getAllScopes()).toContain("custom:stable");
		expect(mgr.getAccessibleScopes("system")).toContain("global");
	});

	it("rolls back when bypass agent has explicit access in imported config", () => {
		const mgr = createScopePolicy({
			default: "global",
			definitions: { global: { description: "Global" } },
		});

		expect(() =>
			mgr.importConfig({
				agentAccess: {
					system: ["global"],
				},
			}),
		).toThrow(/Reserved bypass agent ID/);

		// Config should not have changed
		const exported = mgr.exportConfig();
		expect(exported.agentAccess).not.toHaveProperty("system");
	});

	it("successfully imports valid config", () => {
		const mgr = createScopePolicy();

		mgr.importConfig({
			definitions: {
				"custom:imported": { description: "Imported scope" },
			},
			agentAccess: {
				"new-agent": ["global", "custom:imported"],
			},
		});

		expect(mgr.getAllScopes()).toContain("custom:imported");
		const scopes = mgr.getAccessibleScopes("new-agent");
		expect(scopes).toContain("custom:imported");
		expect(scopes).toContain("global");
	});
});

// ============================================================================
// exportConfig / importConfig round-trip
// ============================================================================

describe("exportConfig deep-clone isolation", () => {
	it("exported config is a deep clone, mutations do not affect manager", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:data": { description: "Data" },
			},
			agentAccess: {
				agent1: ["global", "custom:data"],
			},
		});

		const exported = mgr.exportConfig();

		// Mutate the exported object
		exported.definitions["custom:data"] = { description: "MUTATED" };
		exported.agentAccess.agent1 = [];

		// Manager should be unaffected
		expect(mgr.getScopeDefinition("custom:data")?.description).toBe("Data");
		const scopes = mgr.getAccessibleScopes("agent1");
		expect(scopes).toContain("custom:data");
	});
});

// ============================================================================
// resolveScopeFilter utility
// ============================================================================

describe("resolveScopeFilter", () => {
	it("delegates to getScopeFilter when available", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:x": { description: "X" },
			},
			agentAccess: {
				agent1: ["global", "custom:x"],
			},
		});

		const filter = resolveScopeFilter(mgr, "agent1");
		expect(filter).toContain("global");
		expect(filter).toContain("custom:x");
	});

	it("returns undefined for system bypass via getScopeFilter", () => {
		const mgr = createScopePolicy();
		expect(resolveScopeFilter(mgr, "system")).toBeUndefined();
	});

	it("falls back to getAccessibleScopes when getScopeFilter is missing", () => {
		// Simulate a legacy ScopePolicy that lacks getScopeFilter
		const legacyManager: Pick<ScopePolicy, "getAccessibleScopes"> = {
			getAccessibleScopes: (agentId?: string) => {
				if (!agentId) return ["global"];
				return ["global", `agent:${agentId}`];
			},
		};

		const filter = resolveScopeFilter(legacyManager, "agent-x");
		expect(filter).toContain("global");
		expect(filter).toContain("agent:agent-x");
	});

	it("normalizes to undefined for system bypass on legacy manager (no getScopeFilter)", () => {
		const legacyManager: Pick<ScopePolicy, "getAccessibleScopes"> = {
			getAccessibleScopes: () => ["global"],
		};

		const filter = resolveScopeFilter(legacyManager, "system");
		expect(filter).toBeUndefined();
	});

	it("returns empty array for non-bypass agent with empty scopes on legacy manager", () => {
		const legacyManager: Pick<ScopePolicy, "getAccessibleScopes"> = {
			getAccessibleScopes: () => [],
		};

		const filter = resolveScopeFilter(legacyManager, "agent-no-access");
		expect(filter).toEqual([]);
	});
});

// ============================================================================
// filterScopesForAgent utility
// ============================================================================

describe("filterScopesForAgent", () => {
	it("filters scopes based on agent accessibility", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:private": { description: "Private" },
				"custom:public": { description: "Public" },
			},
			agentAccess: {
				reader: ["global", "custom:public"],
			},
		});

		const filtered = filterScopesForAgent(
			["global", "custom:private", "custom:public"],
			"reader",
			mgr,
		);

		expect(filtered).toContain("global");
		expect(filtered).toContain("custom:public");
		expect(filtered).not.toContain("custom:private");
	});

	it("returns all scopes when no scope manager provided", () => {
		const scopes = ["a", "b", "c"];
		expect(filterScopesForAgent(scopes, "agent")).toEqual(scopes);
	});

	it("returns all scopes when no agent ID provided", () => {
		const mgr = createScopePolicy();
		const scopes = ["global", "custom:x"];
		expect(filterScopesForAgent(scopes, undefined, mgr)).toEqual(scopes);
	});
});

// ============================================================================
// parseScopeId utility
// ============================================================================

describe("parseScopeId", () => {
	it("parses 'global' scope", () => {
		expect(parseScopeId("global")).toEqual({ type: "global", id: "" });
	});

	it("parses agent scope", () => {
		expect(parseScopeId("agent:main")).toEqual({ type: "agent", id: "main" });
	});

	it("parses custom scope", () => {
		expect(parseScopeId("custom:team")).toEqual({
			type: "custom",
			id: "team",
		});
	});

	it("parses project scope", () => {
		expect(parseScopeId("project:acme")).toEqual({
			type: "project",
			id: "acme",
		});
	});

	it("parses user scope", () => {
		expect(parseScopeId("user:alice")).toEqual({ type: "user", id: "alice" });
	});

	it("parses reflection scope (nested colon)", () => {
		const result = parseScopeId("reflection:agent:main");
		expect(result).toEqual({ type: "reflection", id: "agent:main" });
	});

	it("returns undefined for a scope without colon (not global)", () => {
		expect(parseScopeId("unknown")).toBeUndefined();
	});
});

// ============================================================================
// Constructor validation — rejection of bypass IDs in agentAccess
// ============================================================================

describe("constructor validation", () => {
	it("throws if agentAccess contains 'system'", () => {
		expect(() =>
			createScopePolicy({
				agentAccess: {
					system: ["global"],
				},
			}),
		).toThrow(/Reserved bypass agent ID/);
	});

	it("throws if agentAccess contains 'undefined'", () => {
		expect(() =>
			createScopePolicy({
				agentAccess: {
					undefined: ["global"],
				},
			}),
		).toThrow(/Reserved bypass agent ID/);
	});

	it("throws if default scope is not in definitions", () => {
		expect(() =>
			createScopePolicy({
				default: "nonexistent",
				definitions: {
					global: { description: "Global" },
				},
			}),
		).toThrow(/Default scope.*not found/);
	});

	it("warns about invalid scopes in agentAccess but does not throw", () => {
		const warnings: Array<{
			message: string;
			fields?: Record<string, unknown>;
		}> = [];

		const mgr = createScopePolicy(
			{
				definitions: {
					global: { description: "Global" },
				},
				agentAccess: {
					agent1: ["global", "nonexistent-scope"],
				},
			},
			(message, fields) => warnings.push({ message, fields }),
		);

		expect(mgr).toBeDefined();
		expect(warnings.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// getAccessibleScopes — system/no-agent returns all defined scopes
// ============================================================================

describe("getAccessibleScopes system/no-agent behavior", () => {
	it("system agent gets all defined scopes", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:a": { description: "A" },
				"custom:b": { description: "B" },
			},
		});

		const scopes = mgr.getAccessibleScopes("system");
		expect(scopes).toContain("global");
		expect(scopes).toContain("custom:a");
		expect(scopes).toContain("custom:b");
	});

	it("no agent ID returns only the default scope", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:shared": { description: "Shared" },
			},
		});

		const scopes = mgr.getAccessibleScopes(undefined);
		expect(scopes).toEqual(["global"]);
	});

	it("'undefined' string bypass returns all defined scopes", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:x": { description: "X" },
			},
		});

		const scopes = mgr.getAccessibleScopes("undefined");
		expect(scopes).toContain("global");
		expect(scopes).toContain("custom:x");
	});
});

// ============================================================================
// Agent access normalization (whitespace trimming)
// ============================================================================

describe("agent access normalization", () => {
	it("trims agent ID whitespace in agentAccess config", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:data": { description: "Data" },
			},
			agentAccess: {
				"  padded-agent  ": ["global", "custom:data"],
			},
		});

		// Trimmed ID should work
		const scopes = mgr.getAccessibleScopes("padded-agent");
		expect(scopes).toContain("global");
		expect(scopes).toContain("custom:data");
	});
});

// ============================================================================
// SCOPE_PATTERNS
// ============================================================================

describe("SCOPE_PATTERNS factory functions", () => {
	it("GLOBAL is 'global'", () => {
		expect(SCOPE_PATTERNS.GLOBAL).toBe("global");
	});

	it("AGENT produces 'agent:<id>'", () => {
		expect(SCOPE_PATTERNS.AGENT("main")).toBe("agent:main");
	});

	it("CUSTOM produces 'custom:<name>'", () => {
		expect(SCOPE_PATTERNS.CUSTOM("team")).toBe("custom:team");
	});

	it("REFLECTION produces 'reflection:agent:<id>'", () => {
		expect(SCOPE_PATTERNS.REFLECTION("main")).toBe("reflection:agent:main");
	});

	it("PROJECT produces 'project:<id>'", () => {
		expect(SCOPE_PATTERNS.PROJECT("acme")).toBe("project:acme");
	});

	it("USER produces 'user:<id>'", () => {
		expect(SCOPE_PATTERNS.USER("alice")).toBe("user:alice");
	});
});

// ============================================================================
// Bug-hunter findings — edge cases
// ============================================================================

describe("whitespace-padded bypass IDs", () => {
	it("' system ' is treated as bypass in getAccessibleScopes", () => {
		const mgr = createScopePolicy({ definitions: { global: {} } });
		const scopes = mgr.getAccessibleScopes(" system ");
		// Should return all scopes (bypass), not create "agent:system"
		expect(scopes).toContain("global");
		expect(scopes.some((s) => s.startsWith("agent:"))).toBe(false);
	});

	it("whitespace-only agentId falls back to the default scope", () => {
		const mgr = createScopePolicy({ definitions: { global: {} } });
		const scopes = mgr.getAccessibleScopes("   ");
		expect(scopes).toEqual(["global"]);
	});

	it("getScopeFilter returns the default scope for whitespace-only agentId", () => {
		const mgr = createScopePolicy({ definitions: { global: {} } });
		expect(mgr.getScopeFilter("   ")).toEqual(["global"]);
	});

	it("getDefaultScope returns config default for whitespace-only agentId", () => {
		const mgr = createScopePolicy({ definitions: { global: {} } });
		expect(mgr.getDefaultScope("   ")).toBe("global");
	});
});

describe("empty-ID built-in scope validation", () => {
	it("rejects 'agent:' with no ID", () => {
		const mgr = createScopePolicy();
		expect(mgr.validateScope("agent:")).toBe(false);
	});

	it("rejects 'custom:' with no ID", () => {
		const mgr = createScopePolicy();
		expect(mgr.validateScope("custom:")).toBe(false);
	});

	it("rejects 'reflection:' with no ID", () => {
		const mgr = createScopePolicy();
		expect(mgr.validateScope("reflection:")).toBe(false);
	});

	it("accepts 'agent:main' with ID", () => {
		const mgr = createScopePolicy();
		expect(mgr.validateScope("agent:main")).toBe(true);
	});
});
