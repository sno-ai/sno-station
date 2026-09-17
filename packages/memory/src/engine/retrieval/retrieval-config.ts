/** @file retrieval-config.ts
 * @purpose Defines retriever runtime configuration and request context contracts.
 * @boundary Types and defaults only; no ranking execution.
 */

import { DEFAULT_RECALL_LIFECYCLE, TEMPORAL_WEIGHTING_DEFAULT, type RecallLifecycleConfig } from "../../../config/index";
import type { MemoryCategory } from "./retriever-dependencies";
import type { AggregationQuery } from "../shared/types";
import type { RemFacetPolicy } from "../rem/index.js";
import {
	CANDIDATE_POOL_SIZE,
	DEFAULT_BM25_WEIGHT,
	DEFAULT_HARD_MIN_SCORE,
	DEFAULT_MIN_SCORE,
	DEFAULT_RERANK_MODEL,
	DEFAULT_RERANK_TIMEOUT_MS,
	DEFAULT_VECTOR_WEIGHT,
	IMPORTANCE_WEIGHT_BASE,
	LENGTH_NORM_ANCHOR,
	LIGHTWEIGHT_COSINE_WEIGHT,
	LIGHTWEIGHT_FUSION_WEIGHT,
	MMR_LAMBDA,
	RECENCY_HALF_LIFE_DAYS,
	RECENCY_WEIGHT,
	RERANK_BLEND_CROSS,
	RERANK_BLEND_VECTOR,
	TIME_DECAY_FLOOR,
	TIME_DECAY_HALF_LIFE_DAYS,
} from "./retriever-dependencies";

export type RerankProvider = "jina" | "siliconflow" | "voyage" | "pinecone" | "dashscope" | "tei";

export interface RetrievalConfig {
	/** Enable the historical recency, decay, and retention score transforms. */
	temporalWeighting: boolean;
	/** Diversify only within the request limit, preserving reranked window membership. */
	mmrWindowOnly: boolean;
	mode: "precision-recall" | "vector";
	vectorWeight: number;
	bm25Weight: number;
	minScore: number;
	rerank: "cross-encoder" | "lightweight" | "none";
	candidatePoolSize: number;
	recencyHalfLifeDays: number;
	recencyWeight: number;
	/** Drop memories past their valid_until timestamp (default OFF) */
	temporalExpiry: boolean;
	/** Dynamic memories decay 3× faster in time-decay scoring (default ON) */
	temporalDecay: boolean;
	rerankApiKey?: string;
	rerankModel?: string;
	rerankTimeoutMs?: number;
	lengthNormAnchor: number;
	hardMinScore: number;
	timeDecayHalfLifeDays: number;
	/** Weight for fusion score in rerank blend */
	rerankBlendVector?: number;
	/** Weight for cross-encoder score in rerank blend */
	rerankBlendCross?: number;
	/** Fusion-score weight when rerank="lightweight" (local cosine blend) */
	lightweightFusionWeight?: number;
	/** Cosine-score weight when rerank="lightweight" (local cosine blend) */
	lightweightCosineWeight?: number;
	/** Base multiplier for importance weighting */
	importanceWeightBase?: number;
	/** Minimum multiplier for old entries */
	timeDecayFloor?: number;
	/** Relevance vs diversity tradeoff (default: 0.7) */
	mmrLambda?: number;
	/** Custom rerank API endpoint URL */
	rerankEndpoint?: string;
	/** Rerank provider name */
	rerankProvider?: RerankProvider | string;
	/**
	 * Hard cap on how many candidates are sent to the cross-encoder rerank API
	 * in one request. Some rerank deployments (e.g. this repo's Sno TEI
	 * reranker) reject a batch above a fixed size instead of truncating it, so
	 * an unset value here must never silently violate that limit. Candidates
	 * beyond the cap are NOT dropped — they still flow through the standard
	 * `unreturned` preservation-floor path, same as a real reranker choosing
	 * not to return them.
	 */
	rerankMaxCandidates?: number;
	/** Scaling factor for access-based reinforcement (0 = disabled, default: 0.5) */
	reinforcementFactor?: number;
	/** Hard cap: effective half-life <= baseHalfLife * maxHalfLifeMultiplier (default: 3) */
	maxHalfLifeMultiplier?: number;
	/**
	 * Phase 0 retention-loop knobs (openspec/changes/mem-lifecycle PRD §6.1).
	 * Optional so legacy `RetrievalConfig` literals keep parsing; resolved
	 * default in `DEFAULT_RETRIEVAL_CONFIG` is `DEFAULT_RECALL_LIFECYCLE`
	 * (all booleans `false`), making the new wire sites pass-through.
	 */
	recallLifecycle?: RecallLifecycleConfig;
}

export interface RetrievalContext {
	external_reference?: string;
	external_reference_visibility?: "public" | "private";
	query: string;
	limit: number;
	scopeFilter?: string[];
	category?: MemoryCategory;
	/**
	 * Refused fallback rows carry the user's own words and are served by default; product
	 * entrypoints pass true, and only an explicit false hides them (owner ruling 2026-09-01,
	 * reversing PRD 130 DEC-2). Omitted low-level/internal reads preserve all rows.
	 */
	includeRefused?: boolean;
	signal?: AbortSignal;
	sessionId?: string;
	explicitLocale?: string;
	/** Retrieval source: "manual" for user-triggered, "auto-recall" for system-initiated, "cli" for CLI commands */
	source?: "manual" | "auto-recall" | "cli";
	/** Allows the recall tool to use complete-population aggregation routing. */
	allowAggregation?: boolean;
	/** Structured predicate and reduction for bounded, query-complete aggregation. */
	aggregation?: AggregationQuery;
	/** Selects current chunks only unless a non-user consumer explicitly requests history. */
	facetPolicy?: RemFacetPolicy;
	/**
	 * Tombstone exclusion (PRD memora-fama W1.3). When set, the store search
	 * drops candidates whose `metadata.invalidated_at <= excludeInvalidatedBefore`.
	 * A superseded fact is obsolete regardless of recall mode (OD-3, FAA binary),
	 * so omitting it on a serving path does not mean "serve everything": both
	 * retriever entrypoints run the context through `withServingValidityDefault`
	 * first (PRD 205). Pass `0` for a deliberate history read.
	 */
	excludeInvalidatedBefore?: number;
	/**
	 * Drops rows a group-CRUD close retired. Set by the two serving entries in
	 * `rem-consumer-retrieval.ts`; it has to reach the store because the candidate list is cut
	 * to `limit` before anything downstream can filter it.
	 */
	excludeSuperseded?: boolean;
}

/**
 * The serving-path validity default (PRD 205, REQ-1). This is the one named code
 * point that supplies it: reading the default here is what makes the
 * invalidated-row filter a property of the serving path rather than a parameter
 * every caller has to remember, and the omission is no longer silent.
 *
 * An explicit value always wins — including `0`, the deliberate history read,
 * where the store predicate becomes `invalidated_at > 0` and drops nothing.
 *
 * Scope is the retriever, never the store layer: six write-side consumers (dedup,
 * reflection loops, observability, the REM batch executor) call the store search
 * APIs directly and legitimately read invalidated rows. DEC-1 — do not move this
 * down a layer.
 */
export function withServingValidityDefault(context: RetrievalContext): RetrievalContext {
	if (context.excludeInvalidatedBefore !== undefined && context.includeRefused !== undefined) {
		return context;
	}
	return {
		...context,
		excludeInvalidatedBefore: context.excludeInvalidatedBefore ?? Date.now(),
		includeRefused: context.includeRefused ?? true,
	};
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
	temporalWeighting: TEMPORAL_WEIGHTING_DEFAULT,
	mmrWindowOnly: false,
	mode: "precision-recall",
	vectorWeight: DEFAULT_VECTOR_WEIGHT,
	bm25Weight: DEFAULT_BM25_WEIGHT,
	minScore: DEFAULT_MIN_SCORE,
	rerank: "cross-encoder",
	candidatePoolSize: CANDIDATE_POOL_SIZE,
	recencyHalfLifeDays: RECENCY_HALF_LIFE_DAYS,
	recencyWeight: RECENCY_WEIGHT,
	temporalExpiry: false,
	temporalDecay: true,
	rerankModel: DEFAULT_RERANK_MODEL,
	rerankTimeoutMs: DEFAULT_RERANK_TIMEOUT_MS,
	rerankProvider: "voyage",
	lengthNormAnchor: LENGTH_NORM_ANCHOR,
	hardMinScore: DEFAULT_HARD_MIN_SCORE,
	timeDecayHalfLifeDays: TIME_DECAY_HALF_LIFE_DAYS,
	rerankBlendVector: RERANK_BLEND_VECTOR,
	rerankBlendCross: RERANK_BLEND_CROSS,
	lightweightFusionWeight: LIGHTWEIGHT_FUSION_WEIGHT,
	lightweightCosineWeight: LIGHTWEIGHT_COSINE_WEIGHT,
	importanceWeightBase: IMPORTANCE_WEIGHT_BASE,
	timeDecayFloor: TIME_DECAY_FLOOR,
	mmrLambda: MMR_LAMBDA,
	recallLifecycle: DEFAULT_RECALL_LIFECYCLE,
};
