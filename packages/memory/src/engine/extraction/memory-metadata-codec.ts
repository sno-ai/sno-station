/** @file memory-metadata-codec.ts
 * @purpose Normalizes extracted metadata into typed fields for ranking and filtering.
 * @boundary Extractor output, preference slots, and store metadata persistence.
 * @see memory-metadata-normalizers.ts, memory-support-info.ts.
 */

import {
	clamp01,
	clampCount,
	defaultOverview,
	deriveDefaultLayer,
	deriveFactKey,
	normalizeLayer,
	normalizeOptionalString,
	normalizeOptionalTimestamp,
	normalizeSource,
	normalizeState,
	normalizeText,
	normalizeTier,
	normalizeTimestamp,
	validateMemoryCategory,
} from "./memory-metadata-normalizers";
import type {
	EntryLike,
	InsightMetadata,
	InsightMetadataPatch,
	MemoryRelation,
} from "./memory-metadata-types";
import { memoryMetadata } from "./memory-metadata-types";
import { normalizeIsoDateTimeString } from "../shared/iso-date-time";
import type { MemoryCategory } from "../shared/types";

function normalizeEventTime(value: unknown): string | number | undefined {
	const iso = normalizeIsoDateTimeString(value);
	if (iso !== undefined) return iso;
	if (typeof value === "number" && Number.isFinite(new Date(value).getTime())) return value;
	return undefined;
}

export { deriveFactKey } from "./memory-metadata-normalizers";
export type {
	EntryLike,
	InsightMetadata,
	InsightMetadataPatch,
	MemoryLayer,
	MemoryRelation,
	MemorySource,
	MemoryState,
} from "./memory-metadata-types";
export {
	type ContextualSupport,
	MAX_SUPPORT_SLICES,
	normalizeContext,
	parseSupportInfo,
	SUPPORT_CONTEXT_VOCABULARY,
	type SupportContext,
	type SupportInfoV2,
	updateSupportStats,
} from "./memory-support-info";

export class ExtractionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExtractionError";
	}
}

/** Check if a memory has passed its temporal expiry (valid_until). */
export function isMemoryExpired(
	metadata: Pick<InsightMetadata, "valid_until" | "memory_category">,
	at: number = Date.now(),
): boolean {
	// An episodic row's valid_from/valid_until describe the EVENT's window, not the memory's
	// lifetime — the classifier writes the day of "support date 2026-07-14" as valid_until
	// 2026-07-15, so a record of any past event would count as expired the moment it was
	// written. Recording an event never expires; only a current-state claim can lapse.
	// Found 2026-08-30 while tracing the same conflation on the row-timestamp path, where a
	// content date written as the memory's age let time decay bury a rank-1 answer.
	if (metadata.memory_category === "episodic") return false;
	return metadata.valid_until != null && metadata.valid_until <= at;
}

function parseRawMetadata(rawMetadata: string | undefined): Record<string, unknown> {
	if (!rawMetadata) return {};
	try {
		const obj = JSON.parse(rawMetadata);
		if (obj && typeof obj === "object") {
			return obj as Record<string, unknown>;
		}
	} catch {
		return {};
	}
	return {};
}

function readCategoryField(label: string, value: unknown): MemoryCategory | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`memory-metadata-codec: ${label} category must be a string`);
	}
	const category = validateMemoryCategory(value);
	if (!category) {
		throw new Error(`memory-metadata-codec: unrecognized ${label} category: ${value}`);
	}
	return category;
}

function resolveMemoryCategory(fields: Array<{ label: string; value: unknown }>): MemoryCategory {
	const categories = fields
		.map((field) => readCategoryField(field.label, field.value))
		.filter((category): category is MemoryCategory => category !== undefined);
	const first = categories[0];
	if (!first) {
		throw new Error("memory-metadata-codec: missing memory category/kind");
	}
	if (categories.some((category) => category !== first)) {
		throw new Error(
			`memory-metadata-codec: row/category/kind mismatch (${fields
				.map((field) => `${field.label}=${String(field.value)}`)
				.join(", ")})`,
		);
	}
	return first;
}

function parseNormalizedMetadata(candidate: Record<string, unknown>): InsightMetadata {
	const result = memoryMetadata.safeParse(candidate);
	if (result.success) return result.data;
	const message = result.error.issues
		.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
		.join("; ");
	throw new Error(`memory-metadata-codec: invalid metadata (${message})`);
}

function requireNonEmptyField(
	kind: MemoryCategory,
	field: "section_name" | "anti_pattern_signature",
	value: unknown,
): string {
	const normalized = normalizeOptionalString(value);
	if (normalized) return normalized;
	throw new ExtractionError(`memory-metadata-codec: ${field} is required for ${kind} metadata`);
}

function normalizeInsightMetadata(
	parsed: Record<string, unknown>,
	entry: EntryLike,
	patch: InsightMetadataPatch = {},
): InsightMetadata {
	const text = typeof patch.l2_content === "string" ? patch.l2_content : entry.text ?? "";
	const timestamp =
		typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
			? entry.timestamp
			: Date.now();
	const memoryCategory = resolveMemoryCategory([
		{ label: "metadata.kind", value: parsed.kind },
		{ label: "metadata.memory_category", value: parsed.memory_category },
		{ label: "entry", value: entry.category },
		{ label: "patch.kind", value: patch.kind },
		{ label: "patch.memory_category", value: patch.memory_category },
	]);
	const l0 = normalizeText(patch.l0_abstract ?? parsed.l0_abstract, text);
	const l2 = normalizeText(patch.l2_content ?? parsed.l2_content, text);
	const validFrom = normalizeTimestamp(patch.valid_from ?? parsed.valid_from, timestamp);
	const invalidatedAt =
		patch.invalidated_at === undefined
			? normalizeOptionalTimestamp(parsed.invalidated_at)
			: normalizeOptionalTimestamp(patch.invalidated_at);
	const fallbackSource =
		parsed.type === "session-summary"
			? "session-summary"
			: parsed.type === "memory-reflection" ||
				  parsed.type === "memory-reflection-item" ||
				  parsed.type === "memory-reflection-event" ||
				  parsed.type === "memory-reflection-mapped"
				? "reflection"
				: "legacy";
	const source = normalizeSource(patch.source ?? parsed.source ?? fallbackSource);
	const defaultState = source === "session-summary" ? "archived" : "confirmed";
	const state = normalizeState(patch.state ?? parsed.state ?? defaultState);
	const memoryLayer = normalizeLayer(
		patch.memory_layer ?? parsed.memory_layer ?? deriveDefaultLayer(source, memoryCategory, state),
	);
	const candidate: Record<string, unknown> = {
		...parsed,
		...patch,
		kind: memoryCategory,
		l0_abstract: l0,
		l1_overview: normalizeText(patch.l1_overview ?? parsed.l1_overview, defaultOverview(l0)),
		l2_content: l2,
		memory_category: memoryCategory,
		tier: normalizeTier(
			patch.tier ?? parsed.tier ?? (memoryCategory === "profile" ? "core" : "working"),
		),
		access_count: clampCount(patch.access_count ?? parsed.access_count, 0),
		confidence: clamp01(patch.confidence ?? parsed.confidence, 0.7),
		last_accessed_at: clampCount(patch.last_accessed_at ?? parsed.last_accessed_at, timestamp),
		asserted_at: normalizeTimestamp(patch.asserted_at ?? parsed.asserted_at, timestamp),
		valid_from: validFrom,
		invalidated_at: invalidatedAt && invalidatedAt >= validFrom ? invalidatedAt : undefined,
		supersedes: normalizeOptionalString(patch.supersedes ?? parsed.supersedes),
		superseded_by: normalizeOptionalString(patch.superseded_by ?? parsed.superseded_by),
		source_session:
			typeof (patch.source_session ?? parsed.source_session) === "string"
				? (patch.source_session ?? parsed.source_session)
				: undefined,
		state,
		source,
		memory_layer: memoryLayer,
		injected_count: clampCount(patch.injected_count ?? parsed.injected_count, 0),
		last_injected_at: normalizeOptionalTimestamp(patch.last_injected_at ?? parsed.last_injected_at),
		last_confirmed_use_at: normalizeOptionalTimestamp(
			patch.last_confirmed_use_at ?? parsed.last_confirmed_use_at,
		),
		bad_recall_count: clampCount(patch.bad_recall_count ?? parsed.bad_recall_count, 0),
		suppressed_until_turn: clampCount(
			patch.suppressed_until_turn ?? parsed.suppressed_until_turn,
			0,
		),
		canonical_id: normalizeOptionalString(patch.canonical_id ?? parsed.canonical_id),
		memory_temporal_type:
			(patch.memory_temporal_type ?? parsed.memory_temporal_type) === "static" ||
			(patch.memory_temporal_type ?? parsed.memory_temporal_type) === "dynamic"
				? (patch.memory_temporal_type ?? parsed.memory_temporal_type)
				: undefined,
		temporal_resolution_status:
			(patch.temporal_resolution_status ?? parsed.temporal_resolution_status) === "resolved" ||
			(patch.temporal_resolution_status ?? parsed.temporal_resolution_status) === "unresolved" ||
			(patch.temporal_resolution_status ?? parsed.temporal_resolution_status) === "static"
				? (patch.temporal_resolution_status ?? parsed.temporal_resolution_status)
				: undefined,
		temporal_phrase: normalizeOptionalString(patch.temporal_phrase ?? parsed.temporal_phrase),
		valid_until: normalizeOptionalTimestamp(patch.valid_until ?? parsed.valid_until),
	};

	if (memoryCategory === "episodic") {
		// A record timestamp and a range boundary do not establish an event day.
		const dayUnknown = candidate.temporal_resolution_status === "unresolved" ||
			candidate.temporal_resolution_status === "static" ||
			["year", "month", "week"].includes(String(candidate.temporal_precision));
		if (candidate.temporal_resolution_status === "unresolved" || candidate.temporal_resolution_status === "static") {
			delete candidate.valid_from;
			delete candidate.valid_until;
		}
		candidate.event_at =
			normalizeEventTime(patch.event_at) ??
			(dayUnknown ? undefined : normalizeEventTime(parsed.event_at));
		if (candidate.event_at === undefined && candidate.temporal_date === undefined && candidate.temporal_resolution_status === undefined) {
			candidate.temporal_resolution_status = "unresolved";
			delete candidate.valid_from;
			delete candidate.valid_until;
		}
		candidate.entity_kind = normalizeOptionalString(patch.entity_kind ?? parsed.entity_kind);
	}
	if (memoryCategory === "profile") {
		candidate.section_name = requireNonEmptyField(
			memoryCategory,
			"section_name",
			patch.section_name ?? parsed.section_name,
		);
		candidate.rawTopicPhrase = normalizeOptionalString(
			patch.rawTopicPhrase ?? parsed.rawTopicPhrase,
		);
	}
	if (memoryCategory === "persona") {
		candidate.section_name = requireNonEmptyField(
			memoryCategory,
			"section_name",
			patch.section_name ?? parsed.section_name,
		);
	}
	if (memoryCategory === "lesson") {
		candidate.anti_pattern_signature = requireNonEmptyField(
			memoryCategory,
			"anti_pattern_signature",
			patch.anti_pattern_signature ?? parsed.anti_pattern_signature,
		);
	}
	if (memoryCategory === "summary") {
		candidate.children_ids = patch.children_ids ?? parsed.children_ids;
		candidate.depth = patch.depth ?? parsed.depth;
	}

	const derivedFactKey = deriveFactKey(candidate as Parameters<typeof deriveFactKey>[0]);
	candidate.fact_key =
		derivedFactKey ??
		(memoryCategory === "episodic"
			? normalizeOptionalString(patch.fact_key ?? parsed.fact_key)
			: undefined);

	return parseNormalizedMetadata(candidate);
}

/** Parses insight metadata into the normalized shape expected by insight metadata parsing. */
export function parseInsightMetadata(
	rawMetadata: string | undefined,
	entry: EntryLike = {},
): InsightMetadata {
	return normalizeInsightMetadata(parseRawMetadata(rawMetadata), entry);
}

/** Assembles insight metadata from validated inputs for deterministic insight metadata parsing. */
export function buildInsightMetadata(
	entry: EntryLike,
	patch: InsightMetadataPatch = {},
): InsightMetadata {
	return normalizeInsightMetadata(parseRawMetadata(entry.metadata), entry, patch);
}

const MAX_SOURCES = 20;
const MAX_HISTORY = 50;
const MAX_RELATIONS = 16;
export const DEFAULT_MERGE_LINEAGE_MAX = 32;

export function appendLineage(
	existing: unknown,
	additions: readonly string[],
	max: number = DEFAULT_MERGE_LINEAGE_MAX,
): string[] {
	const cap = Number.isInteger(max) && max > 0 ? max : DEFAULT_MERGE_LINEAGE_MAX;
	const prior = Array.isArray(existing)
		? existing.filter((item): item is string => typeof item === "string" && item.length > 0)
		: [];
	const appended = additions.filter((item) => item.length > 0);
	return [...prior, ...appended].slice(-cap);
}

/**
 * Append a relation to an existing relations array, deduplicating by the
 * full triple (`source`, `type`, `targetId`). When `source` is absent the
 * parent record's `fact_key` is the implicit subject — two relations with
 * the same `(type, targetId)` and no explicit source are considered duplicates.
 */
export function appendRelation(existing: unknown, relation: MemoryRelation): MemoryRelation[] {
	const rows = Array.isArray(existing)
		? existing.filter(
				(item): item is MemoryRelation =>
					!!item &&
					typeof item === "object" &&
					typeof (item as { type?: unknown }).type === "string" &&
					typeof (item as { targetId?: unknown }).targetId === "string",
			)
		: [];

	const sameSource = (a: MemoryRelation, b: MemoryRelation) =>
		(a.source ?? "") === (b.source ?? "");

	if (
		rows.some(
			(item) =>
				item.type === relation.type &&
				item.targetId === relation.targetId &&
				sameSource(item, relation),
		)
	) {
		return rows;
	}

	return [...rows, relation];
}

/** Implements stringify insight metadata as the local insight metadata parsing operation. */
export function stringifyInsightMetadata(
	metadata: InsightMetadata | Record<string, unknown>,
): string {
	const capped = { ...metadata } as Record<string, unknown>;

	if (Array.isArray(capped.sources) && capped.sources.length > MAX_SOURCES) {
		capped.sources = capped.sources.slice(-MAX_SOURCES);
	}
	if (Array.isArray(capped.history) && capped.history.length > MAX_HISTORY) {
		capped.history = capped.history.slice(-MAX_HISTORY);
	}
	if (Array.isArray(capped.relations) && capped.relations.length > MAX_RELATIONS) {
		capped.relations = capped.relations.slice(-MAX_RELATIONS);
	}
	delete capped.memory_layer;

	return JSON.stringify(capped);
}
