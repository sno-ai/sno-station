/** @file retriever-search-modes.ts
 * @purpose Executes vector, keyword, precision recall, and RRF search modes.
 * @boundary Prototype-mounted MemoryRetriever methods; no constructor state ownership.
 */

import type { RetrievalContext } from "./retrieval-config";
import { log } from "./retrieval-scoring-utils";
import { MemoryRetriever, type MemoryRetrieverInternals } from "./retriever-core";
import type {
	MemorySearchResult,
	RetrievalResult,
	SearchOptions,
} from "./retriever-dependencies";
import { experimentCandidatePoolOverride } from "../../../config/index";
import {
	clamp01,
	MAX_AGGREGATION_ROWS,
	MAX_CANDIDATE_POOL_SIZE,
	PRECISION_RECALL_POOL_SIZE_FACTOR,
	RetrievalError,
	type TraceCollector,
} from "./retriever-dependencies";

export function buildRemFacetRecallStatement(input: {
	facet: "current" | "history";
}): { sql: string; parameters: unknown[] } {
	return {
		sql: "SELECT memory_id, text, updated_at_ms FROM nodix_rem_memory_facets INDEXED BY rem_memory_facets_by_facet WHERE facet = ? ORDER BY memory_id",
		parameters: [input.facet],
	};
}

Object.assign(MemoryRetriever.prototype, {
	async aggregationComplete(
		this: MemoryRetrieverInternals,
		context: RetrievalContext,
		trace?: TraceCollector,
	): Promise<RetrievalResult[]> {
		// Storage returns one bounded SQLite page and marks an incomplete population.
		//
		// `taskCarrierPopulation` is deliberately never derived from the query's words. Until
		// 2026-08-21 three regex banks read the question and narrowed the population to active,
		// terminal or all task rows; measured that day against the six preserved benchmark stores,
		// turning that inference off moved the nine task and calendar questions from 0.533 to 0.633
		// and made none of them worse. A caller that knows which population it wants passes the
		// option explicitly.
		trace?.startStage("aggregation_evidence", []);
		const results = await this.store.searchAggregationEvidence({
			limit: MAX_AGGREGATION_ROWS,
			projectIdFilter: context.scopeFilter,
			category: context.category,
			includeRefused: context.includeRefused,
			aggregation: context.aggregation,
			facetPolicy: context.facetPolicy,
			...(context.excludeInvalidatedBefore !== undefined && { excludeInvalidatedBefore: context.excludeInvalidatedBefore }),
			...(context.excludeSuperseded === undefined ? {} : { excludeSuperseded: context.excludeSuperseded }),
		});
		this.throwIfAborted(context);
		// The empty-population fallback that used to sit here could only fire when the population
		// had been narrowed from the query's wording, which stopped on 2026-08-21. With no narrowing
		// there is no narrowed-to-nothing state to recover from.
		const mapped = results.map((result) => ({
			entry: result.entry, score: result.score, sources: {}, chunkId: result.chunkId,
			chunkIndex: result.chunkIndex, bestChunkScore: result.bestChunkScore, denseScore: result.score,
			snippet: result.snippet,
			eventIdentity: result.eventIdentity,
			scopeRowCount: result.scopeRowCount,
			aggregationIncomplete: result.aggregationIncomplete,
		}));
		trace?.endStage(mapped.map((result) => result.entry.id), mapped.map((result) => result.score));
		log.info("aggregation evidence served", {
			rows: mapped.length,
				scopeRows: mapped[0]?.scopeRowCount ?? 0,
			readingBudget: context.limit,
			bounded: true,
			scopes: context.scopeFilter?.length ?? 0,
			...(context.category ? { category: context.category } : {}),
		}, { event_name: "memory.retriever_search_modes.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-search-modes.ts", function: "aggregationComplete", site_id: "retrieval.retriever-search-modes.aggregationComplete.5a3b7f9337" });
		return mapped;
	},

	async vectorOnly(
		this: MemoryRetrieverInternals,
		context: RetrievalContext,
		trace?: TraceCollector,
	): Promise<RetrievalResult[]> {
		// Await the retrieval ranking dependency before deriving downstream state.
		const vector = await this.embedder.embed(context.query);
		this.throwIfAborted(context);

		// Over-fetch when expiry filtering is on, since filtering removes candidates
		const searchLimit = this.config.temporalExpiry
			? Math.max(this.config.candidatePoolSize, context.limit * 2)
			: context.limit;

		// This retrieval scoring step establishes state that later reads and cleanup paths depend on.
		trace?.startStage("vector_search", []);
		// Await the retrieval ranking dependency before deriving downstream state.
		// No minScore here: precisionRecall doesn't pass one into its raw
		// searches either. `minScore` is a post-pipeline-score floor (see
		// config/index.ts) and is applied once, below, after applyScoringPipeline —
		// passing it here too would double it as a raw-cosine floor on this mode
		// only (host-reviewer, 2026-07-05 follow-up).
		const results = await this.store.searchSemantic(vector, {
			limit: searchLimit,
			projectIdFilter: context.scopeFilter,
			category: context.category,
			includeRefused: context.includeRefused,
			facetPolicy: context.facetPolicy,
			...(context.excludeInvalidatedBefore !== undefined && {
				excludeInvalidatedBefore: context.excludeInvalidatedBefore,
			}),
			...(context.excludeSuperseded === undefined ? {} : { excludeSuperseded: context.excludeSuperseded }),
		});
		this.throwIfAborted(context);
		// Transform the collection in one place so retrieval ranking ordering and filters stay reviewable.
		let mapped: RetrievalResult[] = results.map((result, index) => ({
			entry: result.entry,
			score: result.score,
			sources: { vector: { score: result.score, rank: index + 1 } },
			chunkId: result.chunkId,
			chunkIndex: result.chunkIndex,
			bestChunkScore: result.bestChunkScore,
			snippet: result.snippet,
			denseScore: result.score,
		}));
		trace?.endStage(
			mapped.map((r) => r.entry.id),
			mapped.map((r) => r.score),
		);

		trace?.startStage(
			"expiry_filter",
			mapped.map((result) => result.entry.id),
		);
		mapped = this.filterExpired(mapped);
		trace?.endStage(mapped.map((result) => result.entry.id));
		mapped = this.applyScoringPipeline(mapped, trace, context.limit);
		// `precisionRecall` re-checks minScore after the scoring
		// pipeline runs (the pipeline's shrinker chain can move a score across the
		// floor in either direction); vectorOnly was missing this and only ever
		// applied minScore as a pre-pipeline raw-cosine floor above, silently
		// diverging from the other two modes (host-reviewer, 2026-07-05).
		trace?.startStage(
			"min_score_filter",
			mapped.map((result) => result.entry.id),
		);
		mapped = mapped.filter((result) => result.score >= this.config.minScore);
		trace?.endStage(
			mapped.map((result) => result.entry.id),
			mapped.map((result) => result.score),
		);
		// Centralize the retrieval scoring fallback value at the boundary of this helper.
		trace?.startStage(
			"limit_slice",
			mapped.map((result) => result.entry.id),
		);
		const served = mapped.slice(0, context.limit);
		trace?.endStage(
			served.map((result) => result.entry.id),
			served.map((result) => result.score),
		);
		return served;
	},


	async precisionRecall(
		this: MemoryRetrieverInternals,
		context: RetrievalContext,
		trace?: TraceCollector,
	): Promise<RetrievalResult[]> {
		// Step 1. The only model call on the read path; its latency was previously
		// unattributable because nothing recorded it.
		trace?.startStage("embed_query", []);
		const queryVector = await this.embedder.embed(context.query);
		trace?.endStage([]);
		this.throwIfAborted(context);
		const bm25Query = context.query;
		// The block 210 experiment override, when the harness set it, replaces the whole
		// clamp: the ceiling is exactly what the pool-200 cell needs to get past, so
		// re-applying it here would silently serve the shipped value and report the cell
		// as if it had run. Unset in every ordinary run, including production.
		const poolOverride = experimentCandidatePoolOverride();
		const poolSize =
			poolOverride ??
			Math.min(
				Math.max(this.config.candidatePoolSize, context.limit * PRECISION_RECALL_POOL_SIZE_FACTOR),
				MAX_CANDIDATE_POOL_SIZE,
			);
		// No pre-fusion candidate-score floor here: the vector branch's minimum
		// possible score is 0.333 (1/(1+L2), L2 in [0,2]) and BM25's is 0 by
		// construction (goodness/(1+goodness), goodness >= 0) — any floor below
		// those is mathematically inert. Removed 2026-07-05 (was 0.15 / 0, both
		// dead in every configuration, not just at LoCoMo's corpus size).
		const sharedSearchOptions: SearchOptions = {
			limit: poolSize,
			projectIdFilter: context.scopeFilter,
			category: context.category,
			includeRefused: context.includeRefused,
			facetPolicy: context.facetPolicy,
			...(context.excludeInvalidatedBefore !== undefined && {
				excludeInvalidatedBefore: context.excludeInvalidatedBefore,
			}),
			...(context.excludeSuperseded === undefined ? {} : { excludeSuperseded: context.excludeSuperseded }),
		};

		trace?.startStage("parallel_search", []);
		// Run independent branches together while preserving partial-failure diagnostics.
		const [vectorSettled, keywordSettled] = await Promise.allSettled([
			this.store.searchSemantic(queryVector, sharedSearchOptions),
			this.store.searchKeyword(bm25Query, sharedSearchOptions),
		]);
		this.throwIfAborted(context);
		const errorMessage = (reason: unknown): string =>
			reason instanceof Error ? reason.message : String(reason);
		const vectorError =
			vectorSettled.status === "rejected"
				? errorMessage(vectorSettled.reason)
				: undefined;
		const keywordError =
			keywordSettled.status === "rejected"
				? errorMessage(keywordSettled.reason)
				: undefined;
		const branchMetadata = {
			vectorStatus: vectorSettled.status,
			vectorCount: vectorSettled.status === "fulfilled" ? vectorSettled.value.length : 0,
			keywordStatus: keywordSettled.status,
			keywordCount: keywordSettled.status === "fulfilled" ? keywordSettled.value.length : 0,
			...(vectorError === undefined ? {} : { vectorError }),
			...(keywordError === undefined ? {} : { keywordError }),
		};

		// Fail fast if both branches rejected — a broken DB/index must not be silent
		if (vectorSettled.status === "rejected" && keywordSettled.status === "rejected") {
			trace?.endStage([], [], branchMetadata);
			// Surface this invalid retrieval ranking state as an explicit typed failure.
			throw new RetrievalError("Both vector and keyword search failed", vectorSettled.reason);
		}

		// Compute the normalized vector results once so later retrieval scoring checks use one value.
		let vectorResults = vectorSettled.status === "fulfilled" ? vectorSettled.value : [];
		// Route failure states into a deterministic recovery or reporting branch.
		if (vectorSettled.status === "rejected") {
			// Log operational context for retrieval ranking without changing control flow.
			log.warn("vector search branch failed, using keyword-only", {
				error: vectorError,
			}, { event_name: "memory.retriever_search_modes.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-search-modes.ts", function: "precisionRecall", site_id: "retrieval.retriever-search-modes.precisionRecall.97b8770f50" });
		}
		let keywordResults = keywordSettled.status === "fulfilled" ? keywordSettled.value : [];
		// Route failure states into a deterministic recovery or reporting branch.
		if (keywordSettled.status === "rejected") {
			// Log operational context for retrieval ranking without changing control flow.
			log.warn("keyword search branch failed, using vector-only", {
				error: keywordError,
			}, { event_name: "memory.retriever_search_modes.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-search-modes.ts", function: "precisionRecall", site_id: "retrieval.retriever-search-modes.precisionRecall.c20ade60c4" });
		}

		// Close `parallel_search` on what the two branches actually returned, BEFORE any other
		// stage opens. `startStage` closes whatever is still open as unchanged, so opening the
		// expiry stage first silently reported this one as 0 in / 0 out — caught by reading the
		// first real stage record, 2026-08-26.
		if (trace) {
			const allIds = [
				...vectorResults.map((r) => r.entry.id),
				...keywordResults.map((r) => r.entry.id),
			];
			trace.endStage(
				allIds,
				[
					...vectorResults.map((r) => r.score),
					...keywordResults.map((r) => r.score),
				],
				branchMetadata,
			);
		}

		// Traced separately: an expired candidate dropped here used to be indistinguishable from
		// a candidate the search never returned, because both fell inside `parallel_search`.
		const beforeExpiry = [
			...new Set([
				...vectorResults.map((result) => result.entry.id),
				...keywordResults.map((result) => result.entry.id),
			]),
		];
		trace?.startStage("expiry_filter", beforeExpiry);
		vectorResults = this.filterExpiredCandidates(vectorResults);
		keywordResults = this.filterExpiredCandidates(keywordResults);
		trace?.endStage([
			...new Set([
				...vectorResults.map((result) => result.entry.id),
				...keywordResults.map((result) => result.entry.id),
			]),
		]);

		trace?.startStage("rrf_fusion", [
			...vectorResults.map((r) => r.entry.id),
			...keywordResults.map((r) => r.entry.id),
		]);
		// Compute the normalized fused once so later retrieval scoring checks use one value.
		let fused = this.rrfFuse(vectorResults, keywordResults);
		trace?.endStage(
			fused.map((r) => r.entry.id),
			fused.map((r) => r.score),
		);
		log.debug("precision recall search", {
			vectorCount: vectorResults.length,
			keywordCount: keywordResults.length,
			fusedCount: fused.length,
			queryExpanded: bm25Query !== context.query,
		}, { event_name: "memory.retriever_search_modes.diagnostic", file: "packages/sno-station-mem/src/engine/retrieval/retriever-search-modes.ts", function: "precisionRecall", site_id: "retrieval.retriever-search-modes.precisionRecall.aaf0b2eb17" });

		trace?.startStage(
			"rerank",
			fused.map((r) => r.entry.id),
		);
		// Await the retrieval ranking dependency before deriving downstream state.
		const rerankOutcome = await this.rerank(context.query, fused, queryVector);
		fused = rerankOutcome.candidates;
		this.throwIfAborted(context);
		// Report cross-encoder coverage on success and the reason when ranking degraded.
		const rerankStageMetadata = rerankOutcome.fallback
			? {
					...rerankOutcome.stats,
					rerankFallbackReason: rerankOutcome.fallback.reason,
					rerankFallbackProvider: rerankOutcome.fallback.provider,
				}
			: rerankOutcome.stats;
		trace?.endStage(
			fused.map((r) => r.entry.id),
			fused.map((r) => r.score),
			rerankStageMetadata,
		);

		fused = this.applyScoringPipeline(fused, trace, context.limit);
		// Two removals for two different reasons; merging their counts hides which one cut a
		// memory out of the answer.
		trace?.startStage(
			"min_score_filter",
			fused.map((result) => result.entry.id),
		);
		fused = fused.filter((result) => result.score >= this.config.minScore);
		trace?.endStage(
			fused.map((result) => result.entry.id),
			fused.map((result) => result.score),
		);
		trace?.startStage(
			"limit_slice",
			fused.map((result) => result.entry.id),
		);
		const served = fused.slice(0, context.limit);
		trace?.endStage(
			served.map((result) => result.entry.id),
			served.map((result) => result.score),
		);
		return served;
	},

	// Name is legacy (kept to avoid a wider rename); this is NOT rank-based RRF.
	// It is weighted raw-score fusion, ported from the upstream reference
	// (memory-memory-lancedb-pro `fuseResults`) after a brief detour through
	// pure-rank RRF measured 65% vs vector-only's 84% on LoCoMo.
	rrfFuse(
		this: MemoryRetrieverInternals,
		vector: MemorySearchResult[],
		keyword: MemorySearchResult[],
	): RetrievalResult[] {
		// Compute the normalized vector map once so later retrieval scoring checks use one value.
		const vectorMap = new Map<string, MemorySearchResult>();
		const keywordMap = new Map<string, MemorySearchResult>();
		// Iterate deterministically so retrieval ranking output order remains stable.
		for (const [index, result] of vector.entries()) {
			// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
			vectorMap.set(result.entry.id, { ...result, rank: index + 1 });
		}
		// Iterate deterministically so retrieval ranking output order remains stable.
		for (const [index, result] of keyword.entries()) {
			keywordMap.set(result.entry.id, { ...result, rank: index + 1 });
		}

		// Compute the normalized all ids once so later retrieval scoring checks use one value.
		const allIds = new Set([...vectorMap.keys(), ...keywordMap.keys()]);
		const fused: RetrievalResult[] = [];
		// Iterate deterministically so retrieval ranking output order remains stable.
		for (const id of allIds) {
			// Execute the prepared statement after all dynamic values have been normalized.
			const vectorHit = vectorMap.get(id);
			const keywordHit = keywordMap.get(id);
			// Compute the normalized base once so later retrieval scoring checks use one value.
			const base = vectorHit ?? keywordHit;
			// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
			if (!base) continue;

			// Vector similarity is the base signal; a BM25 hit is a confirmation
			// bonus on top of it (upstream `fuseResults`). BM25-only candidates
			// keep their full raw score (no vector branch to blend against).
			const vectorScore = vectorHit?.score ?? 0;
			const keywordScore = keywordHit?.score ?? 0;
			const weightedFusion =
				vectorScore * this.config.vectorWeight + keywordScore * this.config.bm25Weight;
			const score = vectorHit ? clamp01(weightedFusion, 0.1) : clamp01(keywordScore, 0.1);

			// Anchor rule (PRD §4): when both branches surface the same parent
			// with different best chunks, pick the branch whose `bestChunkScore`
			// is higher; ties resolve to the semantic branch. The chosen branch
			// supplies chunkId / chunkIndex / bestChunkScore on the fused result.
			const vectorBest = vectorHit?.bestChunkScore ?? -1;
			const keywordBest = keywordHit?.bestChunkScore ?? -1;
			const anchor =
				vectorHit && keywordHit
					? vectorBest >= keywordBest
						? vectorHit
						: keywordHit
					: (vectorHit ?? keywordHit);
			fused.push({
				entry: base.entry,
				score,
				sources: {
					vector: vectorHit
						? {
								score: vectorHit.score,
								rank: vectorHit.rank ?? 1,
							}
						: undefined,
					bm25: keywordHit
						? {
								score: keywordHit.score,
								rank: keywordHit.rank ?? 1,
							}
						: undefined,
					fused: { score },
				},
				chunkId: anchor?.chunkId,
				chunkIndex: anchor?.chunkIndex,
				bestChunkScore: anchor?.bestChunkScore,
				snippet: anchor?.snippet,
				denseScore: vectorHit?.score,
				bm25Score: keywordHit?.score,
				fusedScore: score,
			});
		}

		return fused.sort((a, b) => {
			const scoreDiff = b.score - a.score;
			// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
			if (scoreDiff !== 0) return scoreDiff;
			return a.entry.id.localeCompare(b.entry.id);
		});
	},
});
