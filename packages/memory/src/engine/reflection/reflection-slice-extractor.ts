/** @file reflection-slice-extractor.ts
 * @purpose Classifies reflection markdown into invariant and derived slice items.
 * @boundary Slice extraction only; mapped-memory parsing lives separately.
 */

import { RESOURCES_BY_LOCALE } from "../i18n/all-resources";
import type { ReflectionSliceClassifiersNs } from "../i18n/res/_types";
import { resolveLocale } from "../i18n/resolver";
import { parseSectionBullets } from "./reflection-markdown-sections";
import {
	PARSER_HEADINGS,
	type ReflectionSliceItem,
	type ReflectionSlices,
} from "./reflection-markdown-types";
import {
	sanitizeInjectableReflectionLines,
	sanitizeReflectionSliceLines,
} from "./reflection-slice-sanitizer";

/** Tests whether is invariant rule like without mutating reflection text slicing state. */
function isInvariantRuleLike(line: string, classifiers: ReflectionSliceClassifiersNs): boolean {
	return classifiers.invariantSignals.some((pattern) => testPattern(pattern, line));
}

/** Tests whether is derived delta like without mutating reflection text slicing state. */
function isDerivedDeltaLike(line: string, classifiers: ReflectionSliceClassifiersNs): boolean {
	return classifiers.derivedSignals.some((pattern) => testPattern(pattern, line));
}

/** Tests whether is open loop action without mutating reflection text slicing state. */
function isOpenLoopAction(line: string, classifiers: ReflectionSliceClassifiersNs): boolean {
	return classifiers.openLoopSignals.some((pattern) => testPattern(pattern, line));
}

function testPattern(pattern: RegExp, text: string): boolean {
	pattern.lastIndex = 0;
	const matches = pattern.test(text);
	pattern.lastIndex = 0;
	return matches;
}

/**
 * Extracts reflection slices with sanitizer from raw runtime payloads with partial-data
 * tolerance.
 */
function extractReflectionSlicesWithSanitizer(
	reflectionText: string,
	sanitizeLines: (lines: string[]) => string[],
): ReflectionSlices {
	const classifiers =
		RESOURCES_BY_LOCALE[resolveLocale({ text: reflectionText })].reflectionSliceClassifiers;
	const invariantSection = parseSectionBullets(reflectionText, PARSER_HEADINGS.invariants);
	const derivedSection = parseSectionBullets(reflectionText, PARSER_HEADINGS.derived);
	const mergedSection = parseSectionBullets(
		reflectionText,
		PARSER_HEADINGS.invariantsAndReflections,
	);

	const invariantsPrimary = sanitizeLines(invariantSection);
	const derivedPrimary = sanitizeLines(derivedSection);

	const invariantLinesLegacy = sanitizeLines(
		mergedSection.filter((line) =>
			classifiers.invariantLegacySignals.some((pattern) => testPattern(pattern, line)),
		),
	).filter((line) => isInvariantRuleLike(line, classifiers));
	const reflectionLinesLegacy = sanitizeLines(
		mergedSection.filter((line) =>
			classifiers.derivedLegacySignals.some((pattern) => testPattern(pattern, line)),
		),
	).filter((line) => isDerivedDeltaLike(line, classifiers));
	const openLoopLines = sanitizeLines(
		parseSectionBullets(reflectionText, PARSER_HEADINGS.openLoops),
	).filter((line) => isOpenLoopAction(line, classifiers));
	const durableDecisionLines = sanitizeLines(
		parseSectionBullets(reflectionText, PARSER_HEADINGS.decisionsDurable),
	).filter((line) => isInvariantRuleLike(line, classifiers));

	const invariants =
		invariantsPrimary.length > 0
			? invariantsPrimary
			: invariantSection.length > 0
				? []
				: invariantLinesLegacy.length > 0
					? invariantLinesLegacy
					: mergedSection.length > 0
						? []
						: durableDecisionLines;
	const derived =
		derivedPrimary.length > 0 ? derivedPrimary : [...reflectionLinesLegacy, ...openLoopLines];

	return {
		invariants: invariants.slice(0, 8),
		derived: derived.slice(0, 10),
	};
}

/** Extracts reflection slices from raw inputs while tolerating partial data. */
export function extractReflectionSlices(reflectionText: string): ReflectionSlices {
	return extractReflectionSlicesWithSanitizer(reflectionText, sanitizeReflectionSliceLines);
}

/** Extracts injectable reflection slices from raw inputs while tolerating partial data. */
export function extractInjectableReflectionSlices(reflectionText: string): ReflectionSlices {
	return extractReflectionSlicesWithSanitizer(reflectionText, sanitizeInjectableReflectionLines);
}

/**
 * Assembles reflection slice items from slices from validated inputs for deterministic reflection
 * text slicing.
 */
function buildReflectionSliceItemsFromSlices(slices: ReflectionSlices): ReflectionSliceItem[] {
	const invariantGroupSize = slices.invariants.length;
	const derivedGroupSize = slices.derived.length;

	const invariantItems = slices.invariants.map((text, ordinal) => ({
		text,
		itemKind: "invariant" as const,
		section: "Invariants" as const,
		ordinal,
		groupSize: invariantGroupSize,
	}));
	const derivedItems = slices.derived.map((text, ordinal) => ({
		text,
		itemKind: "derived" as const,
		section: "Derived" as const,
		ordinal,
		groupSize: derivedGroupSize,
	}));

	return [...invariantItems, ...derivedItems];
}

/** Extracts reflection slice items from raw inputs while tolerating partial data. */
export function extractReflectionSliceItems(reflectionText: string): ReflectionSliceItem[] {
	return buildReflectionSliceItemsFromSlices(extractReflectionSlices(reflectionText));
}

/**
 * Extracts injectable reflection slice items from raw inputs while tolerating partial data.
 */
export function extractInjectableReflectionSliceItems(
	reflectionText: string,
): ReflectionSliceItem[] {
	return buildReflectionSliceItemsFromSlices(extractInjectableReflectionSlices(reflectionText));
}
