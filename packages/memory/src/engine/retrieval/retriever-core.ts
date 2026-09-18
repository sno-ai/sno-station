/** @file retriever-core.ts
 * @purpose Owns MemoryRetriever construction and declares prototype-mounted retrieval APIs.
 * @boundary Runtime collaborators and cross-file method typing only.
 */

import type { RecallLifecycleConfig } from "../../../config/index";
import type { TierPromoter } from "../operations/memory-tier-promoter";
import type { RetentionScorer } from "../operations/selective-forgetting-scorer";
import {
	DEFAULT_RETRIEVAL_CONFIG,
	type RetrievalConfig,
	type RetrievalContext,
} from "./retrieval-config";
import type {
	AccessTracker,
	Embedder,
	MemorySearchResult,
	MemoryStore,
	RetrievalResult,
	RetrievalStatsCollector,
	RetrievalTrace,
	TraceCollector,
} from "./retriever-dependencies";

/**
 * Enumerates every branch in `rerank()` that fell back to the pre-rerank
 * candidate ordering instead of applying the cross-encoder score. Aggregated
 * via {@link RetrievalStatsCollector} and surfaced as trace stage metadata
 * so callers can attribute degraded ranking without parsing log lines.
 *
 * - `missing_api_key`: cross-encoder configured but no rerankApiKey set;
 *   call routes through the lightweight cosine path instead.
 * - `no_endpoint`: provider has no known endpoint in `RERANK_DEFAULT_ENDPOINTS`
 *   and `rerankEndpoint` was not overridden; rerank was skipped.
 * - `http_error`: provider responded with a non-OK status that did not map
 *   to a fatal RetrievalError (i.e. degraded but not propagated).
 * - `invalid_response`: provider HTTP 2xx but response shape did not parse.
 * - `timeout`: the per-call AbortSignal fired before the provider responded.
 * - `request_error`: any other thrown error inside the fetch path.
 * - `query_over_window`: the query alone fills the reranker's per-pair token window, so no
 *   document could be sent with it. Nothing was requested.
 */
export const RERANK_FALLBACK_REASONS = [
	"missing_api_key",
	"no_endpoint",
	"http_error",
	"invalid_response",
	"timeout",
	"request_error",
	"query_over_window",
] as const;
export type RerankFallbackReason = (typeof RERANK_FALLBACK_REASONS)[number];

export interface RerankFallbackSignal {
	reason: RerankFallbackReason;
	provider: string;
}

export interface RerankOutcome {
	candidates: RetrievalResult[];
	fallback?: RerankFallbackSignal;
	stats?: {
		rerankSentCount: number;
		rerankReturnedCount: number;
		rerankBeyondCapCount: number;
	};
}

export class MemoryRetriever {
	private _statsCollector: RetrievalStatsCollector | undefined;
	_accessTracker: AccessTracker | undefined;
	_cachedConfigHash: string | undefined;
	// Lazily instantiated when `recallLifecycle.retentionScorer` is ON. Kept on
	// the retriever instance so per-pipeline-run construction cost stays O(1).
	_retentionScorer: RetentionScorer | undefined;
	// Phase 0 §5 — tier-promoter wiring. Held alongside `_recallLifecycle` so the
	// post-retrieval evaluation block can gate on both presence and flag in a
	// single check. Construction is opt-in; the setter is called from the
	// runtime composition root and never from search-mode code.
	_tierPromoter: TierPromoter | undefined;
	// Phase 0 — resolved `recallLifecycle` block. Stored on the instance so the
	// hot retrieval path reads it without re-parsing config. Undefined means
	// "behavior identical to pre-Phase-0": every gate falls through to OFF.
	_recallLifecycle: RecallLifecycleConfig | undefined;

	retrieve(_context: RetrievalContext): Promise<RetrievalResult[]> {
		throw new Error("MemoryRetriever implementation modules were not loaded");
	}

	retrieveWithTrace(
		_context: RetrievalContext,
	): Promise<{ results: RetrievalResult[]; trace: RetrievalTrace }> {
		throw new Error("MemoryRetriever implementation modules were not loaded");
	}

	/**
	 * Initializes precision recall retrieval ranking collaborators while keeping runtime work in explicit
	 * methods.
	 */
	constructor(
		readonly store: MemoryStore,
		readonly embedder: Embedder,
		/** Unused logger slot; module-level createLogger handles retrieval diagnostics. */
		_logger?: {
			warn: (message: string, fields?: Record<string, unknown>) => void;
		},
		private readonly config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
	) {}

	/** Enable aggregate retrieval statistics collection. */
	setStatsCollector(collector: RetrievalStatsCollector): void {
		this._statsCollector = collector;
	}

	/** Get the stats collector (if set). */
	getStatsCollector(): RetrievalStatsCollector | undefined {
		// Centralize the retrieval scoring fallback value at the boundary of this helper.
		return this._statsCollector;
	}

	/** Set the access tracker for recording manual retrieval accesses. */
	setAccessTracker(tracker: AccessTracker): void {
		this._accessTracker = tracker;
	}

	/**
	 * Install the Phase 0 §5 tier-promoter dependency. Pure dependency injection;
	 * the post-retrieval evaluation hook only fires when both this setter has
	 * been called and `recallLifecycle.tierPromoter` is true.
	 */
	setTierPromoter(promoter: TierPromoter): void {
		this._tierPromoter = promoter;
	}

	/**
	 * Resolve the `recallLifecycle` block once at composition time so the hot
	 * retrieval path reads it without re-parsing config. All gates default
	 * false in `recallLifecycleSchema`, preserving the no-behavior-change
	 * Phase 0 contract for callers that never call this setter.
	 */
	setRecallLifecycle(config: RecallLifecycleConfig): void {
		this._recallLifecycle = config;
	}

	/** Returns the immutable retrieval config for diagnostics and tests. */
	getConfig(): RetrievalConfig {
		return this.config;
	}
}

export interface MemoryRetrieverInternals {
	store: MemoryStore;
	embedder: Embedder;
	config: RetrievalConfig;
	_statsCollector: RetrievalStatsCollector | undefined;
	_accessTracker: AccessTracker | undefined;
	_cachedConfigHash: string | undefined;
	_retentionScorer: RetentionScorer | undefined;
	_tierPromoter: TierPromoter | undefined;
	_recallLifecycle: RecallLifecycleConfig | undefined;
	evaluateTopKTierTransitions(results: RetrievalResult[]): Promise<void>;
	retrieve(context: RetrievalContext): Promise<RetrievalResult[]>;
	retrieveWithTrace(
		context: RetrievalContext,
	): Promise<{ results: RetrievalResult[]; trace: RetrievalTrace }>;
	throwIfAborted(context: RetrievalContext): void;
	filterExpired(results: RetrievalResult[]): RetrievalResult[];
	filterExpiredCandidates(results: MemorySearchResult[]): MemorySearchResult[];
	isEntryExpired(entry: MemorySearchResult["entry"] | RetrievalResult["entry"]): boolean;
	vectorOnly(context: RetrievalContext, trace?: TraceCollector): Promise<RetrievalResult[]>;
	precisionRecall(context: RetrievalContext, trace?: TraceCollector): Promise<RetrievalResult[]>;
	aggregationComplete(context: RetrievalContext, trace?: TraceCollector): Promise<RetrievalResult[]>;
	rrfFuse(vector: MemorySearchResult[], keyword: MemorySearchResult[]): RetrievalResult[];
	rerank(
		query: string,
		candidates: RetrievalResult[],
		queryVector: Float32Array,
	): Promise<RerankOutcome>;
	rerankLightweight(candidates: RetrievalResult[], queryVector: Float32Array): RetrievalResult[];
	getRerankSourceScore(result: RetrievalResult): number;
	applyScoringPipeline(results: RetrievalResult[], trace?: TraceCollector, limit?: number): RetrievalResult[];
	applyRecencyBoost(results: RetrievalResult[]): RetrievalResult[];
	applyImportanceWeight(results: RetrievalResult[]): RetrievalResult[];
	applyLengthNormalization(results: RetrievalResult[]): RetrievalResult[];
	applyTimeDecay(results: RetrievalResult[]): RetrievalResult[];
	applyRetentionBoost(results: RetrievalResult[]): RetrievalResult[];
	applyMmrDiversity(results: RetrievalResult[]): RetrievalResult[];
}

/** Creates the retriever with store, embedding, ranking config, and optional caller logger slot. */
export function createRetriever(
	store: MemoryStore,
	embedder: Embedder,
	/** Unused logger slot; retrieval diagnostics use the module-level logger. */
	logger?: {
		warn: (message: string, fields?: Record<string, unknown>) => void;
	},
	config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
): MemoryRetriever {
	return new MemoryRetriever(store, embedder, logger, config);
}
