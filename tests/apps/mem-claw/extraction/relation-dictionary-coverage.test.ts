/** @file relation-dictionary-coverage.test.ts
 * @purpose Guards the closed relation vocabulary against edits that silently open a hole.
 * @boundary Reads the two committed config artifacts; no model, no store, no network.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Same method as the attribute dictionary: sentences a student, an AI knowledge worker or a
 * programmer would say, each filed into the relation that should hold it or marked homeless.
 * The vocabulary is CLOSED, so a relation with nowhere to go is lost, not merely unkeyed.
 */

const PUBLIC_CONFIG_DIR = fileURLToPath(
	new URL("../../../../packages/memory/config/", import.meta.url),
);
const INTERNAL_CONFIG_TEST_DIR = fileURLToPath(
	new URL("../../../../internal/sno-station-mem/config-tests/", import.meta.url),
);

interface RelationEntry {
	type: string;
	ratified: boolean;
	covers: string;
	synonyms: string[];
	/** Surface forms that state the SAME relation with the two ends the other way round. */
	inverse_synonyms: string[];
}

interface RelationDictionary {
	relation_count: number;
	relations: RelationEntry[];
	refused: { candidate: string; example: string; why: string }[];
}

interface FilingRow {
	say: string;
	/** EVERY relation the sentence asserts. One sentence commonly carries two facts. */
	relations: string[];
	why: string;
	/** A span the relation's covers text must still contain for this sentence to file correctly. */
	requires_covers?: string;
	/** A phrase that states the relation backwards, so it must live in inverse_synonyms. */
	requires_inverse_synonym?: string;
}

/**
 * Deliberate refusals, not gaps: a three-place fact in a two-place vocabulary, a schedule (an
 * attribute of an event rather than a relation to an entity), a mirroring claim with no decidable
 * boundary against IS_A, a family fact between two third parties, and a function signature detail.
 * The sixth is DEFERRED rather than refused and is called out below. A seventh homeless sentence
 * fails this test on purpose — it means a real hole opened.
 */
const ACCEPTED_HOMELESS = [
	"Dana introduced me to Kit.",
	"The staging cluster mirrors production.",
	"The retro is every Thursday.",
	"Dana is Kit's sister.",
	"The parser returns JSON.",
	"The paper supports the hypothesis.",
] as const;

/** Homeless pending an OWNER ruling, not by decision. It may not be quietly reclassified. */
const DEFERRED_TO_OWNER = "SUPPORTS";

function readJson(directory: string, name: string): unknown {
	return JSON.parse(readFileSync(`${directory}${name}`, "utf8"));
}

const dictionary = readJson(PUBLIC_CONFIG_DIR, "relation-dictionary.json") as RelationDictionary;
const filing = readJson(INTERNAL_CONFIG_TEST_DIR, "relation-dictionary-filing-test.json") as {
	rows: FilingRow[];
};
const types = new Set(dictionary.relations.map((entry) => entry.type));

describe("relation dictionary coverage", () => {
	it("declares the count it carries, with unique SCREAMING_SNAKE types", () => {
		expect(dictionary.relations.length).toBe(dictionary.relation_count);
		expect(types.size).toBe(dictionary.relation_count);
		for (const entry of dictionary.relations) {
			expect(entry.type).toMatch(/^[A-Z][A-Z_]*$/u);
			expect(entry.synonyms.length).toBeGreaterThan(0);
			expect(Array.isArray(entry.inverse_synonyms)).toBe(true);
		}
	});

	it("keeps every upstream-ratified type — this repo may not drop one", () => {
		// The 22 were ratified in the EKG ontology registry, which consumes this vocabulary too.
		// Adding here is a proposal to that repo; removing one of theirs is not ours to do.
		const ratified = dictionary.relations.filter((entry) => entry.ratified).map((e) => e.type);
		expect(ratified.length).toBe(22);
		expect(dictionary.relations.filter((entry) => !entry.ratified).length).toBe(9);
		expect(ratified).toContain("WORKS_AT");
		expect(ratified).toContain("ATTENDED");
	});

	it("every relation the filing test depends on still exists", () => {
		const missing = filing.rows
			.flatMap((row) => row.relations.map((relation) => ({ relation, say: row.say })))
			.filter((pair) => !types.has(pair.relation))
			.map((pair) => `${pair.relation} (needed by "${pair.say}")`);
		expect(missing).toEqual([]);
	});

	it("no sentence lost its home beyond the six recorded ones", () => {
		const homeless = filing.rows.filter((row) => row.relations.length === 0).map((row) => row.say);
		expect(homeless.sort()).toEqual([...ACCEPTED_HOMELESS].sort());
	});

	it("the deferred candidate stays deferred until the owner rules", () => {
		// SUPPORTS is homeless by INACTION, not by decision — a real gap for the student user type
		// that needs its negative twin to be worth anything. Letting it drift into the settled
		// refusals is how a pending owner decision disappears.
		const deferred = dictionary.refused.find((entry) => entry.candidate === DEFERRED_TO_OWNER);
		expect(deferred?.why).toContain("DEFERRED, NOT SETTLED");
	});

	it("records why each refused candidate was refused", () => {
		// A refusal with no reason is indistinguishable from an oversight to the next reader.
		expect(dictionary.refused.length).toBeGreaterThan(0);
		for (const entry of dictionary.refused) {
			expect(entry.why.length).toBeGreaterThan(20);
			expect(types.has(entry.candidate)).toBe(false);
		}
	});

	it("no sentence lost its home to a NARROWED covers text", () => {
		// Type survival is not coverage. Cutting "present or past" out of WORKS_AT loses "Dana used to
		// work at Stripe." while the type, the count, the ratified flag and the synonyms all stay
		// intact — every other assertion here passes and the hole opens silently. A row that files
		// only because the covers text says something specific names that span, and this asserts it.
		const covers = new Map(dictionary.relations.map((entry) => [entry.type, entry.covers]));
		const guarded = filing.rows.filter((row) => row.requires_covers !== undefined);
		const broken = guarded
			.filter((row) => !row.relations.some((r) => covers.get(r)?.includes(row.requires_covers ?? "")))
			.map((row) => `no relation of "${row.say}" still says "${row.requires_covers}"`);
		expect(broken).toEqual([]);
		expect(guarded.length).toBeGreaterThan(0);
	});

	it("a phrase that states a relation BACKWARDS is filed as an inverse, never as a synonym", () => {
		// This is worse than a collision and that is why it gets its own gate: a collision fails to
		// resolve and is visible, while "A is deprecated in favour of B" matched as a plain synonym
		// resolves confidently to SUPERSEDES(A, B) — the exact opposite of what was said, stored as
		// fact. Upstream ratified the edge NAMES and never defined argument order, so nothing above
		// this file catches it either.
		const forward = new Map(dictionary.relations.map((e) => [e.type, new Set(e.synonyms)]));
		const inverse = new Map(dictionary.relations.map((e) => [e.type, new Set(e.inverse_synonyms)]));
		const wrong = filing.rows
			.filter((row) => row.requires_inverse_synonym !== undefined)
			.flatMap((row) =>
				row.relations
					.filter(
						(r) =>
							!inverse.get(r)?.has(row.requires_inverse_synonym ?? "") ||
							forward.get(r)?.has(row.requires_inverse_synonym ?? ""),
					)
					.map((r) => `${r} must carry "${row.requires_inverse_synonym}" as an INVERSE only`),
			);
		expect(wrong).toEqual([]);
	});

	it("no synonym string is claimed by two relations", () => {
		// The synonyms are hand-written and nothing generates them, so a collision is invisible until
		// the extractor emits the colliding string and the filer picks by nothing. "is a" was claimed
		// by both IS_A and HAS_OCCUPATION; the surface form genuinely does not decide there, so both
		// dropped it and their covers text now says the object decides. Forward and inverse forms
		// share one namespace — a filer matching a string has no second field to disambiguate with.
		const owners = new Map<string, string[]>();
		for (const entry of dictionary.relations) {
			for (const synonym of [...entry.synonyms, ...entry.inverse_synonyms]) {
				const key = synonym.toLowerCase();
				owners.set(key, [...(owners.get(key) ?? []), entry.type]);
			}
		}
		const contested = [...owners]
			.filter(([, holders]) => holders.length > 1)
			.map(([key, holders]) => `"${key}" claimed by ${holders.join(" and ")}`);
		expect(contested).toEqual([]);
	});

	it("keeps the pairs that are easy to collapse genuinely distinct", () => {
		// Each of these was proposed as a duplicate of the other during authoring. The covers text
		// has to make the split decidable by a filer who reads nothing else.
		const covers = new Map(dictionary.relations.map((entry) => [entry.type, entry.covers]));
		expect(covers.get("ABANDONED")).toContain("FORBIDS");
		expect(covers.get("BLOCKED_BY")).toContain("DEPENDS_ON");
		expect(covers.get("OCCURS_UNDER")).toContain("CAUSED");
		expect(covers.get("IMPLEMENTED_IN")).toContain("USES");
	});
});
