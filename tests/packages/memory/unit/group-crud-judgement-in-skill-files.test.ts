import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";


const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SKILLS = join(REPO_ROOT, "packages/memory/skills");
const ENTITY_IDENTITY = join(SKILLS, "resolve-entity-identity/SKILL.md");
const EXTRACTION = join(SKILLS, "extract-atomic-memory/SKILL.md");

function read(path: string): string {
	return readFileSync(path, "utf8");
}

describe("The judgement text is in skill files", () => {
	it("carries the entity-identity rule and its doubt rule in a skill file", () => {
		const identity = read(ENTITY_IDENTITY);
		expect(identity.length, "the entity-identity skill file is empty").toBeGreaterThan(200);
		expect(identity.toLowerCase()).toContain("new");
		expect(
			identity.toLowerCase(),
			"the rule does not say what to answer when the model is in doubt",
		).toMatch(/doubt|unsure|not certain|uncertain/);
	});

	it("carries the ended-preference rule in the extraction skill file", () => {
		const extraction = read(EXTRACTION);
		expect(
			extraction,
			"the extraction skill does not name the field that says a claim states an ending",
		).toContain("ends_current");
	});
});
