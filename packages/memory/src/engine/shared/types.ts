/** @file types.ts
 * @purpose Centralizes public and internal TypeScript contracts for the plugin.
 * @boundary Store entries, configuration, tool payloads, and runtime adapters.
 * @see schema.ts, memory-tool-registration.ts, sno-station-mem-plugin-runtime.ts.
 */

import type { ContentType } from "@snoai/chunking";

export const MEMORY_CATEGORIES = [
	"episodic",
	"profile",
	"persona",
	"lesson",
	"summary",
	"state",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryLane = "active" | "parked" | "quarantined";

export const CANDIDATE_EXTRACTION_TRACE_VERSION = "insight-distill-2026-06-27";

export type { SessionStrategy } from "../../../config/session-strategy";
export { SESSION_STRATEGIES } from "../../../config/session-strategy";

// Type-only import (erased at runtime, so no value-level cycle even though
// memory-metadata-types.ts imports MEMORY_CATEGORIES from here). The Zod schema
// in that module is the single source of truth for insight metadata; deriving
// the bulk of MemoryMetadata from it keeps enums/fields from drifting.
import type { MemoryMetadataBaseFields } from "../extraction/memory-metadata-types";

export interface MemoryEntry {
	id: string;
	factId?: string;
	text: string;
	category: MemoryCategory;
	projectId: string;
	importance: number;
	timestamp: number;
	timezone: string;
	metadata: string;
	contentHash: string;
	lane: MemoryLane;
	rawCandidateJson?: string;
	dispositionReason?: string;
	dispositionedAt?: number;
}

export interface MemorySearchResult {
	entry: MemoryEntry;
	score: number;
	/** Stable counted-event identity shared by current and history facets. */
	eventIdentity?: string;
	/** Rows in the filtered readable scope before the aggregation output ceiling. */
	scopeRowCount?: number;
	/** True when the requested aggregation population is not fully represented. */
	aggregationIncomplete?: boolean;
	distance?: number;
	rank?: number;
	/**
	 * Per-branch winning chunk id (the chunk that produced the highest score
	 * within the branch that emitted this result), populated by chunk-aware
	 * search wrappers (`searchSemantic` / `searchKeyword`). Required by the
	 * chunk-level reranker (PRD §6.0.1) to fetch `bestChunkVector` and by
	 * snippet expansion (PRD §6.M2) to anchor the neighbor window.
	 */
	chunkId?: string;
	/** Chunk index of the winning chunk within its parent memory. */
	chunkIndex?: number;
	/**
	 * Chunk-level score of the winning chunk before any fusion or rerank
	 * blending. Survives RRF fusion so the snippet anchor rule (PRD §4) can
	 * pick a deterministic winner when both branches surface the same parent
	 * with different best chunks.
	 */
	bestChunkScore?: number;
	/**
	 * Winning-chunk + neighbor snippet assembled by snippet expansion
	 * (PRD §M2). Empty string is treated as no-snippet; consumers must fall
	 * back to `entry.text` when undefined or empty.
	 */
	snippet?: string;
}

export const AGGREGATION_OPERATIONS = ["count", "first", "last", "evidence"] as const;
export type AggregationOperation = (typeof AGGREGATION_OPERATIONS)[number];
export interface AggregationQuery {
	operation: AggregationOperation;
	terms: string[];
}

/** Memory tier levels for lifecycle management. */
export type MemoryTier = "core" | "working" | "peripheral";
export const DEFAULT_MEMORY_TIER: MemoryTier = "peripheral";

/**
 * Structural type for the JSON stored in `MemoryEntry.metadata`.
 * All fields optional — legacy rows may lack any of them. Tier 1 suppression
 * fields (last_bad_recall_at, bad_recall_count, suppressed_until_ms) lazy-heal
 * on first write. `intrinsic` carries Retention Scorer inputs. Mixed
 * camelCase + snake_case is intentional — matches the dual-style metadata
 * persisted historically (e.g. accessCount + access_count).
 */
export interface MemoryMetadata extends Partial<MemoryMetadataBaseFields> {
	// --- Storage / recall-healing fields — NOT part of the insight Zod schema.
	// Persisted by the storage + lifecycle layers, not the extractor. The
	// camelCase pair mirrors snake_case `access_count` / `last_accessed_at` from
	// the base (dual-style metadata persisted historically); `*_ms` and
	// `intrinsic` are storage-only and have no Zod-schema counterpart.
	accessCount?: number;
	lastAccessedAt?: number;
	last_bad_recall_at?: number;
	suppressed_until_ms?: number;
	contexts?: string[];
	intrinsic?: {
		confidence?: number;
		importance?: number;
	};
	rem_update_source_version?: string;
	rem_update_rewrite_config?: {
		implementationVersion: string;
		memoryKind: "profile" | "episodic";
		locale: string;
		localeResource: Readonly<Record<string, string>>;
	};
	rem_update_idempotency_key?: string;
	// --- Category-variant insight fields. These live on the discriminated-union
	// members in memory-metadata-types.ts (episodic/profile/persona/lesson/
	// summary), which cannot be flattened into Partial<base> automatically, so
	// they are mirrored here as optional. There is no compile-time guard tying
	// the two (the variants' .catchall(z.unknown()) index signature defeats
	// assignability checks — see memory-metadata-types.ts); adding a new variant
	// field to the Zod union means adding it here by hand.
	event_at?: string | number;
	entity_kind?: string;
	section_name?: string;
	rawTopicPhrase?: string;
	anti_pattern_signature?: string;
	children_ids?: string[];
	depth?: number;
}

/** Decay score for a single memory (from decay-engine). */
export interface DecayScore {
	memoryId: string;
	recency: number;
	frequency: number;
	intrinsic: number;
	composite: number;
}

/** Minimal memory fields needed for decay calculation. */
export interface DecayableMemory {
	id: string;
	importance: number;
	confidence: number;
	tier: MemoryTier;
	accessCount: number;
	createdAt: number;
	lastAccessedAt: number;
	metadata?: string;
	temporalType?: "static" | "dynamic";
}

/** Subject-predicate-object triple emitted by extraction. */
export interface CandidateRelation {
	/** Predicate / edge label. */
	type: string;
	/**
	 * Object — canonical-name slug or memory id. Client stores whatever
	 * the LLM produces; cloud-side resolves slugs to memory ids.
	 */
	target: string;
	/**
	 * Optional explicit subject. Defaults to the parent candidate's
	 * `fact_key` (typically the entity's canonical-name slug). Set when
	 * the relation describes two third parties (e.g. on an `episodic`
	 * candidate).
	 */
	source?: string;
}

export interface CandidateExtractionTrace {
	source: "llm-conversation-chunk" | "explicit-command-chunk";
	chunkIndex: number;
	chunkCount: number;
	startOffset: number;
	endOffset: number;
	tokenCount: number;
	contentType: ContentType;
	chunkingVersion: string;
	candidateIndex: number;
	extractorVersion?: string;
}

/** A candidate memory extracted from conversation by LLM. */
export interface CandidateMemory {
	category: MemoryCategory;
	/** L0: one-sentence index */
	abstract: string;
	/** L1: structured markdown summary */
	overview: string;
	/** L2: full narrative */
	content: string;
	/** Canonical profile/persona section name. Required for profile/persona candidates. */
	sectionName?: string;
	/** Original B-profile topic phrase retained for deterministic registry re-keying. */
	rawTopicPhrase?: string;
	/**
	 * Index of the user turn this candidate came from, recorded by the caller's own loop.
	 * It is never asked of the model: the deployed B-profile adapter answered "1" to 60 of 60
	 * position probes, so a model-reported position was never a truthful value.
	 */
	sourceTurnIndex?: number;
	/** Retrieval visibility selected by the B-profile no-drop classifier. */
	lane?: MemoryLane;
	/** Exact producer candidate retained for parked and quarantined audit rows. */
	rawCandidateJson?: string;
	/** Source messages cited by the producer, used by the universal subject gate. */
	gateEvidenceText?: string;
	/** Closed disposition code explaining a non-active row. */
	dispositionReason?: string;
	/** Structured lesson dedupe signature. Required for lesson candidates. */
	antiPatternSignature?: string;
	/** Summary child ids. Summary is system-derived, not ambient-extracted. */
	childrenIds?: string[];
	/** Summary hierarchy depth. Summary is system-derived, not ambient-extracted. */
	summaryDepth?: number;
	/**
	 * Absolute event timestamp, ISO-8601. Set on episodic candidates only
	 * when the LLM resolves an absolute date from the conversation.
	 */
	eventAt?: string;
	/** Original temporal phrase when the interval was mentioned in relative language. */
	temporalPhrase?: string;
	/**
	 * Typed entity nature. Open vocabulary — suggested values: person,
	 * pet, project, place, business, artwork, organization.
	 */
	entityKind?: string;
	/**
	 * Triples connecting this candidate to other entities. Implicit
	 * subject = the candidate's canonical name (its `fact_key`). Episodic
	 * candidates only; set `source` only when the relation does not anchor
	 * to this candidate.
	 */
	relations?: CandidateRelation[];
	extractionTrace?: CandidateExtractionTrace;
}

// Dedup / Extraction Types (for insight-distill pipeline)

/** Dedup decision from LLM. */
export type DedupDecision = "create" | "skip";

export interface DedupResult {
	decision: DedupDecision;
	reason: string;
}

export interface ExtractionStats {
	created: number;
	merged: number;
	skipped: number;
	/** Admission control rejections. */
	rejected?: number;
	/**
	 * Write attempts preserved outside the memory table because no gate could
	 * place them. Neither created nor skipped: nothing reached memory, and nothing
	 * was passed over.
	 */
	unplaced?: number;
	boundarySkipped?: number;
	/** LLM extraction calls that failed before yielding candidates. */
	llmFailures?: number;
	/** Candidate processing failures after extraction yielded memories. */
	processingFailures?: number;
	/** Memory kinds whose failed model work still needs deterministic capture. */
	deterministicFallbackCategories?: MemoryCategory[];
	/** Timestamp ladder fallbacks, split by mutation site and selected source. */
	taskTimestampFallbacks?: {
		mutationSessionDateTime: number;
		mutationValidAtNow: number;
		completionSessionDateTime: number;
		completionValidAtNow: number;
	};
}

/** Validate and normalize a category string to a foundation kind. */
export function normalizeCategory(raw: string): MemoryCategory | undefined {
	const lower = raw.toLowerCase().trim();
	if ((MEMORY_CATEGORIES as readonly string[]).includes(lower)) {
		return lower as MemoryCategory;
	}
	return undefined;
}

export type { PluginConfig } from "../../../config/plugin-config-schema";
export { pluginConfigSchema } from "../../../config/plugin-config-schema";

export interface RetrievalResult {
	entry: MemoryEntry;
	score: number;
	/** Stable counted-event identity shared by current and history facets. */
	eventIdentity?: string;
	/** Rows in the filtered readable scope before the aggregation output ceiling. */
	scopeRowCount?: number;
	/** True when an aggregation had to return a ranked page instead of a known population. */
	aggregationIncomplete?: boolean;
	sources: {
		vector?: { score: number; rank: number };
		bm25?: { score: number; rank: number };
		fused?: { score: number };
		reranked?: { score: number };
	};
	/** Per-branch winning chunk metadata, propagated from `MemorySearchResult`. */
	chunkId?: string;
	chunkIndex?: number;
	/** Survives RRF fusion via the anchor rule (PRD §4): higher branch wins, semantic tie-break. */
	bestChunkScore?: number;
	/** Winning-chunk + neighbor snippet from M2 snippet expansion. */
	snippet?: string;
	/**
	 * The (project, subject, attribute) group a recall row was expanded from. Set only on
	 * group-expanded manual-recall rows, so the token packer can keep a group's newest member with
	 * it rather than serving an older sibling alone.
	 */
	recallGroupKey?: string;
	/** Per-stage scores (PRD §5.2). Each pipeline stage populates the field it owns. */
	denseScore?: number;
	bm25Score?: number;
	fusedScore?: number;
	rerankScore?: number;
	mmrScore?: number;
}
