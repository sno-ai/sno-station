/** @file entry-metadata-parser.ts
 * @purpose Defines metadata helpers for reflection provenance, severity, and grouping.
 * @boundary Reflection item storage, retry handling, and reporting surfaces.
 * @see daily-log-generator.ts, slice-item-payload-builder.ts, transient-generation-retry.ts.
 */

/**
 * Reflection metadata parsing utilities.
 */

export function parseReflectionMetadata(metadataRaw: string | undefined): Record<string, unknown> {
	// Guard this branch early so the remaining reflection capture path works with normalized inputs.
	if (!metadataRaw) return {};
	try {
		// Parse serialized metadata inside the narrowest block that can recover from bad JSON.
		const parsed = JSON.parse(metadataRaw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * Tests whether is reflection entry without mutating reflection metadata normalization state.
 */
export function isReflectionEntry(entry: { category: string; metadata?: string }): boolean {
	// Isolate the module behavior operation that can fail because of runtime I/O or input shape.
	const metadata = parseReflectionMetadata(entry.metadata);
	return (
		metadata.type === "memory-reflection" ||
		metadata.type === "memory-reflection-event" ||
		metadata.type === "memory-reflection-item" ||
		metadata.type === "memory-reflection-mapped"
	);
}

/**
 * Returns display category tag from reflection metadata normalization state without side effects.
 */
export function getDisplayCategoryTag(entry: {
	category: string;
	scope: string;
	metadata?: string;
}): string {
	// Isolate the module behavior operation that can fail because of runtime I/O or input shape.
	if (!isReflectionEntry(entry)) return `${entry.category}:${entry.scope}`;
	// Isolate the module behavior operation that can fail because of runtime I/O or input shape.
	return `reflection:${entry.scope}`;
}
