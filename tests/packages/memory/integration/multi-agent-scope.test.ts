/** Real LLM API required. No mocking. Missing keys = FAIL. */

import { describe, expect, it } from "vitest";
import {
	applyMultiAgentScopes,
	parseMultiAgentScopes,
} from "../../../../apps/mem-claw/src/security/multi-agent-scope.ts";
import { createScopePolicy } from "../../../../apps/mem-claw/src/security/scopes.ts";

// ============================================================================
// parseMultiAgentScopes — env var parsing
// ============================================================================

describe("parseMultiAgentScopes", () => {
	it("returns empty array for undefined", () => {
		expect(parseMultiAgentScopes(undefined)).toEqual([]);
	});

	it("returns empty array for empty string", () => {
		expect(parseMultiAgentScopes("")).toEqual([]);
	});

	it("parses single scope", () => {
		expect(parseMultiAgentScopes("team:alpha")).toEqual(["team:alpha"]);
	});

	it("parses comma-separated scopes", () => {
		expect(parseMultiAgentScopes("team:alpha,team:beta")).toEqual([
			"team:alpha",
			"team:beta",
		]);
	});

	it("trims whitespace around scope names", () => {
		expect(parseMultiAgentScopes("  team:alpha , team:beta  ")).toEqual([
			"team:alpha",
			"team:beta",
		]);
	});

	it("filters out empty segments from trailing commas", () => {
		expect(parseMultiAgentScopes("team:alpha,,team:beta,")).toEqual([
			"team:alpha",
			"team:beta",
		]);
	});

	it("filters out whitespace-only segments", () => {
		expect(parseMultiAgentScopes("team:alpha,   ,team:beta")).toEqual([
			"team:alpha",
			"team:beta",
		]);
	});
});

// ============================================================================
// applyMultiAgentScopes — scope registration + getAccessibleScopes wrapping
// ============================================================================

describe("applyMultiAgentScopes", () => {
	it("does nothing when scopes array is empty", () => {
		const mgr = createScopePolicy();
		const scopesBefore = mgr.getAllScopes();

		applyMultiAgentScopes(mgr, []);

		expect(mgr.getAllScopes()).toEqual(scopesBefore);
	});

	it("registers new scope definitions for unknown scopes", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
			},
		});

		applyMultiAgentScopes(mgr, ["team:research", "team:engineering"]);

		expect(mgr.getScopeDefinition("team:research")).toBeDefined();
		expect(mgr.getScopeDefinition("team:research")?.description).toContain(
			"Multi-agent",
		);
		expect(mgr.getScopeDefinition("team:engineering")).toBeDefined();
	});

	it("does not overwrite existing scope definitions", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"custom:existing": { description: "Original description" },
			},
		});

		applyMultiAgentScopes(mgr, ["custom:existing"]);

		expect(mgr.getScopeDefinition("custom:existing")?.description).toBe(
			"Original description",
		);
	});

	it("wraps getAccessibleScopes to include team scopes for normal agents", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
			},
			agentAccess: {
				worker: ["global"],
			},
		});

		applyMultiAgentScopes(mgr, ["team:shared"]);

		const scopes = mgr.getAccessibleScopes("worker");
		expect(scopes).toContain("global");
		expect(scopes).toContain("team:shared");
		expect(scopes).toContain("reflection:agent:worker");
	});

	it("wraps getAccessibleScopes to include team scopes for default-access agents", () => {
		const mgr = createScopePolicy();

		applyMultiAgentScopes(mgr, ["team:all-hands"]);

		const scopes = mgr.getAccessibleScopes("newcomer");
		expect(scopes).toContain("global");
		expect(scopes).toContain("agent:newcomer");
		expect(scopes).toContain("team:all-hands");
	});

	it("does not duplicate scopes already in agent access", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
				"team:shared": { description: "Shared" },
			},
			agentAccess: {
				agent1: ["global", "team:shared"],
			},
		});

		applyMultiAgentScopes(mgr, ["team:shared"]);

		const scopes = mgr.getAccessibleScopes("agent1");
		const sharedCount = scopes.filter((s) => s === "team:shared").length;
		expect(sharedCount).toBe(1);
	});

	it("team scopes are visible to system/bypass agents", () => {
		const mgr = createScopePolicy();

		applyMultiAgentScopes(mgr, ["team:ops"]);

		// System bypass returns all defined scopes — team:ops should be registered
		const systemScopes = mgr.getAccessibleScopes("system");
		expect(systemScopes).toContain("team:ops");
	});

	it("affects isAccessible via the getAccessibleScopes wrapper", () => {
		const mgr = createScopePolicy({
			definitions: {
				global: { description: "Global" },
			},
		});

		// Before applying, agent cannot access team:secret
		expect(mgr.isAccessible("team:data", "agent-x")).toBe(false);

		applyMultiAgentScopes(mgr, ["team:data"]);

		// After applying, agent can access team:data
		expect(mgr.isAccessible("team:data", "agent-x")).toBe(true);
	});

	it("affects getScopeFilter via the getAccessibleScopes wrapper", () => {
		const mgr = createScopePolicy();

		applyMultiAgentScopes(mgr, ["team:metrics"]);

		const filter = mgr.getScopeFilter("analyst");
		expect(filter).toContain("team:metrics");
	});

	it("multiple team scopes are all included", () => {
		const mgr = createScopePolicy();

		applyMultiAgentScopes(mgr, ["team:a", "team:b", "team:c"]);

		const scopes = mgr.getAccessibleScopes("any-agent");
		expect(scopes).toContain("team:a");
		expect(scopes).toContain("team:b");
		expect(scopes).toContain("team:c");
	});

	it("replaces previously applied team scopes instead of stacking wrappers", () => {
		const mgr = createScopePolicy();

		applyMultiAgentScopes(mgr, ["team:alpha"]);
		applyMultiAgentScopes(mgr, ["team:beta"]);

		const scopes = mgr.getAccessibleScopes("any-agent");
		expect(scopes).toContain("team:beta");
		expect(scopes).not.toContain("team:alpha");
	});
});
