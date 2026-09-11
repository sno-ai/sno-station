/** @file markdown-slice-parser.ts
 * @purpose Compatibility exports for reflection markdown parsing.
 * @boundary Keep legacy imports stable while focused parser modules own behavior.
 */

export {
	extractReflectionLearningGovernanceCandidates,
	extractReflectionLessons,
} from "./reflection-governance-parser";
export {
	extractInjectableReflectionMappedMemories,
	extractInjectableReflectionMappedMemoryItems,
	extractReflectionMappedMemories,
	extractReflectionMappedMemoryItems,
} from "./reflection-mapped-memory-parser";
export {
	extractSectionMarkdown,
	parseSectionBullets,
} from "./reflection-markdown-sections";
export {
	PARSER_HEADINGS,
	type ReflectionGovernanceEntry,
	type ReflectionMappedKind,
	type ReflectionMappedMemory,
	type ReflectionMappedMemoryItem,
	type ReflectionSliceItem,
	type ReflectionSlices,
} from "./reflection-markdown-types";
export {
	extractInjectableReflectionSliceItems,
	extractInjectableReflectionSlices,
	extractReflectionSliceItems,
	extractReflectionSlices,
} from "./reflection-slice-extractor";
export {
	isPlaceholderReflectionSliceLine,
	isUnsafeInjectableReflectionLine,
	normalizeReflectionSliceLine,
	sanitizeInjectableReflectionLines,
	sanitizeReflectionSliceLines,
} from "./reflection-slice-sanitizer";
