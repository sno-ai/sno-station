/**
 * Both skill category maps carry every unit and every deployed family member of the skills-core
 * registry under the registry's category, so no deployed squad skill uploads as "other".
 * EXPECTED lists each registry unit and each member its folder deploys (a `split` member keeps its own).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_CATEGORIES } from "../../../../packages/memory/config/skill-categories.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const JSON_MAP = "apps/mem-hermes/sno-mem-hermes/skill_categories.json";

const EXPECTED: Record<string, string> = {
	"agentic-walkthrough": "J", e2e: "J", "e2e-red-triage": "J", "e2e-environment-preflight": "M",
	"first-principles-review": "J", "owner-intent-audit": "J", "peer-review": "J", "less-is-more": "J",
	medic: "M", "sno-cli": "M",
	handoff: "S", heartbeat: "S", "join-talk": "S", reach: "S", "rotate-agent": "S", "subscription-quota-check": "S",
	"rem-reflect": "R",
	pl: "T", "pl-analyze": "R", "pl-audit": "T", "pl-dispatch": "T", "pl-env": "T", "pl-watch": "T",
	cos: "T", "cos-evolve": "R", "cos-review": "T", "cos-watch": "T",
	"agentic-time-estimate": "H", "away-brief": "H", "catch-report": "H",
	charter: "T", deliver: "T",
};

const hermes = JSON.parse(readFileSync(join(repoRoot, JSON_MAP), "utf8")) as Record<string, string>;

describe("skill category maps follow the skills-core registry", () => {
	for (const [label, map] of [["skill-categories.ts", SKILL_CATEGORIES as Record<string, string>], ["skill_categories.json", hermes]] as const) {
		it(`${label} gives every registry unit and member its category`, () => {
			for (const [name, category] of Object.entries(EXPECTED)) expect([name, map[name]]).toEqual([name, category]);
		});

		it(`${label} never maps cos, pl, pl-analyze, cos-evolve, deliver or charter to other`, () => {
			for (const name of ["cos", "pl", "pl-analyze", "cos-evolve", "deliver", "charter"]) {
				expect(map[name]).toBeDefined();
				expect(map[name]).not.toBe("other");
			}
		});
	}

	it("the two files agree", () => {
		expect(hermes).toEqual(SKILL_CATEGORIES);
	});
});
