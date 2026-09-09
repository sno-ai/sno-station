/** @file memory-tool-formatting.ts
 * @purpose Converts memory entries into safe user-visible tool output.
 * @boundary Metadata parsing, recalled-text sanitization, and serialization only.
 */

import { sanitizeContentIngress } from "@snoai/content-sanitizer";
import { stripHtmlTags, stripRoleLabelPrefix } from "../shared/i18n-text";
import { isoDateFromMs } from "../shared/iso-date-time";

export function sanitizeRecalledText(text: string): string {
	// Centralize the tool execution fallback value at the boundary of this helper.
	const projected = sanitizeContentIngress({
		source: "generic-text",
		content: text,
	}).projections.plainText;
	return stripRoleLabelPrefix(stripHtmlTags(projected));
}

export function safeParseMetadata(raw: string): unknown {
	// Isolate the tool execution operation that can fail because of runtime I/O or input shape.
	try {
		// Parse serialized metadata inside the narrowest block that can recover from bad JSON.
		return JSON.parse(raw);
	} catch {
		// Preserve invalid metadata as inspectable payload instead of throwing.
		return { _invalidMetadata: raw };
	}
}

export function parseEntryMetadata(entry: { metadata?: string }): Record<string, unknown> {
	// Isolate the tool execution operation that can fail because of runtime I/O or input shape.
	if (!entry.metadata) return {};
	// Isolate the tool execution operation that can fail because of runtime I/O or input shape.
	try {
		// Parse serialized metadata inside the narrowest block that can recover from bad JSON.
		const parsed: unknown = JSON.parse(entry.metadata);
		// Return object metadata only; all other JSON values are ignored.
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		// Corrupt metadata should not break display logic.
		return {};
	}
}

/**
 * Event date (`YYYY-MM-DD`) to surface for a dateable (episodic) memory in
 * recall output, or undefined for non-episodic memories. Prefers the resolved
 * `event_at` (an ISO string — always present on episodic rows) and falls back
 * to `valid_from` (ms epoch) defensively. Giving the agent the event date is
 * what lets it answer time-scoped questions ("this week", "last month").
 */
export function episodicEventDate(entry: { metadata?: string }): string | undefined {
	const metadata = parseEntryMetadata(entry);
	if (metadata.kind !== "episodic") return undefined;
	const eventAt = metadata.event_at;
	if (typeof eventAt === "string" && eventAt.length >= 10) return eventAt.slice(0, 10);
	if (typeof eventAt === "number" && eventAt > 0) return isoDateFromMs(eventAt);
	const validFrom = metadata.valid_from;
	if (typeof validFrom === "number" && validFrom > 0) return isoDateFromMs(validFrom);
	return undefined;
}

export function isReflectionEntry(entry: { category: string; metadata?: string }): boolean {
	// Isolate the tool execution operation that can fail because of runtime I/O or input shape.
	const metadata = parseEntryMetadata(entry);
	// Centralize the tool execution fallback value at the boundary of this helper.
	return (
		metadata.type === "memory-reflection" ||
		metadata.type === "memory-reflection-event" ||
		metadata.type === "memory-reflection-item" ||
		metadata.type === "memory-reflection-mapped"
	);
}

export function getDisplayCategoryTag(entry: {
	category: string;
	projectId: string;
	metadata?: string;
}): string {
	// Isolate the tool execution operation that can fail because of runtime I/O or input shape.
	if (isReflectionEntry(entry)) {
		// Isolate the tool execution operation that can fail because of runtime I/O or input shape.
		return `reflection:${entry.projectId}`;
	}
	// Isolate the tool execution operation that can fail because of runtime I/O or input shape.
	return `${entry.category}:${entry.projectId}`;
}

export function serializeMemory(entry: {
	id: string;
	text: string;
	category: string;
	projectId: string;
	importance: number;
	timestamp: number;
	metadata: string;
}): Record<string, unknown> {
	// Return the normalized tool execution payload expected by callers.
	return {
		id: entry.id,
		text: sanitizeRecalledText(entry.text),
		category: getDisplayCategoryTag(entry),
		rawCategory: entry.category,
		scope: entry.projectId,
		importance: entry.importance,
		timestamp: new Date(entry.timestamp).toISOString(),
	};
}
