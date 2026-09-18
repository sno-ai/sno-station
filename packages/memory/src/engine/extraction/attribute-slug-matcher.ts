/** @file attribute-slug-matcher.ts
 * @purpose Resolves an emitted attribute name to a canonical dictionary slug.
 * @boundary Pure resolution over the committed dictionary artifact; no model call, no storage.
 */

import { z } from "zod";

/**
 * The adapter is served the bare conversation with no slug list, so it reproduces all 137 names
 * from training alone and gets some of them slightly wrong: a plural, a British spelling, the
 * wrong family prefix, or a synonym it learned instead of the slug. Code owns addressing, so the
 * repair belongs here rather than in training capacity.
 *
 * THIS MODULE APPLIES NO HEURISTIC TO THE EMITTED NAME. Every accepted variant is precomputed
 * into the artifact by `scripts/generate-attribute-dictionary-variants.mjs`, using maintained
 * inflection and British-spelling data, with collisions dropped at generation time. Runtime is a
 * lookup. A stemmer here would have to guess on arbitrary input and would get the ordinary cases
 * wrong — stripping one trailing "s" turns "abilities" into "abilitie" and never reaches
 * "children" — so the vocabulary being CLOSED is what makes precomputation the correct design.
 *
 * A name that resolves to nothing is NOT forced to a guess. The card stores without a key, which
 * keeps it searchable and served; a wrong key would poison every later lookup on that attribute.
 */

export interface AttributeSlugEntry {
	slug: string;
	family: string;
	anchor: string;
	covers: string;
	synonyms: Record<string, string[]>;
	lookup_keys?: string[];
}

export interface AttributeDictionary {
	schema_version: number;
	locales: string[];
	slug_count: number;
	families: string[];
	slugs: AttributeSlugEntry[];
}

/** Validation only — the shape above is the source of truth, per isolatedDeclarations. */
const AttributeDictionarySchema = z.object({
	schema_version: z.number(),
	locales: z.array(z.string()).min(1),
	slug_count: z.number(),
	families: z.array(z.string()).min(1),
	slugs: z
		.array(
			z.object({
				slug: z.string().min(1),
				family: z.string().min(1),
				anchor: z.string(),
				covers: z.string(),
				synonyms: z.record(z.string(), z.array(z.string())),
				lookup_keys: z.array(z.string()).optional(),
			}),
		)
		.min(1),
});

export type AttributeSlugMatchKind = "exact" | "synonym" | "derived";

export interface AttributeSlugMatch {
	slug: string;
	via: AttributeSlugMatchKind;
}

export interface AttributeSlugIndex {
	readonly slugs: ReadonlySet<string>;
	readonly normalized: ReadonlyMap<string, string>;
	readonly derived: ReadonlyMap<string, string>;
}

/**
 * NFKC folds full-width and compatibility forms. Stripping to letters and numbers by Unicode
 * property keeps CJK characters intact while removing dots, underscores, hyphens and spaces.
 * The generator uses this exact function; the two must not drift.
 */
function normalize(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");
}

function leafOf(slug: string): string {
	const separator = slug.indexOf(".");
	return separator === -1 ? slug : slug.slice(separator + 1);
}

/** The family a dotted name claims, normalized for comparison. Empty when the name carries none. */
function familyOf(slug: string): string {
	const separator = slug.indexOf(".");
	return separator === -1 ? "" : normalize(slug.slice(0, separator));
}

/** One probe against both maps. Authoritative keys win; the generated ones are the fallback. */
function lookUp(index: AttributeSlugIndex, probe: string): AttributeSlugMatch | undefined {
	const key = normalize(probe);
	if (key.length === 0) return undefined;
	const synonym = index.normalized.get(key);
	if (synonym !== undefined) return { slug: synonym, via: "synonym" };
	const generated = index.derived.get(key);
	if (generated !== undefined) return { slug: generated, via: "derived" };
	return undefined;
}

/**
 * Parses and validates the committed dictionary artifact.
 * Throws on a shape the rest of this module cannot reason about.
 */
export function parseAttributeDictionary(raw: unknown): AttributeDictionary {
	const dictionary = AttributeDictionarySchema.parse(raw);
	if (dictionary.slugs.length !== dictionary.slug_count) {
		throw new Error(
			`attribute dictionary declares slug_count ${dictionary.slug_count} but carries ${dictionary.slugs.length} slugs`,
		);
	}
	return dictionary;
}

/**
 * Builds the resolution index. TWO maps, and the runtime DERIVES NOTHING.
 *
 * Authoritative keys are the slug and its curated synonyms; a duplicate throws, because the
 * artifact is ours and a collision there is a defect. Derived keys — leaves, plurals, spelling
 * variants — were computed and collision-resolved offline by
 * `scripts/generate-attribute-dictionary-variants.mjs`. Deriving any of them again here would
 * let the runtime reinstate a key the generator deliberately dropped, so it does not.
 */
export function buildAttributeSlugIndex(dictionary: AttributeDictionary): AttributeSlugIndex {
	const slugs = new Set<string>();
	const normalized = new Map<string, string>();
	const derived = new Map<string, string>();

	for (const entry of dictionary.slugs) {
		if (slugs.has(entry.slug)) {
			throw new Error(`attribute dictionary carries duplicate slug "${entry.slug}"`);
		}
		slugs.add(entry.slug);
		for (const key of [entry.slug, ...Object.values(entry.synonyms).flat()]) {
			const normalizedKey = normalize(key);
			if (normalizedKey.length === 0) continue;
			const owner = normalized.get(normalizedKey);
			if (owner !== undefined && owner !== entry.slug) {
				throw new Error(
					`attribute dictionary is ambiguous: normalized key "${normalizedKey}" is claimed by both "${owner}" and "${entry.slug}"`,
				);
			}
			normalized.set(normalizedKey, entry.slug);
		}
	}

	for (const entry of dictionary.slugs) {
		for (const key of entry.lookup_keys ?? []) {
			if (normalized.has(key)) continue;
			const owner = derived.get(key);
			if (owner !== undefined && owner !== entry.slug) {
				throw new Error(
					`generated lookup key "${key}" is claimed by both "${owner}" and "${entry.slug}" — regenerate the artifact`,
				);
			}
			derived.set(key, entry.slug);
		}
	}

	return { slugs, normalized, derived };
}

/**
 * Resolves an emitted attribute name, or returns undefined when nothing in the vocabulary claims
 * it. Undefined is a legitimate outcome and the caller stores the card without a key.
 */
export function resolveAttributeSlug(
	index: AttributeSlugIndex,
	emitted: string,
): AttributeSlugMatch | undefined {
	const candidate = emitted.trim();
	if (candidate.length === 0) return undefined;

	if (index.slugs.has(candidate)) {
		return { slug: candidate, via: "exact" };
	}

	// Past an exact hit, a dotted name is only ever resolved WITHIN the family it claims itself.
	//
	// Repairing a wrong LEAF — identity.nickname for identity.aka, possession.vehicles for
	// possession.vehicle — is addressing, and code owns addressing. A prefix that disagrees is not
	// a misspelling: the model is naming a different KIND of fact, and matching across families
	// silently rewrites it. Measured 2026-08-18 against real adapter output, that path turned a
	// dated step count into a standing exercise preference, a stated dislike of travelling into a
	// travel goal, and a spouse's birthday into the user's own date of birth. Deciding which of
	// those a name means is a judgement, and this repo's law sends a judgement to a model: keyword
	// rules filter, MODELS score. Unresolved is the honest outcome, and it is counted — the caller
	// stores the card without a key, which keeps it searchable and served.
	//
	// The rule is applied ONCE, to whichever probe hits, rather than to the leaf probe alone. A
	// dotted name whose whole form is a curated synonym of another family would otherwise return
	// before the check ever ran. No such synonym exists today; one added later must not silently
	// reopen the hole this closes.
	//
	// A name with no dot claims no family. Bare "birthday" has only the reading the vocabulary
	// gives it, so it is taken as it comes.
	const family = familyOf(candidate);
	for (const probe of family.length === 0 ? [candidate] : [candidate, leafOf(candidate)]) {
		const match = lookUp(index, probe);
		if (match === undefined) continue;
		if (family.length === 0 || familyOf(match.slug) === family) return match;
	}

	return undefined;
}
