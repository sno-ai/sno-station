#!/usr/bin/env node
/** @file generate-attribute-dictionary-variants.mjs
 * @purpose Precomputes the lookup variants of every attribute name into the dictionary artifact.
 * @boundary Offline generator. Reads and rewrites the config artifact; no runtime, no network.
 *
 * Why this exists rather than a runtime stemmer: the vocabulary is CLOSED and small, so every
 * variant can be computed once against maintained data, reviewed, hashed and collision-checked
 * here. A runtime heuristic over arbitrary model output cannot be reviewed and gets the ordinary
 * cases wrong — stripping one trailing "s" turns "abilities" into "abilitie" and never reaches
 * "children" at all. Generating into the artifact makes that class of error impossible instead
 * of unlikely.
 *
 * Sources: `pluralize` for English number inflection (handles irregulars), and the
 * VarCon-derived British-to-American table shipped with `american-british-english-translator`.
 * Both are devDependencies — nothing here ships to a consumer of the package.
 *
 * Run: node apps/mem-claw/scripts/generate-attribute-dictionary-variants.mjs
 */

import { createHash } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import britishSpellings from "american-british-english-translator/data/british_spellings.json" with {
	type: "json",
};
import pluralize from "pluralize";

const DEFAULT_ARTIFACT = fileURLToPath(
	new URL("../config/attribute-dictionary.json", import.meta.url),
);

/** A path argument lets a test regenerate against a copy and diff it, which is the only gate that
 *  can catch a hand-edited artifact whose lookup_keys no longer match its synonyms. */
const ARTIFACT = process.argv[2] ?? DEFAULT_ARTIFACT;

/** The runtime uses this exact function; the two must not drift. */
function normalize(value) {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");
}

/** American -> British. One American word can have several British forms; all are kept. */
function buildAmericanToBritish() {
	const inverted = new Map();
	for (const [british, american] of Object.entries(britishSpellings)) {
		const key = String(american).toLowerCase();
		const list = inverted.get(key) ?? [];
		list.push(british.toLowerCase());
		inverted.set(key, list);
	}
	return inverted;
}

const AMERICAN_TO_BRITISH = buildAmericanToBritish();

/** Deliberate, and exceeding it throws — see spellingForms. */
const SPELLING_FORM_CAP = 512;

/** Every spelling this word is known by, itself included. */
function spellingsOf(word) {
	const out = new Set([word]);
	const american = britishSpellings[word];
	if (american) out.add(String(american).toLowerCase());
	for (const british of AMERICAN_TO_BRITISH.get(word) ?? []) out.add(british);
	return [...out];
}

/**
 * Cartesian product over each word's spellings, so a phrase with two convertible words yields
 * every mixed form a model might produce — not only the all-converted one. Bounded by a cap
 * because the product is exponential in convertible words; every term here is a few words long.
 */
function spellingForms(phrase) {
	const parts = phrase.split(/([^a-z]+)/u);
	let forms = [""];
	for (const part of parts) {
		const options = /^[a-z]+$/u.test(part) ? spellingsOf(part) : [part];
		const next = [];
		for (const prefix of forms) {
			for (const option of options) next.push(prefix + option);
		}
		// Refuse rather than truncate. An early return here would emit the half-built PREFIXES as
		// lookup keys, so a truncated model value would resolve to a slug instead of to nothing.
		if (next.length > SPELLING_FORM_CAP) {
			throw new Error(
				`"${phrase}" exceeds ${SPELLING_FORM_CAP} spelling combinations; shorten the term or raise the cap deliberately`,
			);
		}
		forms = next;
	}
	return [...new Set(forms)];
}

/**
 * Every form a model might emit for one term: its plural, its singular, and every spelling
 * combination of each. English only — Chinese, Japanese and Korean do not inflect for number,
 * and the spelling table is English by construction.
 */
function variantsOf(term) {
	const out = new Set();
	const lower = term.toLowerCase();
	for (const form of [lower, pluralize.plural(lower), pluralize.singular(lower)]) {
		for (const spelled of spellingForms(form)) out.add(spelled);
	}
	return [...out];
}

function leafOf(slug) {
	const at = slug.indexOf(".");
	return at === -1 ? slug : slug.slice(at + 1);
}

/**
 * Three-state claim. Once a key is contested it stays contested for the whole run: a later
 * claimant must NOT be able to resurrect it, which is exactly the defect that made the previous
 * generation order-dependent.
 */
function claimInto(map, key, slug) {
	if (key.length === 0) return;
	if (!map.has(key)) {
		map.set(key, slug);
		return;
	}
	const owner = map.get(key);
	if (owner !== slug) map.set(key, null);
}

function main() {
	const doc = JSON.parse(readFileSync(ARTIFACT, "utf8"));
	if (doc.slugs.length !== doc.slug_count) {
		throw new Error(`slug_count ${doc.slug_count} but ${doc.slugs.length} slugs present`);
	}

	// Pass 1: authoritative keys — the slug itself and every curated synonym in every locale.
	// A collision here is a defect in the artifact and stops the run.
	const authoritative = new Map();
	for (const entry of doc.slugs) {
		for (const key of [entry.slug, ...Object.values(entry.synonyms).flat()]) {
			const normalized = normalize(key);
			if (!normalized) continue;
			const owner = authoritative.get(normalized);
			if (owner !== undefined && owner !== entry.slug) {
				throw new Error(
					`ambiguous key "${normalized}": claimed by both "${owner}" and "${entry.slug}"`,
				);
			}
			authoritative.set(normalized, entry.slug);
		}
	}

	// Bare words that no slug may claim by derivation, however few claimants remain.
	//
	// "project" was safe while `goal.project` and `entity.project` both derived it: two claimants
	// meant the collision policy dropped it, so a bare "project" resolved to nothing and was
	// counted as unresolved. Removing `entity.project` on 2026-08-18 left one claimant, and the
	// same word silently became a personal GOAL. A word this generic names a thing far more often
	// than an objective, and the neighbouring rule already says it: a false key poisons every
	// later lookup on that attribute. Reserved words stay unresolved, which is loud and counted.
	const RESERVED_BASE_WORDS = ["project"];

	// A reserved word reserves every form THIS generator could mint for it, expanded through the
	// same `variantsOf` that mints them. Reserving only the exact form left "projects" resolving
	// to goal.project — the identical defect one inflection over, which is what a hand-listed
	// plural would keep re-earning for every word added here.
	//
	// The persisted list is the second half and it is what stops the failure recurring rather
	// than being patched again. A key two slugs both claim is dropped for the run and, until now,
	// only counted; nothing recorded WHICH keys. Remove one of the claimants later and the next
	// generation sees a single claimant and hands the key over silently. Writing the contested
	// keys back into the artifact makes "was ever contested" a durable fact that survives a slug
	// being deleted, so only a person removing the entry can un-reserve it.
	const reservedKeys = new Set(
		RESERVED_BASE_WORDS.flatMap((word) => [word, ...variantsOf(word)])
			.map(normalize)
			.filter((key) => key.length > 0),
	);
	for (const key of doc.reserved_derived_keys ?? []) {
		const normalized = normalize(key);
		if (normalized) reservedKeys.add(normalized);
	}

	// Pass 2: every derived key — the slug's leaf and the inflected/respelled forms of the leaf
	// and of the English synonyms. The RUNTIME derives nothing, so leaves are resolved here where
	// the collision policy is applied once; a runtime that re-derived them could reinstate a key
	// this pass deliberately dropped.
	const derived = new Map();
	for (const entry of doc.slugs) {
		const seeds = [leafOf(entry.slug), ...(entry.synonyms.en ?? [])];
		const leafKey = normalize(leafOf(entry.slug));
		if (!reservedKeys.has(leafKey)) claimInto(derived, leafKey, entry.slug);
		for (const seed of seeds) {
			for (const variant of variantsOf(seed)) {
				const normalized = normalize(variant);
				if (!normalized || authoritative.has(normalized)) continue;
				if (reservedKeys.has(normalized)) continue;
				claimInto(derived, normalized, entry.slug);
			}
		}
	}

	const perSlug = new Map();
	const contested = [];
	for (const [key, owner] of derived) {
		if (owner === null || authoritative.has(key)) {
			if (owner === null) contested.push(key);
			continue;
		}
		perSlug.set(owner, [...(perSlug.get(owner) ?? []), key]);
	}
	const dropped = contested.length;

	let added = 0;
	for (const entry of doc.slugs) {
		const list = (perSlug.get(entry.slug) ?? []).sort();
		if (list.length > 0) {
			entry.lookup_keys = list;
			added += list.length;
		} else {
			entry.lookup_keys = undefined;
			delete entry.lookup_keys;
		}
		delete entry.variants;
	}

	// UNION, never a replacement. A key reserved on the way in is skipped by pass 2, so it never
	// reaches `contested` again; replacing the list would therefore empty it on the very next run
	// and the protection would last exactly one generation. The union is also what makes this
	// generator idempotent, which the coverage test asserts by regenerating and diffing bytes.
	doc.reserved_derived_keys = [
		...new Set([...(doc.reserved_derived_keys ?? []), ...contested]),
	].sort();
	doc.lookup_keys_generated_by =
		"apps/mem-claw/scripts/generate-attribute-dictionary-variants.mjs";
	const text = `${JSON.stringify(doc, null, 2)}\n`;
	const digest = createHash("sha256").update(text).digest("hex");
	const hashText = `${digest}  attribute-dictionary.json\n`;

	// Both files are staged first and only then renamed into place, so a failure part-way cannot
	// leave the artifact and its hash disagreeing — a state a later integrity check would read as
	// tampering rather than as an interrupted generation.
	const artifactTmp = `${ARTIFACT}.tmp`;
	const hashTmp = `${ARTIFACT}.sha256.tmp`;
	const hashPath = `${ARTIFACT}.sha256`;
	const previousArtifact = readFileSync(ARTIFACT, "utf8");
	const previousHash = readFileSync(hashPath, "utf8");

	// Two renames are two events, so the pair can still be observed half-updated. The old contents
	// are held in memory and the FIRST rename is undone if the second fails, because an artifact
	// sitting beside a stale hash reads to a later integrity check as tampering rather than as an
	// interrupted generation.
	writeFileSync(artifactTmp, text);
	writeFileSync(hashTmp, hashText);
	if (createHash("sha256").update(readFileSync(artifactTmp, "utf8")).digest("hex") !== digest) {
		unlinkSync(artifactTmp);
		unlinkSync(hashTmp);
		throw new Error("staged artifact does not match its computed digest");
	}
	renameSync(artifactTmp, ARTIFACT);
	try {
		renameSync(hashTmp, hashPath);
	} catch (error) {
		writeFileSync(ARTIFACT, previousArtifact);
		writeFileSync(hashPath, previousHash);
		try {
			unlinkSync(hashTmp);
		} catch {
			// nothing staged to clean
		}
		throw error;
	}

	process.stdout.write(`authoritative keys: ${authoritative.size}\n`);
	process.stdout.write(`derived keys kept:  ${added}\n`);
	process.stdout.write(`derived keys dropped: ${dropped} (claimed by more than one slug)\n`);
	process.stdout.write(`sha256:             ${digest}\n`);
}

main();
