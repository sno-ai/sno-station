import { memoryOperationSignal } from "../operation-cancellation";
/** @file retriever-execution.ts
 * @purpose Runs retrieval entrypoints, traces, and stats recording.
 * @boundary Prototype-mounted MemoryRetriever methods; no constructor state ownership.
 */

import { parseInsightMetadata } from "../extraction/memory-metadata-codec";
import { randomUUID } from "node:crypto";
import { currentLogContext, privateLogReference, withLogContext } from "@snoai/utils/logger";
import { createRetentionScorer } from "../operations/selective-forgetting-scorer";
import { parseAccessMetadata } from "./access-tracker";
import {
	type RetrievalContext,
	withServingValidityDefault,
} from "./retrieval-config";
import { collectParallelStage, log } from "./retrieval-scoring-utils";
import { MemoryRetriever, type MemoryRetrieverInternals } from "./retriever-core";
import type { RetrievalResult, RetrievalTrace } from "./retriever-dependencies";
import {
	appendQaTrace,
	CHUNKING_VERSION,
	computeConfigHash,
	isTraceEnabled,
	RetrievalError,
	TraceCollector,
} from "./retriever-dependencies";
import { DEFAULT_MEMORY_TIER, type DecayableMemory, type MemoryTier } from "../shared/types";

Object.assign(MemoryRetriever.prototype, {
	async retrieve(
		this: MemoryRetrieverInternals,
		input: RetrievalContext,
	): Promise<RetrievalResult[]> {
		return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID(),
			...(input.external_reference !== undefined ? { external_reference: input.external_reference,
				external_reference_visibility: input.external_reference_visibility } : {}) }, async () => {
		const started = performance.now();
		// PRD 205 REQ-1: a serving recall that passes no validity parameter is
		// filtered exactly as one that passes the current time.
		const context = withServingValidityDefault({ ...input, signal: memoryOperationSignal(input.signal) });
		log.info("retrieval started", {
			queryLength: context.query.length,
			limit: context.limit,
			mode: this.config.mode,
			source: context.source,
		}, { event_name: "memory.retrieval.started", file: "packages/sno-station-mem/src/engine/retrieval/retriever-execution.ts", function: "retrieve", site_id: "memory.retrieval.started" });
		const traceStartMs = Date.now();
		// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
		try {
			this.throwIfAborted(context);
			// The eval harness needs the stage record too, and it does not install a stats
			// collector — without this the whole per-stage trace was silently absent from every
			// eval run, which is exactly the gap this record exists to close.
			const trace = new TraceCollector();
			const isExplicitAggregation =
				(context.allowAggregation === true || context.source === undefined) &&
				context.aggregation !== undefined;

			let results: RetrievalResult[];
			// Auto-recall injects context before every turn and must honor its configured result limit.
			if (isExplicitAggregation) {
				results = await this.aggregationComplete(context, trace);
			} else if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
				// Await the retrieval ranking dependency before deriving downstream state.
				results = await this.vectorOnly(context, trace);
			} else {
				// Await the retrieval ranking dependency before deriving downstream state.
				results = await this.precisionRecall(context, trace);
			}
			const beforeFinalFilter = results.length;
			results = results.filter((result) => this.store.isMemoryOnFactSurface(result.entry.id));
			this.throwIfAborted(context);

			if (
				!isExplicitAggregation &&
				this._accessTracker &&
				(this._recallLifecycle?.autoRecallAccessTracking === true ||
					context.source === "manual") &&
				results.length > 0
			) {
				// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
				this._accessTracker.recordAccess(results.map((r) => r.entry.id));
			}

			// Phase 0 §5 tier-promoter wire site. Gated independently from the
			// access-tracker block so the flag matrix
			// {tierPromoter=true, autoRecallAccessTracking=false} still evaluates.
			if (
				!isExplicitAggregation &&
				this._recallLifecycle?.tierPromoter &&
				this._tierPromoter &&
				results.length > 0
			) {
				await this.evaluateTopKTierTransitions(results);
			}

			// Finalized once, with the real mode, and read by both consumers below: the stats
			// collector and the eval trace row. Finalizing twice with two different modes would
			// put a mode into the record that the run never used.
			const mode = isExplicitAggregation
				? "aggregation"
				: this.config.mode === "vector" || !this.store.hasFtsSupport
					? "vector"
					: "precision-recall";
			const finalTrace = trace?.finalize(context.query, mode);
			if (finalTrace && this._statsCollector) {
				this._statsCollector.recordQuery(finalTrace, context.source ?? "unknown");
			}

			// Eval-trace emission (PRD §11.2.2). OPT-IN — skipped unless the eval
			// harness flips EVAL_TRACE_ENABLED=true and points EVAL_TRACE_DIR at
			// the run dir. Now (PRD §M1) carries chunk ids + per-stage score
			// arrays parallel to retrievedChunkIds. Stages that are partially
			// populated emit no array; missing-result chunk ids land in
			// traceMetadata.omittedScoreArrays so debugging is not silent.
			if (isTraceEnabled()) {
				if (this._cachedConfigHash === undefined) {
					this._cachedConfigHash = computeConfigHash();
				}
				const fallbackIds = results.map(
					(r, i) => r.chunkId ?? `__no_chunk_id__:${r.entry.id}#${i}`,
				);
				const dense = collectParallelStage(results, "denseScore", fallbackIds);
				const bm25 = collectParallelStage(results, "bm25Score", fallbackIds);
				const fused = collectParallelStage(results, "fusedScore", fallbackIds);
				const rerank = collectParallelStage(results, "rerankScore", fallbackIds);
				const mmr = collectParallelStage(results, "mmrScore", fallbackIds);
				const omitted: Record<string, string[]> = {};
				if (dense.omitted.length > 0) omitted.denseScores = dense.omitted;
				if (bm25.omitted.length > 0) omitted.bm25Scores = bm25.omitted;
				if (fused.omitted.length > 0) omitted.fusedScores = fused.omitted;
				if (rerank.omitted.length > 0) omitted.rerankScores = rerank.omitted;
				if (mmr.omitted.length > 0) omitted.mmrScores = mmr.omitted;
				const traceMetadata =
					Object.keys(omitted).length > 0 ? { omittedScoreArrays: omitted } : undefined;
				const stageRecord = finalTrace?.stages.map(
					(stage) => ({
						name: stage.name,
						inputCount: stage.inputCount,
						outputCount: stage.outputCount,
						droppedIds: stage.droppedIds,
						outputIds: stage.outputIds,
						scoreRange: stage.scoreRange,
						durationMs: stage.durationMs,
						...(typeof stage.metadata?.skipped === "string" && {
							skipped: stage.metadata.skipped,
						}),
					}),
				);
				appendQaTrace({
					query: context.query,
					...(stageRecord && stageRecord.length > 0 && { stages: stageRecord }),
					retrievedChunkIds: results.map((r) => r.chunkId ?? ""),
					retrievedParentMemoryIds: results.map((r) => r.entry.id),
					...(dense.values && { denseScores: dense.values }),
					...(bm25.values && { bm25Scores: bm25.values }),
					...(fused.values && { fusedScores: fused.values }),
					...(rerank.values && { rerankScores: rerank.values }),
					...(mmr.values && { mmrScores: mmr.values }),
					finalMemoryScores: results.map((r) => r.score),
					embedderProvider: this.embedder.providerKind,
					embedderModel: this.embedder.model,
					embedderDim: this.embedder.dimensions,
					chunkingVersion: CHUNKING_VERSION,
					configHash: this._cachedConfigHash,
					timestampMs: traceStartMs,
					latencyMs: performance.now() - started,
					...(traceMetadata && { traceMetadata }),
				});
			}

			// Centralize the retrieval scoring fallback value at the boundary of this helper.
			log.info("Memory retrieval completed", {
				store_reference: privateLogReference(this.store.dbPath),
				outcome: results.length ? "success" : "empty_success", duration_ms: performance.now() - started,
				mode, scope_count: context.scopeFilter?.length ?? "unavailable", result_count: results.length,
				final_filter_removed_count: beforeFinalFilter - results.length,
				config_hash: this._cachedConfigHash ?? computeConfigHash(), fts_available: this.store.hasFtsSupport,
				stages: finalTrace?.stages.map(({ name, inputCount, outputCount, scoreRange, durationMs, metadata }) =>
					({ name, inputCount, outputCount, scoreRange, durationMs, metadata })),
				trace_available: isTraceEnabled(),
			}, { event_name: "memory.retrieval.completed", file: "packages/sno-station-mem/src/engine/retrieval/retriever-execution.ts", function: "retrieve", site_id: "memory.retrieval.completed" });
			return results;
		} catch (error) {
			log.error("Memory retrieval failed", { outcome: "failed", error, duration_ms: performance.now() - started },
				{ event_name: "memory.retrieval.completed", file: "packages/sno-station-mem/src/engine/retrieval/retriever-execution.ts", function: "retrieve", site_id: "memory.retrieval.failed" });
			// Surface this invalid retrieval ranking state as an explicit typed failure.
			throw new RetrievalError("Failed to retrieve memories", error);
		}
		});
	},

	async retrieveWithTrace(
		this: MemoryRetrieverInternals,
		input: RetrievalContext,
	): Promise<{ results: RetrievalResult[]; trace: RetrievalTrace }> {
		return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID(),
			...(input.external_reference !== undefined ? { external_reference: input.external_reference,
				external_reference_visibility: input.external_reference_visibility } : {}) }, async () => {
		const started = performance.now();
		// Same default as `retrieve()` above: both entrypoints are serving paths,
		// so neither can be reached with the filter silently absent (PRD 205).
		const context = withServingValidityDefault({ ...input, signal: memoryOperationSignal(input.signal) });
		// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
		try {
			this.throwIfAborted(context);
			const trace = new TraceCollector();
			const isExplicitAggregation =
				(context.allowAggregation === true || context.source === undefined) &&
				context.aggregation !== undefined;

			let results: RetrievalResult[];
			if (isExplicitAggregation) {
				results = await this.aggregationComplete(context, trace);
			} else if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
				// Await the retrieval ranking dependency before deriving downstream state.
				results = await this.vectorOnly(context, trace);
			} else {
				// Await the retrieval ranking dependency before deriving downstream state.
				results = await this.precisionRecall(context, trace);
			}
			results = results.filter((result) => this.store.isMemoryOnFactSurface(result.entry.id));
			this.throwIfAborted(context);
			const mode = isExplicitAggregation
				? "aggregation"
				: this.config.mode === "vector" || !this.store.hasFtsSupport
					? "vector"
					: "precision-recall";
			const finalTrace = trace.finalize(context.query, mode);

			if (
				!isExplicitAggregation &&
				this._accessTracker &&
				(this._recallLifecycle?.autoRecallAccessTracking === true ||
					context.source === "manual") &&
				results.length > 0
			) {
				// Isolate the retrieval ranking operation that can fail because of runtime I/O or input shape.
				this._accessTracker.recordAccess(results.map((r) => r.entry.id));
			}

			// Phase 0 §5 tier-promoter wire site (precision-recall path; mirrors
			// the `retrieve()` wire site so both retrieval entrypoints honor the
			// flag identically).
			if (
				!isExplicitAggregation &&
				this._recallLifecycle?.tierPromoter &&
				this._tierPromoter &&
				results.length > 0
			) {
				await this.evaluateTopKTierTransitions(results);
			}

			// Guard guard condition here so the remaining retrieval scoring path works with normalized inputs.
			if (this._statsCollector) {
				this._statsCollector.recordQuery(finalTrace, context.source ?? "debug");
			}

			// Return the normalized retrieval ranking payload expected by callers.
			log.info("Traced memory retrieval completed", { outcome: results.length ? "success" : "empty_success",
				store_reference: privateLogReference(this.store.dbPath),
				duration_ms: performance.now() - started, mode, result_count: results.length,
				stages: finalTrace.stages.map(({ name, inputCount, outputCount, scoreRange, durationMs, metadata }) =>
					({ name, inputCount, outputCount, scoreRange, durationMs, metadata })),
			}, { event_name: "memory.retrieval.completed", file: "packages/sno-station-mem/src/engine/retrieval/retriever-execution.ts", function: "retrieveWithTrace", site_id: "memory.retrieval.traced.completed" });
			return { results, trace: finalTrace };
		} catch (error) {
			log.error("Traced memory retrieval failed", { outcome: "failed", error, duration_ms: performance.now() - started },
				{ event_name: "memory.retrieval.completed", file: "packages/sno-station-mem/src/engine/retrieval/retriever-execution.ts", function: "retrieveWithTrace", site_id: "memory.retrieval.traced.failed" });
			// Surface this invalid retrieval ranking state as an explicit typed failure.
			throw new RetrievalError("Failed to retrieve memories", error);
		}
		});
	},

	/**
	 * Phase 0 §5: evaluate tier promotion/demotion for the top-K retrieved
	 * memories and persist any non-null transition via `store.updateTier`.
	 *
	 * Per-item try/catch isolates evaluator and persistence failures so one
	 * bad memory cannot block the rest. The retention scorer is instantiated
	 * lazily on the retriever instance — synthesizing `DecayableMemory` from
	 * `entry.metadata` keeps this hot-path read-only against the store.
	 *
	 * Callers gate on `recallLifecycle.tierPromoter`; this method assumes the
	 * flag is on and `_tierPromoter` is set.
	 */
	async evaluateTopKTierTransitions(
		this: MemoryRetrieverInternals,
		results: RetrievalResult[],
	): Promise<void> {
		const promoter = this._tierPromoter;
		if (!promoter) return;
		const topK = this._recallLifecycle?.tierPromotionTopK ?? results.length;
		if (!this._retentionScorer) {
			this._retentionScorer = createRetentionScorer();
		}
		const scorer = this._retentionScorer;
		const now = Date.now();
		const slice = results.slice(0, Math.max(0, topK));
		for (const r of slice) {
			// Per-item isolation. Any evaluator, scorer, or persistence throw is
			// logged and skipped so sibling memories are still evaluated.
			try {
				const entry = r.entry;
				const access = parseAccessMetadata(entry.metadata);
				const insight = parseInsightMetadata(entry.metadata, entry);
				const tier: MemoryTier = (insight.tier as MemoryTier | undefined) ?? DEFAULT_MEMORY_TIER;
				const confidence = insight.confidence ?? 0.7;
				const decayable: DecayableMemory = {
					id: entry.id,
					importance: entry.importance,
					confidence,
					tier,
					accessCount: access.accessCount,
					createdAt: entry.timestamp,
					lastAccessedAt: access.lastAccessedAt || entry.timestamp,
					metadata: entry.metadata,
					...(insight.memory_temporal_type && {
						temporalType: insight.memory_temporal_type,
					}),
				};
				const score = scorer.score(decayable, now);
				const tierableMemory = {
					id: entry.id,
					tier,
					importance: entry.importance,
					accessCount: access.accessCount,
					timestamp: entry.timestamp,
				};
				const transition = promoter.evaluate(tierableMemory, score, now);
				if (!transition || transition.toTier === tier) continue;
				await this.store.updateTier(entry.id, transition.toTier, {
					writerAuthority: "offline-family",
				});
			} catch (error) {
				log.warn("tier evaluation failed for memory", {
					memoryId: r.entry.id,
					error,
				}, { event_name: "memory.retrieval.tier.failed", file: "packages/sno-station-mem/src/engine/retrieval/retriever-execution.ts", function: "evaluateTopKTierTransitions", site_id: "memory.retrieval.tier.failed" });
			}
		}
	},
});
