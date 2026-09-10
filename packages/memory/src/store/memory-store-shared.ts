import { PERSISTED_CONTENT_HASH_V1, PERSISTED_CONTENT_HASH_V3 } from "../model/signed-registry-constants";
/** @file memory-store-shared.ts
 * @purpose Implements memory persistence, search, updates, deletion, and statistics.
 * @boundary SQLite schema, embedding vectors, FTS, and metadata invariants.
 * @see connection.ts, schema.ts, retriever.ts.
 */

import { randomUUID } from "node:crypto";
import type { RemFacetPolicy } from "../engine/rem/index.js";
import {
	aggregateChunksToMemories,
	buildChunkId,
	buildDensePayload,
	CHUNKING_VERSION,
	type ChunkCandidate,
	type ChunkMetadataDraft,
	chunk,
	expandSnippetWindow,
	extractMetadataHeader,
	headExtract,
	RETRIEVAL_CHUNK_PROFILE,
	shouldDropSummary,
} from "@snoai/chunking";
import { createLogger } from "@snoai/utils/logger";
import { Mutex } from "async-mutex";
import {
	DEFAULT_IMPORTANCE,
	DEFAULT_LIST_LIMIT,
	DEFAULT_MIN_SCORE,
	DELETE_BATCH_SIZE,
	MAX_CHUNK_FETCH_LIMIT,
	MAX_AGGREGATION_ROWS,
	MAX_LIST_LIMIT,
	SNIPPET_NEIGHBOR_AFTER,
	SNIPPET_NEIGHBOR_BEFORE,
	VECTOR_DIMENSION_DEFAULT,
} from "../../config/index";
import type { Embedder } from "../engine/extraction/embedding-provider-client";
import { StorageError } from "../engine/shared/errors";
import type { WriterAuthority } from "../engine/shared/memory-kind-policy";
import {
	buildAmbientCaptureHashInput,
	readAmbientCaptureHashMetadata,
} from "../engine/shared/ambient-capture-hash";
import type { AggregationQuery, MemoryCategory, MemoryEntry, MemoryLane, MemorySearchResult } from "../engine/shared/types";
import {
	bytesToF32,
	clamp01,
	clampInt,
	f32ToBytes,
	sanitizeFtsQuery,
	sanitizeFtsConjunctiveQuery,
	stableHash,
} from "../engine/shared/utils";
import { type DrizzleDB, initDb } from "./connection";
import type { SqliteDatabaseLike } from "./sqlite-runtime";
import type { MemoryTelemetryStoreConfig } from "../engine/telemetry/memory-telemetry-events";
import type { MemoryTelemetryDeleteReason } from "../engine/telemetry/memory-telemetry-types";

export type {
	ChunkCandidate,
	ChunkMetadataDraft,
	DrizzleDB,
	Embedder,
	MemoryCategory,
	MemoryEntry,
	MemorySearchResult,
	SqliteDatabaseLike,
};
export {
	aggregateChunksToMemories,
	buildChunkId,
	buildDensePayload,
	bytesToF32,
	CHUNKING_VERSION,
	chunk,
	RETRIEVAL_CHUNK_PROFILE,
	clamp01,
	clampInt,
	DEFAULT_IMPORTANCE,
	DEFAULT_LIST_LIMIT,
	DEFAULT_MIN_SCORE,
	DELETE_BATCH_SIZE,
	expandSnippetWindow,
	extractMetadataHeader,
	f32ToBytes,
	headExtract,
	initDb,
	MAX_CHUNK_FETCH_LIMIT,
	MAX_AGGREGATION_ROWS,
	MAX_LIST_LIMIT,
	Mutex,
	randomUUID,
	SNIPPET_NEIGHBOR_AFTER,
	SNIPPET_NEIGHBOR_BEFORE,
	StorageError,
	sanitizeFtsQuery,
	sanitizeFtsConjunctiveQuery,
	shouldDropSummary,
	stableHash,
	VECTOR_DIMENSION_DEFAULT,
};

export const log: ReturnType<typeof createLogger> = createLogger("sno-station-mem:store");

/**
 * PRD §4.2 reflection v3: discriminator added to content-hash input when the
 * row carries a `metadata.mappedKind`. Two rows with same projectId + same store
 * category + same text but distinct mappedKinds (e.g. user-model vs
 * agent-model both → category=preference) must coexist as distinct rows. The
 * SQL UNIQUE index `(projectId, content_hash, category)` cannot key on metadata
 * JSON; mixing mappedKind into the hash input solves it without a schema
 * change. Non-reflection callers pass undefined/missing mappedKind, get the
 * legacy text-only hash.
 */
export function hashInputForEntry(text: string, metadata: string | undefined): string {
	if (!metadata) return text;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(metadata) as Record<string, unknown>;
	} catch {
		return text;
	}
	// `metadata.idempotency_key` is deliberately NOT read here. It used to short-circuit this
	// function and return a hash of the key alone, which left `content_hash` carrying no trace
	// of the content it is named for. The key is built per write from session key + extraction
	// trace + payload fingerprint, so the same sentence written from two chunks, two sessions or
	// two producers hashed differently and the UNIQUE index on
	// (project_id, content_hash, category) could not collapse it: measured 2026-08-29 on a
	// 127-row store, 10 groups of byte-identical text and 0 groups of identical hash.
	// Write identity is a different question from content identity and has its own device —
	// `findByExtractionIdempotencyKey`, over the index on `metadata.idempotency_key`, which the
	// candidate processor and `store` both consult before this hash is compared.
	const ambientCaptureMetadata = readAmbientCaptureHashMetadata(parsed);
	if (ambientCaptureMetadata) {
		return buildAmbientCaptureHashInput(text, ambientCaptureMetadata);
	}
	const mergeLineage = Array.isArray(parsed.merge_lineage)
		? parsed.merge_lineage.filter((item): item is string => typeof item === "string")
		: [];
	if (mergeLineage.length > 0) {
		return JSON.stringify([PERSISTED_CONTENT_HASH_V1, text, { merge_lineage: mergeLineage }]);
	}
	// Rows whose identity really is the write, not the sentence. The task-lifecycle carrier and
	// projection rows leave their superseded predecessor in the table, so a transition that does
	// not change the text would otherwise collide with the row it replaces. Those writers, and
	// only those, set this key; it is separate from `idempotency_key` on purpose, because retry
	// suppression and content identity are two questions and one field cannot answer both.
	const contentIdentityKey = parsed.content_identity_key;
	if (typeof contentIdentityKey === "string" && contentIdentityKey.length > 0) {
		return JSON.stringify([
			PERSISTED_CONTENT_HASH_V3,
			text,
			{ content_identity_key: contentIdentityKey },
		]);
	}
	const mappedKind = parsed.mappedKind;
	if (typeof mappedKind !== "string" || mappedKind.length === 0) return text;
	// Structured encoding (PRD §4.2): a plain `${text} mappedKind:${kind}`
	// concat would let a normal memory whose body literally ends in
	// ` mappedKind:user-model` collide with a mapped reflection row carrying
	// `metadata.mappedKind = "user-model"`. JSON-tuple form is unambiguous —
	// the marker prefix keeps non-mapped callers (which return raw `text`) on
	// a disjoint hash domain even if a user's text happens to equal a JSON
	// array literal.
	return JSON.stringify([PERSISTED_CONTENT_HASH_V1, text, mappedKind]);
}

interface HashSignificantMetadataProjection {
	idempotency_key?: string;
	content_identity_key?: string;
	ambient_capture?: ReturnType<typeof readAmbientCaptureHashMetadata>;
	merge_lineage?: string[];
	mappedKind?: string;
}

function valuesDiffer(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) !== JSON.stringify(right);
}

function metadataRecord(metadata: object): Record<string, unknown> {
	const record: Record<string, unknown> = {};
	for (const key of Object.keys(metadata)) {
		record[key] = Reflect.get(metadata, key);
	}
	return record;
}

function readNonEmptyString(metadata: object, key: string): string | undefined {
	const value = Reflect.get(metadata, key);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readMergeLineage(metadata: object): string[] | undefined {
	const value = Reflect.get(metadata, "merge_lineage");
	if (!Array.isArray(value)) return undefined;
	const lineage = value.filter((item): item is string => typeof item === "string");
	return lineage.length > 0 ? lineage : undefined;
}

function projectHashSignificantMetadata(metadata: object): HashSignificantMetadataProjection {
	const record = metadataRecord(metadata);
	return {
		idempotency_key: readNonEmptyString(record, "idempotency_key"),
		content_identity_key: readNonEmptyString(record, "content_identity_key"),
		ambient_capture: readAmbientCaptureHashMetadata(record),
		merge_lineage: readMergeLineage(record),
		mappedKind: readNonEmptyString(record, "mappedKind"),
	};
}

function changedHashSignificantMetadataKeys(current: object, next: object): string[] {
	const currentProjection = projectHashSignificantMetadata(current);
	const nextProjection = projectHashSignificantMetadata(next);
	const changed: string[] = [];
	if (valuesDiffer(currentProjection.idempotency_key, nextProjection.idempotency_key)) {
		changed.push("idempotency_key");
	}
	if (valuesDiffer(currentProjection.content_identity_key, nextProjection.content_identity_key)) {
		changed.push("content_identity_key");
	}
	if (valuesDiffer(currentProjection.ambient_capture, nextProjection.ambient_capture)) {
		changed.push("ambient_capture");
	}
	if (valuesDiffer(currentProjection.merge_lineage, nextProjection.merge_lineage)) {
		changed.push("merge_lineage");
	}
	if (valuesDiffer(currentProjection.mappedKind, nextProjection.mappedKind)) {
		changed.push("mappedKind");
	}
	return changed;
}

export function assertMetadataOnlyUpdatePreservesHashInput(
	operation: string,
	current: object,
	next: object,
): void {
	const changedKeys = changedHashSignificantMetadataKeys(current, next);
	if (changedKeys.length === 0) return;
	throw new StorageError(
		`${operation} cannot change hash-significant metadata through metadata-only update: ${changedKeys.join(", ")}`,
	);
}

/**
 * Batch bound for `IN (SELECT value FROM json_each(?))` id lists. json_each removes
 * the 999-placeholder ceiling and keeps SQL strings stable for the per-connection
 * statement cache; the slice is a defensive bound on single-statement argument size.
 */
export const JSON_ID_BATCH_SIZE = 5000;

export const CHUNK_BACKFILL_BATCH_SIZE = 100;
export const CHUNK_BACKFILL_MAX_ATTEMPTS = 3;
export const CHUNK_BACKFILL_RETRY_BASE_MS = 30_000;
export const CHUNK_BACKFILL_FAILURE_RESET_MS: number = CHUNK_BACKFILL_RETRY_BASE_MS * 10;

export interface StoreConfig {
	dbPath: string;
	vectorDim?: number;
	memoryTelemetry?: MemoryTelemetryStoreConfig;
	/**
	 * Embedder used to vectorize chunks during write paths. The store chunks
	 * incoming text via `@snoai/chunking` and embeds each chunk individually,
	 * so a per-store embedder reference is required even when callers also
	 * compute their own (soon-to-be-discarded) parent vector. Round B-2 will
	 * remove the discarded caller path.
	 */
	embedder: Embedder;
}

/** Outcome of an atomic reflection-item resolution attempt. */
export type ReflectionResolveOutcome =
	| "resolved"
	| "already_resolved"
	| "not_found"
	| "not_reflection_item";

export interface StoreInput {
	text: string;
	/**
	 * @deprecated Removed from persistence in Round B-2. Ignored by
	 * MemoryStore as of 2026-04-30 because chunks are derived from `text` and
	 * embedded internally via `prepareChunkInserts`. Target removal:
	 * post-task-6 cleanup once all legacy callers stop passing it.
	 */
	vector?: Float32Array;
	category: MemoryCategory;
	projectId: string;
	importance?: number;
	timestamp?: number;
	timezone?: string;
	metadata?: string;
	/**
	 * Trusted direct-store writes are reserved for profile-writer and setup/admin
	 * paths. Ordinary callers may create only agent-tool writable kinds.
	 */
	trusted?: boolean;
	/** System-only writes are reserved for derived pipeline aggregates. */
	system?: boolean;
	/** Explicit authority for reflection, summaries, and future offline maintenance. */
	offlineFamily?: boolean;
	lane?: MemoryLane;
	rawCandidateJson?: string;
	dispositionReason?: string;
	dispositionedAt?: number;
}

export type QuarantineDispositionReason =
	| "candidate_not_grounded"
	| "absorbed_occurrence"
	| "subject_not_user";

export interface QuarantinedStoreInput extends StoreInput {
	trusted: true;
	lane: "quarantined";
	rawCandidateJson: string;
	dispositionReason: QuarantineDispositionReason;
	dispositionedAt: number;
}

export type StoreWriteOutcome = "created" | "existing";

export type StoreResult = MemoryEntry & {
	readonly storeWriteOutcome: StoreWriteOutcome;
};

export function withStoreWriteOutcome(
	entry: MemoryEntry,
	outcome: StoreWriteOutcome,
): StoreResult {
	Object.defineProperty(entry, "storeWriteOutcome", {
		value: outcome,
		enumerable: false,
		configurable: false,
		writable: false,
	});
	return entry as StoreResult;
}

export interface ListOptions {
	projectId?: string;
	projectIdFilter?: string[];
	category?: MemoryCategory;
	limit?: number;
	offset?: number;
	importanceMin?: number;
	/** Defaults to active. Pass a non-active lane only for explicit audit reads. */
	lane?: MemoryLane;
}

export interface SearchOptions {
	limit?: number;
	minScore?: number;
	projectIdFilter?: string[];
	category?: MemoryCategory;
	/** Excludes exact memory rows before candidate limits are applied. */
	excludeMemoryIds?: readonly string[];
	/** Includes refusal-marked rows only when an explicit serving caller requests them. */
	includeRefused?: boolean;
	/** Structured full-text predicate and reduction for aggregation reads. */
	aggregation?: AggregationQuery;
	/** Restricts complete-population reads to durable task carrier rows. */
	taskCarrierPopulation?: "active" | "terminal" | "all";
	/**
	 * Hides superseded values when set to `current-only`. NO retrieval path sets it: whether a
	 * question needs a retired value is a question of meaning, and scoring answers that, not a
	 * regex over the query text. Left here for a caller that knows what it wants — the recall
	 * tool asking explicitly for history is the case it exists for.
	 */
	facetPolicy?: RemFacetPolicy;
	/**
	 * When set, search excludes memories whose metadata.invalidated_at is <= this
	 * timestamp. Fires on EVERY recall path — manual + auto + slash commands —
	 * because a superseded fact is obsolete regardless of recall mode (PRD
	 * memora-fama OD-3, FAA binary).
	 */
	excludeInvalidatedBefore?: number;
	/**
	 * Drops rows a group-CRUD close retired (`metadata.superseded_by`). Serving callers set it;
	 * the REM waves and dedup deliberately do not, because reading a retired row is their job.
	 *
	 * It has to be here rather than in the caller: the retriever cuts its candidates to the
	 * caller's `limit` before any of them is inspected, so a retired row filtered afterwards has
	 * already spent a slot, and a group whose highest-scoring rows are all retired serves nothing
	 * at all while its current fact sits just past the cut.
	 */
	excludeSuperseded?: boolean;
}

/**
 * Per-chunk search result returned by `searchChunksSemantic` /
 * `searchChunksKeyword`. Carries enough context (`parentMemoryId`,
 * `chunkIndex`, `chunkText`, `densePayload`) for downstream aggregation
 * (`@snoai/chunking#aggregateChunksToMemories`) and for precision recall fusion +
 * cross-encoder rerank in `retriever.ts`.
 */
export interface ChunkSearchResult {
	chunkId: string;
	parentMemoryId: string;
	chunkIndex: number;
	chunkText: string;
	densePayload: string;
	score: number;
	/** Semantic only — raw cosine distance from sqlite-vec. */
	distance?: number;
	/** Keyword only — raw FTS5 BM25 score (lower-is-better, negative). */
	bm25Rank?: number;
	/** 1-based result rank within this method's result list. */
	rank: number;
}

export interface UpdateChanges {
	/** Explicit writer provenance; omission is the live extraction boundary. */
	writerAuthority?: WriterAuthority;
	text?: string;
	/**
	 * @deprecated Removed from persistence in Round B-2. Ignored by
	 * MemoryStore as of 2026-04-30 because chunks are derived internally when
	 * `text` changes. Target removal: post-task-6 cleanup once all legacy
	 * callers stop passing it.
	 */
	vector?: Float32Array;
	category?: MemoryCategory;
	importance?: number;
	timestamp?: number;
	timezone?: string;
	metadata?: string;
	expectedContentHash?: string;
	expectedMetadata?: string;
	expectedAbsentFactKey?: string;
}

export interface StatsResult {
	total: number;
	projectBreakdown: Record<string, number>;
	categoryBreakdown: Record<string, number>;
}

export interface BulkDeleteResult {
	deleted: number;
	truncated: boolean;
}

export interface MemoryDeleteOptions {
	deleteReason?: MemoryTelemetryDeleteReason;
}

export type MemoryRow = {
	id: string;
	text: string;
	category: string;
	projectId: string;
	importance: number;
	timestamp: number;
	timezone: string;
	metadata: string | null;
	content_hash: string;
	fact_id?: string | null;
	derived_from?: string | null;
	lane?: string | null;
	raw_candidate_json?: string | null;
	disposition_reason?: string | null;
	dispositioned_at_ms?: number | null;
};

export type ChunkSearchRow = {
	chunk_id: string;
	memory_id: string;
	chunk_index: number;
	chunk_text: string;
	dense_payload: string;
	projectId: string;
	category: string;
	distance?: number;
	rank?: number;
};

export interface PreparedChunkRow {
	chunkId: string;
	memoryId: string;
	chunkIndex: number;
	draft: ChunkMetadataDraft;
	densePayload: string;
	summary: string | undefined;
	vectorBytes: Uint8Array;
	createdAt: number;
	updatedAt: number;
}

/** A write attempt the extraction path could not place. Not a memory. */
export interface UnplacedCandidate {
	id: string;
	projectId: string;
	category: MemoryCategory;
	text: string;
	rawCandidateJson: string;
	dispositionReason: string;
	dispositionedAtMs: number;
	sessionKey?: string;
}

export interface RecordUnplacedCandidateInput {
	projectId: string;
	category: MemoryCategory;
	text: string;
	/** The raw model output. Required — it is the replay input. */
	rawCandidateJson: string;
	dispositionReason: string;
	dispositionedAtMs: number;
	sessionKey?: string;
}

export interface RecordUnplacedCandidateResult {
	id: string;
	/** False when an identical failure is already preserved for this scope. */
	created: boolean;
}

export interface UnplacedCandidateQuery {
	projectId?: string;
	dispositionReason?: string;
	limit?: number;
}
