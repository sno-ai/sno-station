/** @file memory-tool-formatting.ts
 * @purpose Converts memory entries into safe user-visible tool output.
 * @boundary Metadata parsing, recalled-text sanitization, and serialization only.
 */

import { sanitizeContentIngress } from "@snoai/content-sanitizer";
import { stripHtmlTags, stripRoleLabelPrefix } from "../shared/i18n-text";
import { normalizeIsoDateTimeString } from "../shared/iso-date-time";
import { isCalendarLabel } from "../extraction/calendar-instruction";

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

/** Display the resolved event precision; unresolved text never inherits a record timestamp. */
export function episodicEventDate(entry: { metadata?: string }): string | undefined {
	const metadata = parseEntryMetadata(entry);
	if (metadata.kind !== "episodic") return undefined;
	if (metadata.temporal_resolution_status === "unresolved" || metadata.temporal_resolution_status === "static") return undefined;
	if (isCalendarLabel(metadata.temporal_date, metadata.temporal_precision)) return metadata.temporal_date;
	const eventAt = metadata.event_at;
	const iso = normalizeIsoDateTimeString(eventAt);
	if (iso !== undefined) return iso.slice(0, 10);
	if (typeof eventAt === "number") {
		const date = new Date(eventAt);
		if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
	}
	return undefined;
}

/**
 * The sentence a row was written from, exactly as it was said.
 *
 * A row's `text` is what the extractor made of that sentence, and extraction paraphrases: asked
 * what a poster said, a row reading "posters full of pride and strength" cannot answer "Trans
 * Lives Matter" even though the turn contained it, and asked how someone described a dancer, a row
 * reading "talented and passionate" cannot answer "graceful". Both wordings are already in the
 * store beside the paraphrase; until 2026-09-15 only the paraphrase was ever shown to a model.
 *
 * Absent for a row written from a shared photo, and for anything rewritten by a maintenance wave.
 */
export function sourceQuote(entry: { metadata?: string }): string | undefined {
	const span = parseEntryMetadata(entry).source_span;
	if (!span || typeof span !== "object") return undefined;
	const quote = (span as { quote?: unknown }).quote;
	return typeof quote === "string" && quote.trim().length > 0 ? quote : undefined;
}

/**
 * The calendar day a row was said: the session moment it was extracted in, the anchor every
 * relative date resolved against. A row with no session moment (rewritten by a maintenance wave,
 * or written before source order existed) makes no claim about when it was said — its row
 * timestamp is when it was written, which is not the same day.
 */
export function saidOnDate(entry: { metadata?: string }): string | undefined {
	const order = parseEntryMetadata(entry).source_order;
	const moment = order && typeof order === "object" ? (order as Record<string, unknown>).session_moment : undefined;
	if (typeof moment !== "number") return undefined;
	const date = new Date(moment);
	return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
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
