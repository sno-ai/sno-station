/** @file retriever-dependencies.ts
 * @purpose Centralizes external dependencies shared by retriever modules.
 * @boundary Re-export only; no retrieval behavior lives here.
 */

export { createLogger } from "@snoai/utils/logger";
export {
	CANDIDATE_POOL_SIZE,
	CHUNKING_VERSION,
	DEFAULT_BM25_WEIGHT,
	DEFAULT_HARD_MIN_SCORE,
	DEFAULT_MIN_SCORE,
	DEFAULT_RERANK_BATCH_CONCURRENCY,
	DEFAULT_RERANK_MODEL,
	DEFAULT_RERANK_TIMEOUT_MS,
	DEFAULT_MAX_CONTEXT_TOKENS,
	DEFAULT_TEI_RERANK_MAX_CANDIDATES,
	DEFAULT_VECTOR_WEIGHT,
	IMPORTANCE_WEIGHT_BASE,
	LENGTH_NORM_ANCHOR,
	LIGHTWEIGHT_COSINE_WEIGHT,
	LIGHTWEIGHT_FUSION_WEIGHT,
	LIGHTWEIGHT_RERANK_PENALTY,
	MAX_AGGREGATION_ROWS,
	MAX_CANDIDATE_POOL_SIZE,
	MMR_LAMBDA,
	PRECISION_RECALL_POOL_SIZE_FACTOR,
	RECENCY_HALF_LIFE_DAYS,
	RECENCY_WEIGHT,
	RERANK_BLEND_CROSS,
	RERANK_BLEND_VECTOR,
	RERANK_PROMPT_TEMPLATE_TOKENS,
	TEMPORAL_DYNAMIC_HALF_LIFE_DIVISOR,
	TIME_DECAY_FLOOR,
	TIME_DECAY_HALF_LIFE_DAYS,
} from "../../../config/index";
export { appendQaTrace, computeConfigHash, isTraceEnabled } from "../eval/trace";
export type { Embedder } from "../extraction/embedding-provider-client";
export {
	isMemoryExpired,
	parseInsightMetadata,
} from "../extraction/memory-metadata-codec";
export type { AccessTracker } from "./access-tracker";
export {
	computeEffectiveHalfLife,
	parseAccessMetadata,
} from "./access-tracker";
export type { RetrievalStatsCollector } from "./retrieval-stats";
export type { RetrievalTrace } from "./retrieval-trace";
export { TraceCollector } from "./retrieval-trace";
export { RetrievalError } from "../shared/errors";
export type {
	AggregationQuery,
	MemoryCategory,
	MemorySearchResult,
	RetrievalResult,
} from "../shared/types";
export { clamp01 } from "../shared/utils";
export type { MemoryStore, SearchOptions } from "../../store/store";
