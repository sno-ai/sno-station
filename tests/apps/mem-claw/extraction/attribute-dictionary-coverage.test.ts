/** @file attribute-dictionary-coverage.test.ts
 * @purpose Guards the closed attribute vocabulary against edits that silently open a hole.
 * @boundary Reads the two committed config artifacts; no model, no store, no network.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildAttributeSlugIndex,
	parseAttributeDictionary,
	resolveAttributeSlug,
} from "../../../../packages/memory/src/engine/extraction/attribute-slug-matcher";

/**
 * The filing test is 104 sentences a student, an AI knowledge worker or a programmer would say.
 * It is the only thing that proves a dictionary edit did not remove a home some sentence relied
 * on: the vocabulary is closed, so an attribute with nowhere to go stores without a key forever.
 */

const PUBLIC_CONFIG_DIR = fileURLToPath(
	new URL("../../../../packages/memory/config/", import.meta.url),
);
const INTERNAL_CONFIG_TEST_DIR = fileURLToPath(
	new URL("../../../../internal/sno-station-mem/config-tests/", import.meta.url),
);

interface FilingRow {
	say: string;
	slug: string | null;
	why: string;
}

/**
 * Deliberate refusals, not gaps. Two touch protected characteristics and wait on a demonstrated
 * sensitive-data path; one expires within days; one is a fact about an employer, not the user.
 * A fifth homeless sentence fails this test on purpose — it means a real hole opened.
 */
const ACCEPTED_HOMELESS = [
	"I'm the first in my family to go to university.",
	"I'm on a student visa, so I can only work 20 hours.",
	"I'm the on-call for payments this week.",
	"We're a Kubernetes shop.",
] as const;

function readJson(directory: string, name: string): unknown {
	return JSON.parse(readFileSync(`${directory}${name}`, "utf8"));
}

const dictionary = parseAttributeDictionary(
	readJson(PUBLIC_CONFIG_DIR, "attribute-dictionary.json"),
);
const index = buildAttributeSlugIndex(dictionary);
const filing = readJson(INTERNAL_CONFIG_TEST_DIR, "attribute-dictionary-filing-test.json") as {
	rows: FilingRow[];
};

const GENERATOR = `${PUBLIC_CONFIG_DIR}../scripts/generate-attribute-dictionary-variants.mjs`;

/**
 * Deletes one slug from a COPY of the artifact and runs the real generator over it.
 *
 * This is the only way to ask what a future dictionary edit will produce: the committed file
 * already has its keys, and reading it can never show what regenerating would decide. The
 * generator reads a sibling `.sha256` for its rollback path, so both files are copied.
 */
function regenerateWithout(
	slug: string,
	options: { keepReservedList: boolean },
): ReturnType<typeof parseAttributeDictionary> {
	const scratch = mkdtempSync(join(tmpdir(), "attr-dict-regen-"));
	try {
		const copy = join(scratch, "attribute-dictionary.json");
		copyFileSync(`${PUBLIC_CONFIG_DIR}attribute-dictionary.json`, copy);
		copyFileSync(`${PUBLIC_CONFIG_DIR}attribute-dictionary.json.sha256`, `${copy}.sha256`);
		const doc = JSON.parse(readFileSync(copy, "utf8")) as Record<string, unknown> & {
			slugs: { slug: string }[];
			slug_count: number;
		};
		doc.slugs = doc.slugs.filter((entry) => entry.slug !== slug);
		doc.slug_count = doc.slugs.length;
		if (!options.keepReservedList) doc.reserved_derived_keys = undefined;
		writeFileSync(copy, `${JSON.stringify(doc, null, 2)}\n`);
		execFileSync(process.execPath, [GENERATOR, copy], { stdio: "pipe" });
		return parseAttributeDictionary(JSON.parse(readFileSync(copy, "utf8")));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

describe("attribute dictionary coverage", () => {
	it("builds an index with no ambiguous normalized key", () => {
		expect(dictionary.slugs.length).toBe(dictionary.slug_count);
		expect(index.slugs.size).toBe(dictionary.slug_count);
	});

	it("every slug the filing test depends on still exists", () => {
		const missing = filing.rows
			.filter((row): row is FilingRow & { slug: string } => row.slug !== null)
			.filter((row) => !index.slugs.has(row.slug))
			.map((row) => `${row.slug} (needed by "${row.say}")`);
		expect(missing).toEqual([]);
	});

	it("no sentence lost its home beyond the four deliberate refusals", () => {
		const homeless = filing.rows.filter((row) => row.slug === null).map((row) => row.say);
		expect(homeless.sort()).toEqual([...ACCEPTED_HOMELESS].sort());
	});

	it("resolves the merged legacy names to their targets", () => {
		expect(resolveAttributeSlug(index, "trait.documentation")?.slug).toBe("trait.communication");
		expect(resolveAttributeSlug(index, "entity.team")?.slug).toBe("entity.organization");
	});

	it("leaves a removed catch-all unresolved on purpose", () => {
		// An unmappable preference must store WITHOUT a key; a false key would poison every later
		// lookup on that attribute, which is why the catch-all slot was removed rather than kept.
		expect(resolveAttributeSlug(index, "preference.general")).toBeUndefined();
	});

	it("never lets file order decide a key", () => {
		// goal.project and entity.project both end in "project". Deciding one leaf at a time let the
		// first-listed win by file order, which is how a card gets an arbitrary key. Order-independence
		// is the real invariant: an authoritative synonym may legitimately claim a shared leaf
		// ("education" belongs to identity.education), but which slug wins must never depend on the
		// order the file happens to list.
		const reversed = buildAttributeSlugIndex({
			...dictionary,
			slugs: [...dictionary.slugs].reverse(),
		});
		for (const shared of ["project", "education", "devices", "home"]) {
			expect(resolveAttributeSlug(reversed, shared)).toEqual(resolveAttributeSlug(index, shared));
		}
		// "project" resolves to nothing, and the reason CHANGED on 2026-08-18. It used to be a
		// two-claimant collision (goal.project and entity.project). entity.project was removed by
		// owner ruling, which left one claimant and silently turned a bare "project" into a personal
		// GOAL — a word that generic names a thing far more often than an objective. It is now a
		// reserved derived key in the generator, so it stays unresolved, which is loud and counted.
		expect(resolveAttributeSlug(index, "project")).toBeUndefined();
		expect(resolveAttributeSlug(reversed, "project")).toBeUndefined();
	});

	it("resolves plurals the generator precomputed, including ones a stemmer breaks", () => {
		// A runtime "strip one s" produced abilitie / identitie and never reached children.
		expect(resolveAttributeSlug(index, "ability.certification")?.slug).toBe(
			"ability.certifications",
		);
		expect(resolveAttributeSlug(index, "relationship.child")?.slug).toBe("relationship.children");
		expect(resolveAttributeSlug(index, "identity.language")?.slug).toBe("identity.languages");
	});

	it("resolves British spellings from the generated table, not a hand-typed list", () => {
		expect(resolveAttributeSlug(index, "entity.organisation")?.slug).toBe("entity.organization");
	});

	it("repairs the mistakes the adapter actually makes", () => {
		expect(resolveAttributeSlug(index, "identity.nickname")?.slug).toBe("identity.aka");
		expect(resolveAttributeSlug(index, "possession.vehicles")?.slug).toBe("possession.vehicle");
		expect(resolveAttributeSlug(index, "identity.birthplace")?.slug).toBe("identity.birth_place");
		expect(resolveAttributeSlug(index, "entity.organisation")?.slug).toBe("entity.organization");
	});

	it("refuses a leaf whose family contradicts the name the adapter emitted", () => {
		// Measured 2026-08-18 against real adapter output: each of these three resolved, and each
		// wrote a false statement into the store with nothing counting the loss. Repairing a wrong
		// LEAF is addressing and code owns it; a prefix that disagrees means the model named a
		// different KIND of fact, and no string rule can settle that.
		//
		// A dated step count arriving as a standing preference about exercising:
		expect(resolveAttributeSlug(index, "health.exercise")).toBeUndefined();
		// The third measured case, `preference.travel -> goal.travel`, is no longer reachable from
		// here and its history is worth keeping. "I no longer enjoy travelling to the Mediterranean"
		// arrived as a travel GOAL; the family rule turned that into a counted drop, which exposed
		// it as a real vocabulary gap, and preference.travel was then added. It now resolves to
		// ITSELF, exactly — the outcome the whole sequence was aiming at.
		expect(resolveAttributeSlug(index, "preference.travel")).toEqual({
			slug: "preference.travel",
			via: "exact",
		});
		expect(resolveAttributeSlug(index, "goal.travel")).toEqual({ slug: "goal.travel", via: "exact" });
		// And the bare word is refused BECAUSE both now claim it. A wished-for trip and a standing
		// taste in travel are different facts, so nothing may guess between them on the word alone.
		expect(resolveAttributeSlug(index, "travel")).toBeUndefined();
		expect(resolveAttributeSlug(index, "travels")).toBeUndefined();
		// THIS ONE IS NOT REDUNDANT WITH THE OTHER TWO, and it is the reason this case exists.
		// The two above resolve through the GENERATED map and report via:"derived". This one
		// resolves through the AUTHORITATIVE map and reports via:"synonym", because "birthday" is
		// a curated synonym of identity.birth_date. A gate written on the match kind instead of on
		// which probe fired would leave exactly this one alive — and it is the worst of the three:
		// the payload was {"name":"my spouse's birthday","date":"June 22nd"}, landing in the field
		// that holds the USER'S OWN date of birth.
		expect(resolveAttributeSlug(index, "event.birthday")).toBeUndefined();
		// Deliberate collateral, asserted so nobody restores it as a "fix": preference.nature used
		// to reach interest.nature. It reads plausibly, which is precisely the problem — it is the
		// same cross-family guess as the three above and was kept only because it happened to look
		// harmless. A counted drop beats an uncounted misfiling.
		expect(resolveAttributeSlug(index, "preference.nature")).toBeUndefined();
	});

	it("still resolves a bare name, which claims no family to contradict", () => {
		// The half a family rule most easily over-tightens. A name with no dot makes no claim about
		// its kind, so the vocabulary's own reading is the only one available and is taken. Both
		// maps are covered: the first is an authoritative synonym, the second a generated spelling
		// variant. Rejecting these would silently drop every un-prefixed name the adapter emits.
		expect(resolveAttributeSlug(index, "birthday")).toEqual({
			slug: "identity.birth_date",
			via: "synonym",
		});
		expect(resolveAttributeSlug(index, "licence")).toEqual({
			slug: "ability.certifications",
			via: "derived",
		});
	});

	it("compares the family prefix by meaning, not by bytes", () => {
		// The adapter capitalizes names, so a prefix comparison done on raw bytes would reject every
		// repair it is supposed to make. Both of these reach the leaf probe — their whole names hit
		// nothing — so each one genuinely exercises the gate, one through each map. (Health.Fitness
		// does NOT: its whole name is itself a lookup key, so it never reaches the gate at all.)
		expect(resolveAttributeSlug(index, "Possession.Vehicles")?.slug).toBe("possession.vehicle");
		expect(resolveAttributeSlug(index, "Identity.Nickname")?.slug).toBe("identity.aka");
	});

	it("a reserved word reserves its inflections too, not only its exact form", () => {
		// The reserved set was added to stop a bare "project" becoming a personal GOAL, and it was
		// tested with an exact-key lookup — so the generator went on minting "projects" through its
		// own inflection data and handing it to goal.project. The identical defect, one inflection
		// over. Reserving a word now expands it through the same variantsOf that mints the keys, so
		// adding a second reserved word cannot re-earn this by forgetting to list its plural.
		expect(resolveAttributeSlug(index, "project")).toBeUndefined();
		expect(resolveAttributeSlug(index, "projects")).toBeUndefined();
		expect(resolveAttributeSlug(index, "Projects")).toBeUndefined();
		expect(resolveAttributeSlug(index, "goal.projects")).toBeUndefined();
	});

	it("a key two slugs contested stays unresolved after one of them is deleted", () => {
		// THE REGRESSION THIS EXISTS FOR, and it already happened once: "project" was safe only
		// because goal.project and entity.project both claimed it, so the collision policy dropped
		// it. entity.project was removed by owner ruling, the next generation saw a single claimant,
		// and the word silently became a personal GOAL. Nothing recorded that it had ever been
		// contested, so nothing could refuse it.
		//
		// "home" is the same shape today: possession.home and preference.home both claim it. Delete
		// one and regenerate for real — the committed artifact cannot answer this question, only a
		// regeneration can.
		const claimants = dictionary.slugs.filter((entry) => entry.slug.endsWith(".home"));
		expect(claimants.map((entry) => entry.slug).sort()).toEqual([
			"possession.home",
			"preference.home",
		]);
		expect(resolveAttributeSlug(index, "home")).toBeUndefined();

		const survivor = regenerateWithout("preference.home", { keepReservedList: true });
		expect(survivor.slugs.some((entry) => entry.slug === "possession.home")).toBe(true);
		expect(resolveAttributeSlug(buildAttributeSlugIndex(survivor), "home")).toBeUndefined();

		// And the control that proves the persisted list is load-bearing rather than decorative:
		// strip it, delete the same slug, regenerate, and the survivor takes the word. If this
		// assertion ever flips to undefined the first half above has stopped proving anything.
		const unprotected = regenerateWithout("preference.home", { keepReservedList: false });
		expect(resolveAttributeSlug(buildAttributeSlugIndex(unprotected), "home")?.slug).toBe(
			"possession.home",
		);
	});

	it("refuses a dotted cross-family name however it hits, not only through the leaf", () => {
		// The leaf probe checks the family. The whole-name probe used to return unconditionally, so
		// a curated synonym that is itself dotted and points at another family would walk straight
		// past the gate. No such synonym exists in the committed artifact — 2 dotted synonyms, both
		// same-family — so the only way to prove the rule holds is to build an index from a
		// dictionary that has one, which is what this does.
		// Two dotted synonyms on the same slug, differing only in the family they claim. Both reach
		// the resolver the same way — whole name, normalized, authoritative map — so the family is
		// the only thing that can separate them.
		const planted = buildAttributeSlugIndex({
			...dictionary,
			slugs: dictionary.slugs.map((entry) =>
				entry.slug === "identity.aka"
					? {
							...entry,
							synonyms: {
								...entry.synonyms,
								en: [...(entry.synonyms.en ?? []), "identity.moniker", "goal.moniker"],
							},
						}
					: entry,
			),
		});
		// Control: the whole-name probe really does see a planted dotted synonym. Without this the
		// case could pass because nothing was planted at all — the way a test like this rots into
		// proving nothing. Note a BARE "moniker" is not a key here: the synonym itself is dotted,
		// so "identitymoniker" is what the map holds.
		expect(resolveAttributeSlug(planted, "identity.moniker")?.slug).toBe("identity.aka");
		// Same slug, same map, same probe — refused solely because the name claims the goal family
		// and identity.aka is not in it. Before the fix this returned identity.aka.
		expect(resolveAttributeSlug(planted, "goal.moniker")).toBeUndefined();
	});

	it("the committed lookup keys are what the generator produces", () => {
		// The runtime cannot recompute a plural or a British spelling — it has no inflection data by
		// design. So a hand-edited lookup_keys entry left under an old slug would resolve model
		// output to the WRONG attribute with nothing failing. Regenerating against a copy and
		// diffing is the only gate that catches it, so it runs here rather than living in a habit.
		const scratch = mkdtempSync(join(tmpdir(), "attr-dict-"));
		try {
			const copy = join(scratch, "attribute-dictionary.json");
			copyFileSync(`${PUBLIC_CONFIG_DIR}attribute-dictionary.json`, copy);
			copyFileSync(`${PUBLIC_CONFIG_DIR}attribute-dictionary.json.sha256`, `${copy}.sha256`);
			execFileSync(
				process.execPath,
				[`${PUBLIC_CONFIG_DIR}../scripts/generate-attribute-dictionary-variants.mjs`, copy],
				{ stdio: "pipe" },
			);
			expect(readFileSync(copy, "utf8")).toBe(
				readFileSync(`${PUBLIC_CONFIG_DIR}attribute-dictionary.json`, "utf8"),
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("the runtime derives no key of its own", () => {
		// Every non-authoritative key must come from the generated lookup_keys. If the runtime
		// re-derived leaves or plurals it could reinstate a key the generator deliberately dropped
		// for ambiguity, and the two sides would disagree without anything failing.
		const generated = new Set(dictionary.slugs.flatMap((entry) => entry.lookup_keys ?? []));
		const stripped = buildAttributeSlugIndex({
			...dictionary,
			slugs: dictionary.slugs.map((entry) => ({ ...entry, lookup_keys: [] })),
		});
		expect(generated.size).toBeGreaterThan(0);
		// With the generated keys removed, only slugs and curated synonyms still resolve.
		expect(resolveAttributeSlug(stripped, "possession.vehicles")).toBeUndefined();
		expect(resolveAttributeSlug(stripped, "identity.nickname")?.slug).toBe("identity.aka");
	});

	it("returns an exact match unchanged and refuses a name nothing claims", () => {
		expect(resolveAttributeSlug(index, "identity.timezone")).toEqual({
			slug: "identity.timezone",
			via: "exact",
		});
		expect(resolveAttributeSlug(index, "identity.favourite_colour_of_socks")).toBeUndefined();
		expect(resolveAttributeSlug(index, "   ")).toBeUndefined();
	});
});
