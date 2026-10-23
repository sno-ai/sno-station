import { z } from "zod";
import { createLogger } from "@snoai/utils/logger";

import {
	AUTO_RECALL_INJECTION_TOP_K,
	CANDIDATE_POOL_SIZE,
	DEFAULT_BM25_WEIGHT,
	DEFAULT_HARD_MIN_SCORE,
	DEFAULT_MIN_SCORE,
	DEFAULT_RERANK_TIMEOUT_MS,
	DEFAULT_VECTOR_WEIGHT,
	LENGTH_NORM_ANCHOR,
	TEMPORAL_WEIGHTING_DEFAULT,
	RECENCY_HALF_LIFE_DAYS,
	RECENCY_WEIGHT,
	RECENCY_WEIGHT_MAX,
	TIME_DECAY_HALF_LIFE_DAYS,
} from "./index";

const log = createLogger("sno-station-mem:config:retrieval");

/** Published remote selections now run the existing local pipeline. */
export const rerankModeSchema: z.ZodType<"lightweight" | "none"> = z.preprocess((value) => {
	if (value !== "cross-encoder") return value;
	log.info("remote reranking retired; using the local reranker", { cause: "remote-rerank-retired" }, {
		event_name: "memory.rerank.retired", file: "packages/memory/config/plugin-config-retrieval-schema.ts",
		function: "rerankModeSchema", site_id: "memory.rerank.retired",
	});
	return "lightweight";
}, z.enum(["lightweight", "none"]));

/** Accept published wait settings, but use no more than the local search budget. */
export const rerankTimeoutSchema: z.ZodType<number> = z.number().int().min(1000).max(120000)
	.transform((value) => Math.min(value, DEFAULT_RERANK_TIMEOUT_MS));

export const retrievalConfigSchema: z.ZodType<
	{
		mode: "precision-recall" | "vector";

		recallTopK: number;
		vectorWeight: number;
		bm25Weight: number;
		minScore: number;
		rerank: "lightweight" | "none";
		candidatePoolSize: number;
		rerankTimeoutMs: number;
		recencyHalfLifeDays: number;
		recencyWeight: number;
		temporalWeighting: boolean;
		mmrWindowOnly: boolean;
		temporalExpiry: boolean;
		temporalDecay: boolean;
		lengthNormAnchor: number;
		hardMinScore: number;
		timeDecayHalfLifeDays: number;
		lightweightFusionWeight?: number | undefined;
		lightweightCosineWeight?: number | undefined;
		importanceWeightBase?: number | undefined;
		timeDecayFloor?: number | undefined;
		mmrLambda?: number | undefined;
		reinforcementFactor: number;
		maxHalfLifeMultiplier: number;
	},
	unknown
> = z
	.object({
		mode: z.enum(["precision-recall", "vector"]).default("precision-recall"),
		/**
		 * Top-K memories injected per turn during auto-recall. Source of truth
		 * for the runtime retriever `limit`; AC5 drift test pins this default
		 * to AUTO_RECALL_INJECTION_TOP_K (currently 20). Lower (15) trades
		 * ~5pp accuracy for ~25% fewer prompt tokens.
		 */
		// The ceiling was 300 until 2026-09-15. It was not a limit of the retriever or of any
		// model; it simply capped what an operator could ask for, and on a store of ~650 rows per
		// conversation it stopped a measurement from ever injecting the whole population. What
		// actually binds is the answering model's context window, which the caller owns.
		recallTopK: z.number().int().min(0).max(2000).default(AUTO_RECALL_INJECTION_TOP_K),
		vectorWeight: z.number().min(0).max(1).default(DEFAULT_VECTOR_WEIGHT),
		bm25Weight: z.number().min(0).max(1).default(DEFAULT_BM25_WEIGHT),
		minScore: z.number().min(0).max(1).default(DEFAULT_MIN_SCORE),
		rerank: rerankModeSchema.default("lightweight"),
		candidatePoolSize: z.number().int().min(10).max(2000).default(CANDIDATE_POOL_SIZE),
		rerankTimeoutMs: rerankTimeoutSchema.default(DEFAULT_RERANK_TIMEOUT_MS),
		recencyHalfLifeDays: z.number().min(0).max(365).default(RECENCY_HALF_LIFE_DAYS),
		recencyWeight: z.number().min(0).max(RECENCY_WEIGHT_MAX).default(RECENCY_WEIGHT),
		/** Drop memories past their valid_until timestamp (default OFF — needs A/B eval) */
		temporalWeighting: z.boolean().default(TEMPORAL_WEIGHTING_DEFAULT),
		mmrWindowOnly: z.boolean().default(false),
		temporalExpiry: z.boolean().default(false),
		/** Dynamic memories decay 3× faster in time-decay scoring (default ON — low risk) */
		temporalDecay: z.boolean().default(true),
		lengthNormAnchor: z.number().int().min(0).max(5000).default(LENGTH_NORM_ANCHOR),
		hardMinScore: z.number().min(0).max(1).default(DEFAULT_HARD_MIN_SCORE),
		timeDecayHalfLifeDays: z.number().min(0).max(365).default(TIME_DECAY_HALF_LIFE_DAYS),
		/** Fusion-score weight when rerank="lightweight" (local cosine blend) */
		lightweightFusionWeight: z.number().min(0).max(1).optional(),
		/** Cosine-score weight when rerank="lightweight" (local cosine blend) */
		lightweightCosineWeight: z.number().min(0).max(1).optional(),
		/** Base multiplier for importance weighting */
		importanceWeightBase: z.number().min(0).max(1).optional(),
		/** Minimum multiplier for old entries */
		timeDecayFloor: z.number().min(0).max(1).optional(),
		/** Relevance vs diversity tradeoff (default: 0.7) */
		mmrLambda: z.number().min(0).max(1).optional(),
		/** Scaling factor for access-based reinforcement (0 = disabled, default: 0.5) */
		reinforcementFactor: z.number().min(0).max(5).default(0.5),
		/** Hard cap: effective half-life <= baseHalfLife * maxHalfLifeMultiplier (default: 3) */
		maxHalfLifeMultiplier: z.number().min(1).max(10).default(3),
	})
	.prefault({});
