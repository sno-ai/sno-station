/** @file PRD 150 QCG-10 — every judgement lives in a skill file the model reads (REQ-10).
 *
 * This repository has a standing law: judgement goes in text the model reads; the runtime stays
 * mechanical. A rule frozen inside a TypeScript template literal is unreadable by the one reader
 * who needs it, and a phrase list in engine code is the same defect wearing a different coat — it
 * decides meaning with string mechanics, which no amount of patching makes accurate.
 *
 * So this file asserts two things: the three rules this change owns are in `.md` files whose bytes
 * reach the prompt, and the engine gained no rule that decides membership, identity or closure.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { REM_UPDATE_JUDGMENT_SKILL } from "../../../../apps/mem-claw/src/sidecar/rem-update-judgment-skill.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SKILLS = join(REPO_ROOT, "apps/mem-claw/skills");
const GROUP_CLOSURE = join(SKILLS, "judge-group-closure/SKILL.md");
const ENTITY_IDENTITY = join(SKILLS, "resolve-entity-identity/SKILL.md");
const EXTRACTION = join(SKILLS, "extract-atomic-memory/SKILL.md");
const JUDGMENT_MODULE = join(REPO_ROOT, "apps/mem-claw/src/sidecar/rem-update-judgment-skill.ts");

function read(path: string): string {
	return readFileSync(path, "utf8");
}

/**
 * Source with comments removed.
 *
 * A comment naming an English phrase is prose about a defect, not a rule that fires. An earlier
 * version of this check read whole files and went red on a comment, which is a false alarm that
 * teaches the next reader to ignore it.
 */
function executableLines(path: string): string {
	return read(path)
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			return (
				trimmed.length > 0 &&
				!trimmed.startsWith("//") &&
				!trimmed.startsWith("*") &&
				!trimmed.startsWith("/*")
			);
		})
		.join("\n");
}

/** Every TypeScript source of the engine and the shared REM package. */
function engineSources(): string[] {
	const roots = [join(REPO_ROOT, "apps/mem-claw/src"), join(REPO_ROOT, "packages/rem-core/src")];
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".ts")) out.push(path);
		}
	};
	for (const root of roots) walk(root);
	return out;
}

describe("PRD 150 QCG-10 — the judgement text is in skill files", () => {
	it("serves the group-closure judgement to the model from the skill file, byte for byte", () => {
		const onDisk = read(GROUP_CLOSURE);
		expect(
			REM_UPDATE_JUDGMENT_SKILL.retirementTarget,
			"the closure judgement the prompt carries is not what the skill file says",
		).toBe(onDisk);
		// The judgement itself, not a stub: it must tell the model to answer with a set of ids.
		expect(onDisk).toContain("retire");
		expect(onDisk).toContain("empty set");
	});

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

	it("leaves no judgement template literal in the judgement module", () => {
		const source = read(JUDGMENT_MODULE);
		// The module may still hold path constants and section names. What it may not hold is the
		// judgement: a multi-line template literal is how that text used to be frozen in code.
		const templateLiterals = source.match(/`[^`]*`/g) ?? [];
		const multiLine = templateLiterals.filter((literal) => literal.includes("\n"));
		expect(
			multiLine,
			"a multi-line template literal is back in the judgement module; the text belongs in a .md",
		).toEqual([]);
	});

	it("adds no engine rule that decides membership, identity or closure", () => {
		// Phrases that only a meaning rule would carry. A router may nominate a row on a coarse
		// pattern — that is today's classifier and it is out of this change's scope — so the check
		// runs over the files this change owns, not over the whole tree.
		const owned = engineSources().filter((path) =>
			[
				"rem-batch-executor.ts",
				"rem-update-judgment.ts",
				"rem-update-judgment-skill.ts",
				"memory-source-order.ts",
				"memory-store-atomic-extraction-write-api.ts",
				"atomic-memory-extraction.ts",
			].some((name) => path.endsWith(name)),
		);
		expect(owned.length, "the owned engine sources were not found").toBeGreaterThanOrEqual(6);
		const meaningRules = [
			"used to",
			"no longer",
			"formerly",
			"instead of",
			"stopped liking",
			"same person",
			"same entity",
			"is a variant of",
		];
		const offenders: string[] = [];
		for (const path of owned) {
			const source = executableLines(path).toLowerCase();
			for (const rule of meaningRules) {
				if (source.includes(rule)) offenders.push(`${path}: ${rule}`);
			}
		}
		expect(
			offenders,
			"engine code decides meaning with a phrase; that judgement belongs in a skill file",
		).toEqual([]);
	});
});
