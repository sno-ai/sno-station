/** @file reflection-mapped-memory-parser.ts
 * @purpose Extracts mapped memory rows from reflection markdown sections.
 * @boundary Reflection markdown to mapped-memory DTOs only.
 */

import { parseSectionBullets } from "./reflection-markdown-sections";
import {
	PARSER_HEADINGS,
	type ReflectionMappedKind,
	type ReflectionMappedMemory,
	type ReflectionMappedMemoryItem,
} from "./reflection-markdown-types";
import {
	sanitizeInjectableReflectionLines,
	sanitizeReflectionSliceLines,
} from "./reflection-slice-sanitizer";
import type { MemoryCategory } from "../shared/types";

/**
 * Extracts reflection mapped memories from raw runtime payloads with partial-data tolerance.
 */
export function extractReflectionMappedMemories(reflectionText: string): ReflectionMappedMemory[] {
	return extractReflectionMappedMemoryItems(reflectionText).map(({ text, category, heading }) => ({
		text,
		category,
		heading,
	}));
}

/**
 * Extracts reflection mapped memory items with sanitizer from raw inputs while tolerating
 * partial data.
 */
function extractReflectionMappedMemoryItemsWithSanitizer(
	reflectionText: string,
	sanitizeLines: (lines: string[]) => string[],
): ReflectionMappedMemoryItem[] {
	const mappedSections: Array<{
		heading: string;
		category: MemoryCategory;
		mappedKind: ReflectionMappedKind;
	}> = [
		{
			heading: PARSER_HEADINGS.userModelDeltas,
			category: "profile",
			mappedKind: "user-model",
		},
		{
			heading: PARSER_HEADINGS.agentModelDeltas,
			category: "lesson",
			mappedKind: "agent-model",
		},
		{
			heading: PARSER_HEADINGS.lessonsAndPitfalls,
			category: "lesson",
			mappedKind: "lesson",
		},
		{
			heading: PARSER_HEADINGS.decisionsDurable,
			category: "episodic",
			mappedKind: "decision",
		},
	];

	return mappedSections.flatMap(({ heading, category, mappedKind }) => {
		const lines = sanitizeLines(parseSectionBullets(reflectionText, heading));
		const groupSize = lines.length;
		return lines.map((text, ordinal) => ({
			text,
			category,
			heading,
			mappedKind,
			ordinal,
			groupSize,
		}));
	});
}

/** Extracts reflection mapped memory items from raw inputs while tolerating partial data. */
export function extractReflectionMappedMemoryItems(
	reflectionText: string,
): ReflectionMappedMemoryItem[] {
	return extractReflectionMappedMemoryItemsWithSanitizer(
		reflectionText,
		sanitizeReflectionSliceLines,
	);
}

/**
 * Extracts injectable reflection mapped memory items from raw inputs while tolerating partial
 * data.
 */
export function extractInjectableReflectionMappedMemoryItems(
	reflectionText: string,
): ReflectionMappedMemoryItem[] {
	return extractReflectionMappedMemoryItemsWithSanitizer(
		reflectionText,
		sanitizeInjectableReflectionLines,
	);
}

/**
 * Extracts injectable reflection mapped memories from raw inputs while tolerating partial
 * data.
 */
export function extractInjectableReflectionMappedMemories(
	reflectionText: string,
): ReflectionMappedMemory[] {
	return extractInjectableReflectionMappedMemoryItems(reflectionText).map(
		({ text, category, heading }) => ({ text, category, heading }),
	);
}
