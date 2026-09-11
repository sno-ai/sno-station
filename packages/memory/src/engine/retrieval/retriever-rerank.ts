import { createHash } from "node:crypto";
/** @file retriever-rerank.ts
 * @purpose Runs remote and local reranking plus preservation floors.
 * @boundary Prototype-mounted MemoryRetriever methods; no constructor state ownership.
 */

import {
	buildRerankHttpError,
	buildRerankRequest,
	parseRerankResponse,
	type RerankItem,
	RERANK_DEFAULT_ENDPOINTS,
} from "./retrieval-rerank-provider";
import { clamp01WithFloor, dotProduct, log } from "./retrieval-scoring-utils";
import {
	MemoryRetriever,
	type MemoryRetrieverInternals,
	type RerankFallbackReason,
	type RerankOutcome,
} from "./retriever-core";
import type { RetrievalResult } from "./retriever-dependencies";
import {
	clamp01,
	DEFAULT_RERANK_BATCH_CONCURRENCY,
	DEFAULT_RERANK_MODEL,
	DEFAULT_RERANK_TIMEOUT_MS,
	DEFAULT_TEI_RERANK_MAX_CANDIDATES,
	DEFAULT_TEI_RERANK_MAX_TEXT_LENGTH,
	LIGHTWEIGHT_COSINE_WEIGHT,
	LIGHTWEIGHT_FUSION_WEIGHT,
	LIGHTWEIGHT_RERANK_PENALTY,
	RERANK_BLEND_CROSS,
	RERANK_BLEND_VECTOR,
	RERANK_PRESERVATION_BM25_HIGH_THRESHOLD,
	RERANK_PRESERVATION_BM25_MID_THRESHOLD,
	RERANK_PRESERVATION_HIGH_RETURNED,
	RERANK_PRESERVATION_HIGH_UNRETURNED,
	RERANK_PRESERVATION_LOW_RETURNED,
	RERANK_PRESERVATION_LOW_UNRETURNED,
	RERANK_PRESERVATION_MID_RETURNED,
	RERANK_PRESERVATION_MID_UNRETURNED,
	RetrievalError,
} from "./retriever-dependencies";

Object.assign(MemoryRetriever.prototype, {
	async rerank(
		this: MemoryRetrieverInternals,
		query: string,
		candidates: RetrievalResult[],
		queryVector: Float32Array,
	): Promise<RerankOutcome> {
		// Treat the empty collection as a first-class outcome instead of widening behavior.
		if (candidates.length === 0) return { candidates };
		// Branch on configuration before selecting the runtime strategy.
		if (this.config.rerank === "none") {
			return { candidates };
		}
		// Compute the provider name even on the lightweight/skip paths so the
		// telemetry attribution stays consistent with the cross-encoder branch
		// (consumers slice by provider, not by which fallback fired).
		const provider = this.config.rerankProvider ?? "voyage";
		// Branch on configuration before selecting the runtime strategy.
		// This used to warn once per process and rank with the local cosine blend instead. A
		// deployment then ran a ranker nobody had chosen, and the single warning line was the
		// only trace of it in a whole run — measured 2026-08-30 on the agent E2E target, where
		// the row carrying the asked-for identifier never reached the top five. Configuration
		// decides which ranker runs; a configuration that cannot be honoured is refused here
		// rather than answered with a different one. The plugin config schema rejects this pair
		// before startup, so reaching this line means the retriever was constructed from a
		// config that never went through it.
		if (this.config.rerank === "cross-encoder" && !this.config.rerankApiKey) {
			// Surface this invalid retrieval ranking state as an explicit typed failure.
			throw new RetrievalError(
				`rerank "cross-encoder" requires retrieval.rerankApiKey (provider: ${provider}); ` +
					'set the key, or set retrieval.rerank to "lightweight" to choose the local ranker',
			);
		}
		if (this.config.rerank === "lightweight" || !this.config.rerankApiKey) {
			// Lightweight is the configured strategy, not a degradation — no fallback signal.
			return { candidates: this.rerankLightweight(candidates, queryVector) };
		}

		// Compute the normalized rerank endpoint once so later retrieval scoring checks use one value.
		const rerankEndpoint = this.config.rerankEndpoint ?? RERANK_DEFAULT_ENDPOINTS[provider];
		// Guard rerank endpoint here so the remaining retrieval scoring path works with normalized inputs.
		if (!rerankEndpoint) {
			// Log operational context for retrieval ranking without changing control flow.
			log.warn("rerank skipped: no endpoint for provider", { provider }, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "rerank", site_id: "retrieval.retriever-rerank.rerank.6fbc6b3a22" });
			return { candidates, fallback: { reason: "no_endpoint", provider } };
		}
		// Compute the normalized rerank timeout ms once so later retrieval scoring checks use one value.
		const rerankTimeoutMs = this.config.rerankTimeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
		// Read the key once: the guard above narrowed it, and a property access does not carry that
		// narrowing into the per-batch closure below.
		const rerankApiKey = this.config.rerankApiKey;

		// Some rerank deployments (e.g. this repo's Sno TEI reranker, hard-capped
		// at 50) reject an over-limit batch outright instead of truncating it —
		// so the candidates go out in batches of that size and every one of them
		// is scored. Until 2026-09-06 only the first batch was sent and the rest
		// were carried through at a penalised score, which pinned the reranker's
		// reach at 50 rows whatever the candidate pool held; with the pool at 512
		// that cap decided the answer more often than the ranker did.
		// `rerankMaxCandidates` stays the TOTAL an operator allows out to the reranker; the
		// batch size is the transport's own per-request limit, and only TEI has one.
		const maxCandidates = this.config.rerankMaxCandidates;
		const overCap = maxCandidates !== undefined && candidates.length > maxCandidates;
		const toRerank = overCap ? candidates.slice(0, maxCandidates) : candidates;
		const beyondCap = overCap ? candidates.slice(maxCandidates) : [];
		const batchSize =
			provider === "tei" ? DEFAULT_TEI_RERANK_MAX_CANDIDATES : Math.max(toRerank.length, 1);

		// Some rerank deployments (e.g. the same Sno TEI reranker) also reject a
		// single over-length document outright ({"error":"text too long: max
		// 8192 characters"}) — LoCoMo's bulk-import corpus stores whole session
		// transcripts as one memory chunk and regularly exceeds this. Only the
		// outgoing request text is truncated; `candidate.entry.text` in the
		// returned result is untouched.
		const maxTextLength =
			this.config.rerankMaxTextLength ??
			(provider === "tei" ? DEFAULT_TEI_RERANK_MAX_TEXT_LENGTH : undefined);
		const rerankTexts = toRerank.map((c) =>
			maxTextLength !== undefined ? c.entry.text.slice(0, maxTextLength) : c.entry.text,
		);

		// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
		try {
			// One request per batch; an item's index is relative to its batch and is
			// re-based onto the full candidate list here, so a score can never land
			// on a different row than the one it was given for.
			const runBatch = async (start: number): Promise<RerankItem[] | RerankFallbackReason> => {
				const batchTexts = rerankTexts.slice(start, start + batchSize);
				const { headers, body } = buildRerankRequest(
					provider,
					rerankApiKey,
					this.config.rerankModel ?? DEFAULT_RERANK_MODEL,
					query,
					batchTexts,
					batchTexts.length,
				);

				// Await the retrieval ranking dependency before deriving downstream state.
				const response = await fetch(rerankEndpoint, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(rerankTimeoutMs),
				});

				// Guard response.ok here so the remaining retrieval scoring path works with normalized inputs.
				if (!response.ok) {
					const retryAfter = response.headers.get("retry-after");
					const fatalError = buildRerankHttpError(response.status, retryAfter);
					// Guard guard condition here so the remaining retrieval scoring path works with normalized inputs.
					if (fatalError) {
						// Surface this invalid retrieval ranking state as an explicit typed failure.
						throw fatalError;
					}
					// Capture the response body for diagnostics — a bare status code
					// previously left every non-fatal rerank failure (e.g. a provider's
					// undocumented batch-size or text-length limit) impossible to
					// diagnose without manually reproducing the request by hand.
					const errorBody = await response.text().catch(() => "<unreadable body>");
					// Log operational context for retrieval ranking without changing control flow.
					log.warn("rerank API failed, using pre-rerank results", {
						status: response.status,
						endpoint_hash: createHash("sha256").update(rerankEndpoint).digest("hex"),
						retryAfter,
						sentToRerankCount: batchTexts.length,
						batchStart: start,
						body_length: errorBody.length,
					}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "runBatch", site_id: "retrieval.retriever-rerank.runBatch.76d7d1fac6" });
					return "http_error";
				}

				const data: unknown = await response.json();
				const parsed = parseRerankResponse(provider, data);
				// Guard items here so the remaining retrieval scoring path works with normalized inputs.
				if (!parsed) {
					// Log operational context for retrieval ranking without changing control flow.
					log.warn("rerank API returned unparseable response", {
						provider,
						endpoint_hash: createHash("sha256").update(rerankEndpoint).digest("hex"),
						batchStart: start,
					}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "runBatch", site_id: "retrieval.retriever-rerank.runBatch.4429b8bd8a" });
					return "invalid_response";
				}
				const batchItems: RerankItem[] = [];
				for (const item of parsed) {
					if (item.index < 0 || item.index >= batchTexts.length) continue;
					batchItems.push({ index: start + item.index, score: item.score });
				}
				return batchItems;
			};

			const batchStarts: number[] = [];
			for (let start = 0; start < rerankTexts.length; start += batchSize) batchStarts.push(start);

			// The batches go out in waves rather than one after another: a pool of
			// `MAX_CANDIDATE_POOL_SIZE` is 11 TEI requests, and serially that is 11 timeouts' worth of
			// wall clock on one tool call. A wave is settled before the next one starts and the first
			// failure ends the whole rerank, which is what the serial loop did, so a wedged reranker
			// still costs one timeout. Outcomes are read in ascending batch order and the items are
			// appended in that same order, so the list this builds is the one the serial loop built.
			const items: RerankItem[] = [];
			for (
				let wave = 0;
				wave < batchStarts.length;
				wave += DEFAULT_RERANK_BATCH_CONCURRENCY
			) {
				const waveStarts = batchStarts.slice(wave, wave + DEFAULT_RERANK_BATCH_CONCURRENCY);
				// `allSettled`, not `all`: a fatal HTTP status rejects its batch, and the siblings
				// already in flight must still be awaited or their own rejections surface unhandled.
				const settled = await Promise.allSettled(waveStarts.map(runBatch));
				// Iterate deterministically so retrieval ranking output order remains stable.
				for (const outcome of settled) {
					// Surface this invalid retrieval ranking state as an explicit typed failure.
					if (outcome.status === "rejected") throw outcome.reason;
					if (typeof outcome.value === "string") {
						return { candidates, fallback: { reason: outcome.value, provider } };
					}
				}
				// Iterate deterministically so retrieval ranking output order remains stable.
				for (const outcome of settled) {
					if (outcome.status === "fulfilled" && typeof outcome.value !== "string") {
						items.push(...outcome.value);
					}
				}
			}

			// Compute the normalized blend cross once so later retrieval scoring checks use one value.
			const blendCross = this.config.rerankBlendCross ?? RERANK_BLEND_CROSS;
			// Compute the normalized blend vector once so later retrieval scoring checks use one value.
			const blendVector = this.config.rerankBlendVector ?? RERANK_BLEND_VECTOR;
			const returnedIndices = new Set(items.map((r) => r.index));

			// Compute the normalized reranked once so later retrieval scoring checks use one value.
			const reranked: RetrievalResult[] = [];
			const seenIndices = new Set<number>();
			// Iterate deterministically so retrieval ranking output order remains stable.
			for (const item of items) {
				// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
				if (seenIndices.has(item.index)) continue;
				seenIndices.add(item.index);
				const candidate = toRerank[item.index];
				// Handle the absent-value case explicitly before the happy path depends on it.
				if (!candidate) continue;
				const sourceScore = this.getRerankSourceScore(candidate);
				const floor = this.getRerankPreservationFloor(candidate, false);
				const blendedScore = clamp01WithFloor(
					item.score * blendCross + sourceScore * blendVector,
					floor,
				);
				// Append only after validation has accepted this value for the current branch.
				reranked.push({
					...candidate,
					score: blendedScore,
					sources: {
						...candidate.sources,
						reranked: { score: item.score },
					},
				});
			}

			// Keep unreturned candidates with penalized scores: what the reranker chose not to
			// return, and what the operator's cap kept from being sent at all.
			const unreturned = [
				...toRerank.filter((_, idx) => !returnedIndices.has(idx)),
				...beyondCap,
			].map(
				(r) => ({
					...r,
					score: clamp01WithFloor(
						this.getRerankSourceScore(r) * LIGHTWEIGHT_RERANK_PENALTY,
						this.getRerankPreservationFloor(r, true),
					),
				}),
			);

			// Transform the collection in one place so retrieval ranking ordering and filters stay reviewable.
			const merged = [...reranked, ...unreturned].sort((a, b) => b.score - a.score);

			// Log operational context for retrieval ranking without changing control flow.
			log.debug("reranked", {
				totalCandidateCount: candidates.length,
				sentToRerankCount: toRerank.length,
				returnedCount: reranked.length,
				provider,
			}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "rerank", site_id: "retrieval.retriever-rerank.rerank.7847c6248a" });
			return { candidates: merged.length > 0 ? merged : candidates };
		} catch (error) {
			// Route failure states into a deterministic recovery or reporting branch.
			if (error instanceof RetrievalError) {
				// Surface this invalid retrieval ranking state as an explicit typed failure.
				throw error;
			}
			let reason: RerankFallbackReason;
			// Route failure states into a deterministic recovery or reporting branch.
			if (error instanceof Error && error.name === "AbortError") {
				reason = "timeout";
				// Log operational context for retrieval ranking without changing control flow.
				log.warn("rerank API timed out, using pre-rerank results", {
					timeoutMs: rerankTimeoutMs,
				}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "rerank", site_id: "retrieval.retriever-rerank.rerank.4af9c17c75" });
			} else {
				reason = "request_error";
				// Log operational context for retrieval ranking without changing control flow.
				log.warn("rerank error, using pre-rerank results", {
					error,
				}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "rerank", site_id: "retrieval.retriever-rerank.rerank.2c5fc67dbf" });
			}
			return { candidates, fallback: { reason, provider } };
		}
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
			// Blend the fused score with a fresh cosine check (upstream's
			// cosine-fallback rerank: `score*0.7 + cosine*0.3`). Valid now that
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
			// Embedder-dimension invariant (PRD §6.0.1): block silent NaN
			// propagation when DB has rows from a different embedder dim.
			if (chunkVector.length !== queryVector.length) {
				dimMismatchCount += 1;
				return { ...candidate, rerankScore: fusedScore };
			}
			// Vectors are L2-normalized by the embedder (`packages/embedder`),
			// so cosine ≡ dot product.
			const cosine = clamp01(dotProduct(queryVector, chunkVector), 0);
			const blended = fusedScore * wF + cosine * wC;
			const floor = this.getRerankPreservationFloor(candidate, false);
			const finalScore = clamp01WithFloor(blended, floor);
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
			}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "rerankLightweight", site_id: "retrieval.retriever-rerank.rerankLightweight.70eb2031f1" });
		}
		log.debug("lightweight rerank applied", {
			candidateCount: candidates.length,
			blendedCount,
			fusionWeight: wF,
			cosineWeight: wC,
		}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "rerankLightweight", site_id: "retrieval.retriever-rerank.rerankLightweight.7e8d0eee29" });

		// Sort by new score desc; tie-break on entry id keeps determinism.
		return reranked.sort((a, b) => {
			const diff = b.score - a.score;
			if (diff !== 0) return diff;
			return a.entry.id.localeCompare(b.entry.id);
		});
	},

	getRerankSourceScore(this: MemoryRetrieverInternals, result: RetrievalResult): number {
		return clamp01(Math.max(result.sources.bm25?.score ?? 0, result.sources.vector?.score ?? 0), 0);
	},

	getRerankPreservationFloor(
		this: MemoryRetrieverInternals,
		result: RetrievalResult,
		unreturned: boolean,
	): number {
		const bm25Score = result.sources.bm25?.score ?? 0;
		const sourceScore = this.getRerankSourceScore(result);
		// Guard bm25score here so the remaining retrieval scoring path works with normalized inputs.
		if (bm25Score >= RERANK_PRESERVATION_BM25_HIGH_THRESHOLD) {
			return (
				sourceScore *
				(unreturned ? RERANK_PRESERVATION_HIGH_UNRETURNED : RERANK_PRESERVATION_HIGH_RETURNED)
			);
		}
		// Guard bm25score here so the remaining retrieval scoring path works with normalized inputs.
		if (bm25Score >= RERANK_PRESERVATION_BM25_MID_THRESHOLD) {
			return (
				sourceScore *
				(unreturned ? RERANK_PRESERVATION_MID_UNRETURNED : RERANK_PRESERVATION_MID_RETURNED)
			);
		}
		return (
			sourceScore *
			(unreturned ? RERANK_PRESERVATION_LOW_UNRETURNED : RERANK_PRESERVATION_LOW_RETURNED)
		);
	},
});
