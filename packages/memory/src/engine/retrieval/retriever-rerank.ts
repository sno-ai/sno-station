import { createHash } from "node:crypto";
/** @file retriever-rerank.ts
 * @purpose Runs remote and local reranking.
 * @boundary Prototype-mounted MemoryRetriever methods; no constructor state ownership.
 */

import {
	buildRerankHttpError,
	buildRerankRequest,
	parseRerankResponse,
	type RerankItem,
	RERANK_DEFAULT_ENDPOINTS,
} from "./retrieval-rerank-provider";
import { dotProduct, log } from "./retrieval-scoring-utils";
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
	DEFAULT_MAX_CONTEXT_TOKENS,
	RERANK_PROMPT_TEMPLATE_TOKENS,
	LIGHTWEIGHT_COSINE_WEIGHT,
	LIGHTWEIGHT_FUSION_WEIGHT,
	LIGHTWEIGHT_RERANK_PENALTY,
	RERANK_BLEND_CROSS,
	RERANK_BLEND_VECTOR,
	RetrievalError,
} from "./retriever-dependencies";

// Issue #222. A rerank request that fails on the transport is asked again before the
// pre-rerank order is served: the per-call timeout (Node's fetch rejects an
// `AbortSignal.timeout()` with a DOMException named "TimeoutError", measured on Node 24 —
// the earlier "AbortError" check never matched a real timeout, so timeouts were filed as
// request_error), a reset or refused connection (undici: TypeError "fetch failed" with a
// `cause`), and a 429/502/503/504. Fatal statuses (401/403) and every other outcome go
// through unchanged. The retry stays inside the batch's wave slot, so the number of
// in-flight requests per rerank() call does not grow.
const RERANK_TRANSIENT_ATTEMPTS = 3;
const RERANK_TRANSIENT_BACKOFF_MS = 200;
const RERANK_TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
// A production-like concurrency test returned 429 + retry-after: 1 under eight concurrent
// recalls; bound each queue wait.
const RERANK_RETRY_AFTER_MAX_MS = 5_000;

function isRerankTimeout(error: unknown): boolean {
	return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * The reranker's refusal when a pair is over its window, as the endpoint states it:
 * `{"detail":{"code":"input_token_limit_exceeded","max_input_tokens":512,
 * "candidates":[{"index":0,"input_tokens":728,"excess_tokens":216}]}}` (measured 2026-09-14).
 *
 * It names every offending text, so the batch can be repaired and sent again instead of
 * losing the scores of the 49 texts that were fine. The counts are the SERVER's, taken with
 * the ranking model's tokenizer — which is not the embedder's — so they are the only exact
 * measure available here of how far over the window a text is.
 */
const RERANK_OVER_WINDOW_CODE = "input_token_limit_exceeded";

interface RerankOverWindowRefusal {
	maxInputTokens: number;
	overLong: { index: number; inputTokens: number }[];
}

function parseOverWindowRefusal(body: string): RerankOverWindowRefusal | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const detail = (parsed as { detail?: unknown }).detail;
	if (typeof detail !== "object" || detail === null) return undefined;
	const shape = detail as { code?: unknown; max_input_tokens?: unknown; candidates?: unknown };
	if (shape.code !== RERANK_OVER_WINDOW_CODE) return undefined;
	if (typeof shape.max_input_tokens !== "number" || !Array.isArray(shape.candidates)) {
		return undefined;
	}
	const overLong: { index: number; inputTokens: number }[] = [];
	for (const candidate of shape.candidates) {
		if (typeof candidate !== "object" || candidate === null) continue;
		const named = candidate as { index?: unknown; input_tokens?: unknown };
		if (typeof named.index !== "number" || typeof named.input_tokens !== "number") continue;
		overLong.push({ index: named.index, inputTokens: named.input_tokens });
	}
	return overLong.length === 0
		? undefined
		: { maxInputTokens: shape.max_input_tokens, overLong };
}

function isTransientRerankError(error: unknown): boolean {
	if (isRerankTimeout(error)) return true;
	return error instanceof TypeError && error.cause !== undefined;
}

interface RerankReply {
	response: Response;
	/** The parsed JSON body of an OK response; absent when the status was not OK. */
	data?: unknown;
}

async function fetchRerankWithRetry(send: () => Promise<Response>): Promise<RerankReply> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= RERANK_TRANSIENT_ATTEMPTS; attempt += 1) {
		let retryDelayMs = RERANK_TRANSIENT_BACKOFF_MS * attempt;
		try {
			const response = await send();
			if (response.ok) {
				// Reading the body is part of the attempt: a socket that dies after the 200
				// header rejects here, not in fetch(), and must be retried the same way
				// (PR #225 review).
				const data: unknown = await response.json();
				return { response, data };
			}
			if (!RERANK_TRANSIENT_STATUSES.has(response.status) || attempt === RERANK_TRANSIENT_ATTEMPTS) {
				return { response };
			}
			if (response.status === 429) {
				const retryAfter = response.headers.get("retry-after");
				if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
					retryDelayMs = Math.min(Number.parseInt(retryAfter, 10) * 1_000, RERANK_RETRY_AFTER_MAX_MS);
				}
			}
			// Drop the failed body before the next attempt: undici cannot reuse the
			// connection while a body is unconsumed, so a run of 5xx would pin one
			// connection per attempt (PR #225 review).
			await response.body?.cancel();
			lastError = new Error(`rerank API responded ${response.status}`);
		} catch (error) {
			if (!isTransientRerankError(error) || attempt === RERANK_TRANSIENT_ATTEMPTS) throw error;
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
	}
	throw lastError;
}

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
		// batch size is the transport's own per-request limit.
		//
		// The cap is applied to every provider, not only to the one whose limit it was measured
		// against. It used to read `provider === "tei"`, which made the guarantee depend on a
		// deploy script setting that name: with the provider left unset the code sends the whole
		// pool in one request, and the self-hosted ranker answers a 51-text request with
		// `"too many texts: max 50, got 51"` — an HTTP 400 the error path files as "reranker
		// unavailable", so every search silently serves raw fusion order. Hosted providers
		// document much higher limits, so capping them here only sends more, smaller requests,
		// which the waves below already run four at a time. Costing a little parallelism is the
		// cheap side of this trade; a silent whole-search degradation is the expensive one.
		const maxCandidates = this.config.rerankMaxCandidates;
		const overCap = maxCandidates !== undefined && candidates.length > maxCandidates;
		const toRerank = overCap ? candidates.slice(0, maxCandidates) : candidates;
		const beyondCap = overCap ? candidates.slice(maxCandidates) : [];
		const batchSize = DEFAULT_TEI_RERANK_MAX_CANDIDATES;

		// The reranker scores the query and ONE document together in a single token window, and
		// refuses the WHOLE request when any pair exceeds it — "no candidates were scored or
		// truncated" (measured 2026-09-14). So one over-budget candidate costs the scores of its
		// whole batch, which the error path then reports as a plain fallback to fusion scores.
		//
		// The document budget is therefore what the query leaves, and it is never the record
		// ceiling: a record at DEFAULT_MAX_CONTEXT_TOKENS plus a query of any length is already
		// past the window. Cutting here keeps `candidate.entry.text` in the result untouched.
		const queryTokens = this.embedder.countTokens(query);
		const documentTokenBudget =
			DEFAULT_MAX_CONTEXT_TOKENS - RERANK_PROMPT_TEMPLATE_TOKENS - queryTokens;
		// Guard the budget here so the remaining retrieval scoring path works with normalized inputs.
		if (documentTokenBudget <= 0) {
			// Log operational context for retrieval ranking without changing control flow.
			log.warn("rerank skipped: the query alone fills the reranker token window", {
				queryTokens,
				window: DEFAULT_MAX_CONTEXT_TOKENS,
				templateTokens: RERANK_PROMPT_TEMPLATE_TOKENS,
			}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "rerank", site_id: "retrieval.retriever-rerank.rerank.query_over_window" });
			return { candidates, fallback: { reason: "query_over_window", provider } };
		}
		let truncatedCandidates = 0;
		const rerankTexts = toRerank.map((c) => {
			const bounded = this.embedder.truncateToTokens(c.entry.text, documentTokenBudget);
			if (bounded !== c.entry.text) truncatedCandidates += 1;
			return bounded;
		});
		if (truncatedCandidates > 0) {
			// Log operational context for retrieval ranking without changing control flow.
			log.warn("rerank candidates were cut to the document budget the query left", {
				truncatedCandidates,
				documentTokenBudget,
				queryTokens,
			}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "rerank", site_id: "retrieval.retriever-rerank.rerank.candidate_over_ceiling" });
		}

		// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
		try {
			// One request per batch; an item's index is relative to its batch and is
			// re-based onto the full candidate list here, so a score can never land
			// on a different row than the one it was given for.
			const runBatch = async (start: number): Promise<RerankItem[] | RerankFallbackReason> => {
				let batchTexts = rerankTexts.slice(start, start + batchSize);
				// Two passes at most. The local cut above uses the EMBEDDER's tokenizer, which is
				// not the tokenizer the ranking model counts with, so a text can still arrive over
				// the window — most easily in a script the two disagree about. The endpoint then
				// refuses the whole batch and names the texts at fault, so the second pass sends it
				// again with just those cut to what its own count says fits. Without this, one
				// over-window text costs the scores of the other 49 and the search silently serves
				// raw fusion order.
				for (let pass = 0; ; pass += 1) {
					const { headers, body } = buildRerankRequest(
						provider,
						rerankApiKey,
						this.config.rerankModel ?? DEFAULT_RERANK_MODEL,
						query,
						batchTexts,
						batchTexts.length,
					);

					// Await the retrieval ranking dependency before deriving downstream state. A
					// transient transport failure is retried inside this batch's wave slot (issue
					// #222): measured 2026-09-10, 5 of 1,542 searches fell back on an idle box and 56
					// in 30 minutes beside 8 concurrent searches, each on the first miss.
					const { response, data } = await fetchRerankWithRetry(() =>
						fetch(rerankEndpoint, {
							method: "POST",
							headers,
							body: JSON.stringify(body),
							signal: AbortSignal.timeout(rerankTimeoutMs),
						}),
					);

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
						const refusal = pass === 0 ? parseOverWindowRefusal(errorBody) : undefined;
						// Guard the refusal here so the remaining retrieval scoring path works with normalized inputs.
						if (refusal) {
							const allowed = refusal.maxInputTokens - RERANK_PROMPT_TEMPLATE_TOKENS;
							batchTexts = batchTexts.map((text, index) => {
								const named = refusal.overLong.find((c) => c.index === index);
								// Untouched: this text was inside the window as sent.
								if (!named) return text;
								// The reported count covers the WHOLE pair, and the query does not shrink
								// with the document, so the document's share of the allowance is the
								// allowance less the query. Scaling the document by the pair's ratio
								// alone leaves the query counted at the ranker's rate and not paid for:
								// with a 100-token query and a ranker counting half again what the
								// embedder does, the resent pair is still over the window and the batch
								// is lost anyway. Ratio here is the server's count per local token
								// across query and document together, which is all one refusal reports.
								const localTokens = this.embedder.countTokens(text);
								const localPairTokens = queryTokens + localTokens;
								const target = Math.max(
									1,
									Math.floor((allowed * localPairTokens) / named.inputTokens) - queryTokens,
								);
								return this.embedder.truncateToTokens(text, target);
							});
							// Log operational context for retrieval ranking without changing control flow.
							log.warn("rerank batch refused over its token window; resending the named texts cut to fit", {
								status: response.status,
								overLongCount: refusal.overLong.length,
								maxInputTokens: refusal.maxInputTokens,
								sentToRerankCount: batchTexts.length,
								batchStart: start,
							}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "runBatch", site_id: "retrieval.retriever-rerank.runBatch.over_window_repair" });
							continue;
						}
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
				}
			};

			const batchStarts: number[] = [];
			for (let start = 0; start < rerankTexts.length; start += batchSize) batchStarts.push(start);

			// The batches go out in waves rather than one after another: a pool of
			// `MAX_CANDIDATE_POOL_SIZE` is 11 TEI requests, and serially that is 11 timeouts' worth of
			// wall clock on one tool call. A wave is settled before the next one starts; any rejection
			// takes precedence over degradation and ends the whole rerank, so a wedged reranker
			// costs one wave of up to RERANK_TRANSIENT_ATTEMPTS timeouts. Outcomes are read in ascending batch order and the items are
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
				for (const outcome of settled) {
					if (outcome.status === "rejected" && outcome.reason instanceof RetrievalError) {
						throw outcome.reason;
					}
				}
				// Iterate deterministically so retrieval ranking output order remains stable.
				for (const outcome of settled) {
					// Surface this invalid retrieval ranking state as an explicit typed failure.
					if (outcome.status === "rejected") throw outcome.reason;
				}
				for (const outcome of settled) {
					if (outcome.status === "fulfilled" && typeof outcome.value === "string") {
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

			// TEI logits share one scale across batches; normalize over the whole retrieval.
			let minScore = Infinity;
			let maxScore = -Infinity;
			if (provider === "tei") {
				for (const item of items) {
					minScore = Math.min(minScore, item.score);
					maxScore = Math.max(maxScore, item.score);
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
				let crossScore = item.score;
				if (provider === "tei") {
					crossScore = maxScore === minScore
						? 1 / (1 + Math.exp(-item.score))
						: (item.score - minScore) / (maxScore - minScore);
				}
				const blendedScore = clamp01(
					crossScore * blendCross + sourceScore * blendVector,
					0,
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
					score: clamp01(
						this.getRerankSourceScore(r) * LIGHTWEIGHT_RERANK_PENALTY,
						0,
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
			return {
				candidates: merged.length > 0 ? merged : candidates,
				stats: {
					rerankSentCount: toRerank.length,
					rerankReturnedCount: reranked.length,
					rerankBeyondCapCount: beyondCap.length,
				},
			};
		} catch (error) {
			// Route failure states into a deterministic recovery or reporting branch.
			if (error instanceof RetrievalError) {
				// Surface this invalid retrieval ranking state as an explicit typed failure.
				throw error;
			}
			let reason: RerankFallbackReason;
			// Route failure states into a deterministic recovery or reporting branch.
			if (isRerankTimeout(error)) {
				reason = "timeout";
				// Log operational context for retrieval ranking without changing control flow.
				log.warn("rerank API timed out, using pre-rerank results", {
					timeoutMs: rerankTimeoutMs,
					attempts: RERANK_TRANSIENT_ATTEMPTS,
				}, { event_name: "memory.retriever_rerank.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-rerank.ts", function: "rerank", site_id: "retrieval.retriever-rerank.rerank.4af9c17c75" });
			} else {
				reason = "request_error";
				// Log operational context for retrieval ranking without changing control flow.
				log.warn("rerank error, using pre-rerank results", {
					error,
					attempts: RERANK_TRANSIENT_ATTEMPTS,
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
});
