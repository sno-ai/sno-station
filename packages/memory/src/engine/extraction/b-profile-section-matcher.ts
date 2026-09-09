/** @file b-profile-section-matcher.ts
 * @purpose Deterministically addresses B-profile candidates across the supported locales.
 * @boundary Fallback fills general forms; correction reuses a registered key only on a decisive match.
 */

import { getActiveSectionRegistry } from "./b-profile-section-dictionary-provider";
import {
	canonicalizeProfileSectionName,
	normalizeProfileSectionForm,
} from "./b-profile-section-canonicalizer";
import type { BProfileSectionRegistry } from "./b-profile-section-registry";
import { boundaryAwareRegex, normalizeForCompare, tokenizeForFts } from "../shared/i18n-text";

const MINIMUM_SCORE = 0.58;
const MINIMUM_WIN_MARGIN = 0.05;
const SPECIFIC_SECTION_PATTERN =
	/^[a-z0-9]+(?:_[a-z0-9]+)*\.[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/;
const compiledRegistryCache = new WeakMap<BProfileSectionRegistry, readonly CompiledTerm[]>();

type ScriptBucket = "latin" | "cyrillic" | "han" | "japanese" | "hangul" | "other";

interface CompiledTerm {
	sectionName: string;
	normalized: string;
	pattern: RegExp;
	tokens: ReadonlySet<string>;
	bigrams: ReadonlySet<string>;
	scripts: ReadonlySet<ScriptBucket>;
}

export type BProfileSectionMatch =
	| { outcome: "matched"; sectionName: string; score: number }
	| { outcome: "ambiguous" | "no-hit"; sectionName: undefined; score: number };

export type BProfileSectionFallbackResult =
	| {
			matcherInvoked: false;
			outcome: "preserved";
			sectionName: string;
	  }
	| {
			matcherInvoked: true;
			outcome: "matched";
			sectionName: string;
			score: number;
	  }
	| {
			matcherInvoked: true;
			outcome: "ambiguous" | "no-hit";
			sectionName: "preferences.general";
			score: number;
	  };

export type BProfileSectionCorrectionResult =
	| {
			matcherInvocations: 0;
			outcome: "preserved";
			sectionName: string;
	  }
	| {
			matcherInvocations: number;
			outcome: "matched" | "ambiguous" | "no-hit";
			sectionName: string;
			score: number;
	  };

export function matchBProfileSection(
	text: string,
	registry: BProfileSectionRegistry = getActiveSectionRegistry(),
): BProfileSectionMatch {
	const normalizedText = normalizeForCompare(text);
	if (!normalizedText) return { outcome: "no-hit", sectionName: undefined, score: 0 };

	const inputScripts = scriptBuckets(normalizedText);
	const terms = compiledTerms(registry).filter((term) => sharesScript(inputScripts, term.scripts));
	const directScores = new Map<string, number>();
	for (const term of terms) {
		const score = normalizedText === term.normalized ? 1 : term.pattern.test(normalizedText) ? 0.95 : 0;
		if (score > (directScores.get(term.sectionName) ?? 0)) {
			directScores.set(term.sectionName, score);
		}
	}
	if (directScores.size > 0) return resolveMatch(directScores);

	const inputTokens = new Set(tokenizeForFts(normalizedText));
	const inputBigrams = characterBigrams(normalizedText);
	const fuzzyScores = new Map<string, number>();
	for (const term of terms) {
		const score = Math.max(
			tokenDiceSets(inputTokens, term.tokens),
			diceSets(inputBigrams, term.bigrams),
		);
		if (score > (fuzzyScores.get(term.sectionName) ?? 0)) {
			fuzzyScores.set(term.sectionName, score);
		}
	}
	return resolveMatch(fuzzyScores);
}

function resolveMatch(scores: ReadonlyMap<string, number>): BProfileSectionMatch {
	const ranked = [...scores]
		.map(([sectionName, score]) => ({ sectionName, score }))
		.filter((candidate) => candidate.score >= MINIMUM_SCORE)
		.sort(
			(left, right) =>
				right.score - left.score || left.sectionName.localeCompare(right.sectionName),
		);
	const best = ranked[0];
	if (!best) return { outcome: "no-hit", sectionName: undefined, score: 0 };
	const runnerUp = ranked[1];
	if (runnerUp && best.score - runnerUp.score < MINIMUM_WIN_MARGIN) {
		return { outcome: "ambiguous", sectionName: undefined, score: best.score };
	}
	return { outcome: "matched", sectionName: best.sectionName, score: best.score };
}

export function addressBProfileSectionFallback(args: {
	sectionName?: string;
	text: string;
	registry?: BProfileSectionRegistry;
}): BProfileSectionFallbackResult {
	if (isValidSpecificSection(args.sectionName)) {
		return {
			matcherInvoked: false,
			outcome: "preserved",
			sectionName: args.sectionName,
		};
	}
	const match = matchBProfileSection(args.text, args.registry);
	if (match.outcome === "matched") {
		return { matcherInvoked: true, ...match };
	}
	return {
		matcherInvoked: true,
		outcome: match.outcome,
		sectionName: "preferences.general",
		score: match.score,
	};
}

export function reconcileBProfileSectionForCorrection(args: {
	sectionName?: string;
	rawTopicPhrase?: string;
	content: string;
	registry?: BProfileSectionRegistry;
}): BProfileSectionCorrectionResult {
	if (args.sectionName === "identity" || args.sectionName === "active_tasks") {
		return {
			matcherInvocations: 0,
			outcome: "preserved",
			sectionName: args.sectionName,
		};
	}
	if (!isValidSpecificSection(args.sectionName)) {
		const fallback = addressBProfileSectionFallback({
			sectionName: args.sectionName,
			text: args.rawTopicPhrase ?? args.content,
			registry: args.registry,
		});
		if (!fallback.matcherInvoked) {
			return {
				matcherInvocations: 0,
				outcome: fallback.outcome,
				sectionName: fallback.sectionName,
			};
		}
		return { matcherInvocations: 1, ...fallback };
	}

	const addressSignal =
		args.rawTopicPhrase?.trim() || args.sectionName.split(".").at(-1)?.replaceAll("_", " ") || "";
	const addressMatch = matchBProfileSection(addressSignal, args.registry);
	if (addressMatch.outcome === "matched") {
		return { matcherInvocations: 1, ...addressMatch };
	}
	const contentMatch = matchBProfileSection(args.content, args.registry);
	if (contentMatch.outcome === "matched") {
		return { matcherInvocations: 2, ...contentMatch };
	}
	return {
		matcherInvocations: 2,
		outcome: contentMatch.outcome,
		sectionName: args.sectionName,
		score: contentMatch.score,
	};
}

function isValidSpecificSection(sectionName: string | undefined): sectionName is string {
	if (!sectionName) return false;
	const trimmed = sectionName.trim();
	if (trimmed !== sectionName) return false;
	const canonical = canonicalizeProfileSectionName(normalizeProfileSectionForm(trimmed));
	if (canonical === "identity" || canonical === "active_tasks") return true;
	return canonical !== "preferences.general" && SPECIFIC_SECTION_PATTERN.test(canonical);
}

function compiledTerms(registry: BProfileSectionRegistry): readonly CompiledTerm[] {
	const cached = compiledRegistryCache.get(registry);
	if (cached) return cached;
	const compiled: CompiledTerm[] = [];
	const seen = new Set<string>();
	for (const section of registry.sections) {
		if (section.name === "preferences.general") continue;
		for (const rawTerm of Object.values(section.synonyms).flat()) {
			const normalized = normalizeForCompare(rawTerm);
			const key = `${section.name}\0${normalized}`;
			if (!normalized || seen.has(key)) continue;
			seen.add(key);
			compiled.push({
				sectionName: section.name,
				normalized,
				pattern: boundaryAwareRegex(normalized),
				tokens: new Set(tokenizeForFts(normalized)),
				bigrams: characterBigrams(normalized),
				scripts: scriptBuckets(normalized),
			});
		}
	}
	compiledRegistryCache.set(registry, compiled);
	return compiled;
}

function tokenDiceSets(
	leftTokens: ReadonlySet<string>,
	rightTokens: ReadonlySet<string>,
): number {
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	return diceSets(leftTokens, rightTokens);
}

export function characterBigramDice(left: string, right: string): number {
	return diceSets(characterBigrams(left), characterBigrams(right));
}

function diceSets(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const value of left) {
		if (right.has(value)) shared += 1;
	}
	return (2 * shared) / (left.size + right.size);
}

function characterBigrams(text: string): Set<string> {
	const characters = [...normalizeForCompare(text).replace(/[^\p{L}\p{N}]/gu, "")];
	const bigrams = new Set<string>();
	for (let index = 0; index < characters.length - 1; index += 1) {
		bigrams.add(`${characters[index]}${characters[index + 1]}`);
	}
	return bigrams;
}

function scriptBuckets(text: string): ReadonlySet<ScriptBucket> {
	const buckets = new Set<ScriptBucket>();
	if (/\p{Script=Latin}/u.test(text)) buckets.add("latin");
	if (/\p{Script=Cyrillic}/u.test(text)) buckets.add("cyrillic");
	if (/\p{Script=Han}/u.test(text)) buckets.add("han");
	if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) buckets.add("japanese");
	if (/\p{Script=Hangul}/u.test(text)) buckets.add("hangul");
	if (buckets.size === 0) buckets.add("other");
	return buckets;
}

function sharesScript(
	left: ReadonlySet<ScriptBucket>,
	right: ReadonlySet<ScriptBucket>,
): boolean {
	for (const bucket of left) {
		if (right.has(bucket)) return true;
	}
	return false;
}
