import { z } from "zod";

import {
	AUTO_RECALL_INJECTION_TOP_K,
	CANDIDATE_POOL_SIZE,
	DEFAULT_BM25_WEIGHT,
	DEFAULT_HARD_MIN_SCORE,
	DEFAULT_MIN_SCORE,
	DEFAULT_RERANK_MODEL,
	DEFAULT_RERANK_TIMEOUT_MS,
	DEFAULT_VECTOR_WEIGHT,
	LENGTH_NORM_ANCHOR,
	TEMPORAL_WEIGHTING_DEFAULT,
	RECENCY_HALF_LIFE_DAYS,
	RECENCY_WEIGHT,
	RECENCY_WEIGHT_MAX,
	TIME_DECAY_HALF_LIFE_DAYS,
} from "./index";
import { resolveEnvVars } from "../src/engine/shared/utils";

export const retrievalConfigSchema: z.ZodType<
	{
		mode: "precision-recall" | "vector";
		recallTopK: number;
		vectorWeight: number;
		bm25Weight: number;
		minScore: number;
		rerank: "cross-encoder" | "lightweight" | "none";
		candidatePoolSize: number;
		rerankApiKey?: string | undefined;
		rerankModel: string;
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
		rerankBlendVector?: number | undefined;
		rerankBlendCross?: number | undefined;
		lightweightFusionWeight?: number | undefined;
		lightweightCosineWeight?: number | undefined;
		importanceWeightBase?: number | undefined;
		timeDecayFloor?: number | undefined;
		mmrLambda?: number | undefined;
		rerankEndpoint?: string | undefined;
		rerankProvider?:
			| "jina"
			| "siliconflow"
			| "pinecone"
			| "voyage"
			| "dashscope"
			| "tei"
			| "custom"
			| undefined;
		rerankMaxCandidates?: number | undefined;
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
		recallTopK: z.number().int().min(1).max(2000).default(AUTO_RECALL_INJECTION_TOP_K),
		vectorWeight: z.number().min(0).max(1).default(DEFAULT_VECTOR_WEIGHT),
		bm25Weight: z.number().min(0).max(1).default(DEFAULT_BM25_WEIGHT),
		minScore: z.number().min(0).max(1).default(DEFAULT_MIN_SCORE),
		rerank: z.enum(["cross-encoder", "lightweight", "none"]).default("cross-encoder"),
		candidatePoolSize: z.number().int().min(10).max(2000).default(CANDIDATE_POOL_SIZE),
		rerankApiKey: z.string().optional(),
		rerankModel: z.string().default(DEFAULT_RERANK_MODEL),
		rerankTimeoutMs: z.number().int().min(1000).max(120000).default(DEFAULT_RERANK_TIMEOUT_MS),
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
		/** Weight for fusion score in rerank blend */
		rerankBlendVector: z.number().min(0).max(1).optional(),
		/** Weight for cross-encoder score in rerank blend */
		rerankBlendCross: z.number().min(0).max(1).optional(),
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
		/** Custom rerank API endpoint URL (env var placeholders resolved post-parse) */
		rerankEndpoint: z.string().optional(),
		/** Rerank provider name */
		rerankProvider: z
			.enum(["jina", "siliconflow", "pinecone", "voyage", "dashscope", "tei", "custom"])
			.optional(),
		/** Hard cap on candidates sent per rerank API request (some deployments reject over-limit batches) */
		rerankMaxCandidates: z.number().int().min(1).max(2000).optional(),
		/** Scaling factor for access-based reinforcement (0 = disabled, default: 0.5) */
		reinforcementFactor: z.number().min(0).max(5).default(0.5),
		/** Hard cap: effective half-life <= baseHalfLife * maxHalfLifeMultiplier (default: 3) */
		maxHalfLifeMultiplier: z.number().min(1).max(10).default(3),
	})
	.prefault({})
	.transform((ret, ctx) => {
		if (ret.rerank === "none") return ret;
		const resolve = (v: string | undefined, field: string): string | undefined => {
			if (!v?.includes("${")) return v;
			try {
				return resolveEnvVars(v);
			} catch (error) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [field],
					message:
						error instanceof Error ? error.message : `Failed to resolve env vars in ${field}`,
				});
				return undefined;
			}
		};
		const resolvedEndpoint = resolve(ret.rerankEndpoint, "rerankEndpoint");
		// A custom endpoint must say which wire protocol it speaks. Left unset the retriever
		// falls back to "voyage", which sends a voyage-shaped body AND drops the per-request
		// batch cap that only "tei" carries — so a deployment pointing at the self-hosted
		// reranker without naming it would send every candidate in one request. The VM's deploy
		// script pins the pair today; this is the same guarantee, made by the config instead.
		if (resolvedEndpoint !== undefined && ret.rerankProvider === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["rerankProvider"],
				message:
					"retrieval.rerankProvider is required when retrieval.rerankEndpoint is set: " +
					"the provider decides the request shape and the per-request batch limit",
			});
		}
		if (resolvedEndpoint !== undefined) {
			try {
				new URL(resolvedEndpoint);
			} catch {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["rerankEndpoint"],
					message: `Invalid URL after env var resolution: "${resolvedEndpoint}"`,
				});
			}
		}
		return {
			...ret,
			rerankApiKey: resolve(ret.rerankApiKey, "rerankApiKey"),
			rerankEndpoint: resolvedEndpoint,
			rerankModel: resolve(ret.rerankModel, "rerankModel") ?? ret.rerankModel,
		};
	});
