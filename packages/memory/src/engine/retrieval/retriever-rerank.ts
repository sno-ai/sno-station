/** @file retriever-rerank.ts
 * @purpose Runs local cosine ordering and local model reranking.
 * @boundary Prototype-mounted MemoryRetriever methods; no constructor state ownership.
 */

import { dotProduct, log } from "./retrieval-scoring-utils";
import { MemoryRetriever, type MemoryRetrieverInternals, type RerankOutcome } from "./retriever-core";
import type { RetrievalResult } from "./retriever-dependencies";
import {
	clamp01, DEFAULT_RERANK_TIMEOUT_MS, LIGHTWEIGHT_COSINE_WEIGHT,
	LIGHTWEIGHT_FUSION_WEIGHT, LOCAL_RERANK_CANDIDATES,
} from "./retriever-dependencies";

Object.assign(MemoryRetriever.prototype, {
	async rerank(
		this: MemoryRetrieverInternals,
		query: string,
		candidates: RetrievalResult[],
		queryVector: Float32Array,
		options?: { signal?: AbortSignal; deadlineAt?: number },
	): Promise<RerankOutcome> {
		if (candidates.length === 0 || this.config.rerank === "none") return { candidates };
		return this.rerankLocalModel(query, this.rerankLightweight(candidates, queryVector), options?.deadlineAt, options?.signal);
	},

	rerankLightweight(
		this: MemoryRetrieverInternals,
		candidates: RetrievalResult[],
		queryVector: Float32Array,
	): RetrievalResult[] {
		// Treat the empty collection as a first-class outcome instead of widening behavior.
		if (queryVector.length === 0) return candidates;
		if (candidates.length === 0) return candidates;

		// Single batched fetch over chunk-keyed vec store. `getVectorsByIds`
		// silently omits missing ids; candidates without a hit fall back below.
		const chunkIds = candidates
			.map((c) => c.chunkId)
			.filter((id): id is string => id !== undefined);
		const vectorMap =
			chunkIds.length > 0 ? this.store.getVectorsByIds(chunkIds) : new Map<string, Float32Array>();

		const wF = this.config.lightweightFusionWeight ?? LIGHTWEIGHT_FUSION_WEIGHT;
		const wC = this.config.lightweightCosineWeight ?? LIGHTWEIGHT_COSINE_WEIGHT;

		let blendedCount = 0;
		let dimMismatchCount = 0;
		const reranked = candidates.map((candidate) => {
			// Blend the fused score with a fresh cosine check, cosine-heavy (weights and their measurement at
			// LIGHTWEIGHT_FUSION_WEIGHT in config/index.ts). Valid now that
			// fusion is a weighted blend of two calibrated [0, 1) branch scores
			// (fusedScore tracks raw match strength) — this was NOT valid under
			// the brief pure-rank RRF formula, where fusedScore was a rank vote
			// unrelated to magnitude and blending it here deflated strong
			// single-branch matches.
			const fusedScore = candidate.fusedScore ?? candidate.score;
			// BM25-only or missing chunk metadata → keep fused score, surface as rerankScore for trace.
			if (!candidate.chunkId) {
				return { ...candidate, rerankScore: fusedScore };
			}
			const chunkVector = vectorMap.get(candidate.chunkId);
			if (!chunkVector) {
				return { ...candidate, rerankScore: fusedScore };
			}
			// Embedder-dimension invariant: block silent NaN
			// propagation when DB has rows from a different embedder dim.
			if (chunkVector.length !== queryVector.length) {
				dimMismatchCount += 1;
				return { ...candidate, rerankScore: fusedScore };
			}
			// Vectors are L2-normalized by the embedder (`packages/embedder`),
			// so cosine ≡ dot product.
			const cosine = clamp01(dotProduct(queryVector, chunkVector), 0);
			const blended = fusedScore * wF + cosine * wC;
			const finalScore = clamp01(blended, 0);
			blendedCount += 1;
			return {
				...candidate,
				score: finalScore,
				rerankScore: finalScore,
				sources: {
					...candidate.sources,
					reranked: { score: finalScore },
				},
			};
		});

		if (dimMismatchCount > 0) {
			log.warn("lightweight rerank: chunk vector dim mismatch on some candidates", {
				dimMismatchCount,
				queryDim: queryVector.length,
			}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/memory/src/engine/retrieval/retriever-rerank.ts", function: "rerankLightweight", site_id: "retrieval.retriever-rerank.rerankLightweight.70eb2031f1" });
		}
		log.debug("lightweight rerank applied", {
			candidateCount: candidates.length,
			blendedCount,
			fusionWeight: wF,
			cosineWeight: wC,
		}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/memory/src/engine/retrieval/retriever-rerank.ts", function: "rerankLightweight", site_id: "retrieval.retriever-rerank.rerankLightweight.7e8d0eee29" });

		// Sort by new score desc; tie-break on entry id keeps determinism.
		return reranked.sort((a, b) => {
			const diff = b.score - a.score;
			if (diff !== 0) return diff;
			return a.entry.id.localeCompare(b.entry.id);
		});
	},

	/**
	 * The local reranker model reorders the first candidates of the local ranking. Their order is unchanged while the
	 * model is not loaded yet (the first call starts loading it), past the caller's deadline, and after a cancel.
	 */
	async rerankLocalModel(
		this: MemoryRetrieverInternals,
		query: string,
		ordered: RetrievalResult[],
		deadlineAt?: number,
		signal?: AbortSignal,
	): Promise<RerankOutcome> {
		if (ordered.length < 2 || signal?.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt)) return { candidates: ordered };
		const head = ordered.slice(0, LOCAL_RERANK_CANDIDATES);
		const started = performance.now();
		// The model runs on the CPU and cannot be interrupted, so the caller's deadline and cancel are raced instead:
		// either one brings the order back unchanged and the late scores are dropped. A model failure keeps the order too.
		const budgetMs = Math.max(0, Math.floor(Math.min(
			DEFAULT_RERANK_TIMEOUT_MS,
			this.config.rerankTimeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS,
			deadlineAt === undefined ? DEFAULT_RERANK_TIMEOUT_MS : deadlineAt - Date.now(),
		)));
		if (budgetMs === 0) return { candidates: ordered };
		const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]) : AbortSignal.timeout(budgetMs);
		const scoring = this.embedder.scoreRelevance(query, head.map((r) => r.entry.text), stop).catch((error: unknown) => {
			log.warn("local reranker failed; recall keeps the local ranking order", { error }, {
				event_name: "memory.retriever_rerank.diagnostic", file: "packages/memory/src/engine/retrieval/retriever-rerank.ts",
				function: "rerankLocalModel", site_id: "retrieval.retriever-rerank.rerankLocalModel.failed",
			});
			return undefined;
		});
		let onAbort: () => void = () => {};
		const aborted = new Promise<undefined>((resolve) => {
			onAbort = () => resolve(undefined);
			stop.addEventListener("abort", onAbort, { once: true });
		});
		let logits: number[] | undefined;
		try {
			logits = await Promise.race([scoring, aborted]);
		} finally {
			stop.removeEventListener("abort", onAbort);
		}
		if (!logits || signal?.aborted) return { candidates: ordered };
		// Preserve logit differences without sigmoid saturation, then blend equally with cosine.
		// Keep the head's existing score slots so later stages cannot promote an unjudged tail.
		const minimum = Math.min(...logits);
		const span = Math.max(1e-9, Math.max(...logits) - minimum);
		const blended = head.map((candidate, index) => ({
			candidate,
			value: 0.5 * (((logits[index] ?? minimum) - minimum) / span) + 0.5 * candidate.score,
		}));
		blended.sort((a, b) => b.value - a.value || a.candidate.entry.id.localeCompare(b.candidate.entry.id));
		const slots = head.map((candidate) => candidate.score).sort((a, b) => b - a);
		const rescored = blended.map(({ candidate }, index) => {
			const score = slots[index] ?? candidate.score;
			return { ...candidate, score, rerankScore: score, sources: { ...candidate.sources, reranked: { score } } };
		});
		log.debug("local reranker applied", { scored: head.length, duration_ms: performance.now() - started }, {
			event_name: "memory.retriever_rerank.diagnostic", file: "packages/memory/src/engine/retrieval/retriever-rerank.ts",
			function: "rerankLocalModel", site_id: "retrieval.retriever-rerank.rerankLocalModel.applied",
		});
		return { candidates: [...rescored, ...ordered.slice(head.length)], modelOrder: blended.map(({ candidate }) => candidate.entry.id) };
	},

});
