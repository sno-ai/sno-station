import { SNO_OBSERVE_DEFAULT_AGENT_ID } from "../../../config/index";
/** @file sno-station-mem-auto-recall-hook.ts
 * @purpose Handles before-agent auto-recall, filtering, timeout, and context injection.
 * @boundary The before_prompt_build hook path only; capture and reset hooks live elsewhere.
 */

import type {
	PluginHookAgentContext,
	PluginHookBeforeAgentStartEvent,
	PluginHookBeforeAgentStartResult,
} from "./sno-station-mem-hook-types";
import {
	appendAuditEntry,
	type createScopePolicy,
	debugContentPreview,
	formatRelevantMemoriesContext,
	MAX_SESSION_RECALL_ENTRIES,
	MAX_TRACKED_SESSIONS,
	type MemoryRetriever,
	type MemoryStore,
	normalizeQuery,
	type SnoStationMemPluginApi,
	type PluginConfig,
	pruneOldestEntries,
	setLruEntry,
	shouldSkipRetrieval,
	touchLruEntry,
} from "./sno-station-mem-runtime-dependencies";
import {
	isChatIdBasedAgentId,
	resolveHookAgentId,
} from "./sno-station-mem-runtime-mode";
import { resolveRuntimeSessionId } from "./sno-station-mem-session-state";
import { episodicEventDate, saidOnDate, sourceQuote } from "./memory-tool-formatting";
import type { RetrievalResult } from "../shared/types";
import type { MemoryTelemetryUsageOutbox } from "../telemetry/memory-telemetry-outbox";
import type { MemoryTelemetryMetadata } from "../telemetry/memory-telemetry-types";
import { retrieveForAutoRecall, type RecallFilterDiagnostics } from "../retrieval/rem-consumer-retrieval";
import { randomUUID } from "node:crypto";
import { createLogger, currentLogContext, withLogContext } from "@snoai/utils/logger";
const log = createLogger("sno-station-mem:auto-recall");

const LOCOMO_BENCHMARK_PROMPT_RE =
	/^Question:\s*(?<question>[\s\S]*?)\n\s*\nYou are answering a benchmark question\b/;

export function extractAutoRecallQuery(prompt: string): string {
	const benchmarkQuestion = LOCOMO_BENCHMARK_PROMPT_RE.exec(prompt)?.groups?.question?.trim();
	return benchmarkQuestion && benchmarkQuestion.length > 0 ? benchmarkQuestion : prompt;
}

/** Injects relevant memories into the next agent turn after scope and cache checks. */
export async function onBeforeAgentStart(
	api: SnoStationMemPluginApi,
	config: PluginConfig,
	retriever: MemoryRetriever,
	_store: MemoryStore,
	scopePolicy: ReturnType<typeof createScopePolicy>,
	recallHistory: Map<string, Map<string, number>>,
	turnCounter: Map<string, number>,
	event: PluginHookBeforeAgentStartEvent,
	ctx: PluginHookAgentContext,
	stateDir: string,
	telemetryUsage?: MemoryTelemetryUsageOutbox,
	signal?: AbortSignal,
): Promise<PluginHookBeforeAgentStartResult | undefined> {
	const sessionId = resolveRuntimeSessionId(ctx);
	const currentTurn = (touchLruEntry(turnCounter, sessionId) ?? 0) + 1;
	setLruEntry(turnCounter, sessionId, currentTurn, MAX_TRACKED_SESSIONS);
	const sessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : "";
	return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID(), session_reference: sessionKey }, async () => {
	const started = performance.now();
	let outcome = "skipped";
	let served: string[] = [];
	let repeatRemoved = 0;
	const retrievalDiagnostics: RecallFilterDiagnostics = {};
	try {
	if (sessionKey.includes(":subagent:")) {
		appendAuditEntry(stateDir, {
			event: "auto_recall",
			hook: "before_prompt_build",
			resultStatus: "skipped",
			decision: "skipped_subagent",
			details: { sessionKey },
		});
		return;
	}
	if (!config.autoRecall) return;
	const resolvedAgentId = resolveHookAgentId(ctx.agentId, sessionKey).agentId ?? SNO_OBSERVE_DEFAULT_AGENT_ID;
	if (isChatIdBasedAgentId(resolvedAgentId)) {
		appendAuditEntry(stateDir, {
			event: "auto_recall",
			hook: "before_prompt_build",
			resultStatus: "skipped",
			decision: "rejected_chatid_agent_format",
			details: { resolvedAgentId },
		});
		return;
	}
	// A non-empty whitelist overrides the blocklist.
	if (config.autoRecallIncludeAgents.length > 0) {
		if (!config.autoRecallIncludeAgents.includes(resolvedAgentId)) {
			appendAuditEntry(stateDir, {
				event: "auto_recall",
				hook: "before_prompt_build",
				resultStatus: "skipped",
				decision: "skipped_agent_filter",
				details: { resolvedAgentId, listKind: "include" },
			});
			return;
		}
	} else if (config.autoRecallExcludeAgents.includes(resolvedAgentId)) {
		appendAuditEntry(stateDir, {
			event: "auto_recall",
			hook: "before_prompt_build",
			resultStatus: "skipped",
			decision: "skipped_agent_filter",
			details: { resolvedAgentId, listKind: "exclude" },
		});
		return;
	}
	const incoming = event.prompt;
	const recallInput = incoming ? extractAutoRecallQuery(incoming) : "";
	const normalizedIncoming = recallInput ? normalizeQuery(recallInput) : "";
	// Guard this branch early so the remaining module behavior path works with normalized inputs.
	if (!normalizedIncoming || shouldSkipRetrieval(normalizedIncoming, config.autoRecallMinLength)) {
		return;
	}

	const maxQueryLen = config.autoRecallMaxQueryLength;
	let recallQuery = normalizedIncoming;
	// Guard recall query.length here so the remaining module behavior path works with normalized inputs.
	if (recallQuery.length > maxQueryLen) {
		log.info("Auto recall query length limited", { input_length: recallQuery.length, limit: maxQueryLen },
			{ event_name: "memory.auto_recall.query.limited", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-auto-recall-hook.ts", function: "onBeforeAgentStart", site_id: "memory.auto_recall.query.limited" });
		recallQuery = recallQuery.slice(0, maxQueryLen);
	}

	// Compute the normalized scope filter once so later module behavior checks use one value.
	const scopeFilter = scopePolicy.resolveAgentScopes(resolvedAgentId);
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	// Isolate the plugin lifecycle operation that can fail because of runtime I/O or input shape.
	try {
		const timeoutMs = config.autoRecallTimeoutMs;
		const recallController = new AbortController();
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				const timeoutError = new Error("auto-recall timeout");
				recallController.abort(timeoutError);
				reject(timeoutError);
			}, timeoutMs);
			timeoutHandle.unref();
		});
		const recallLimit = config.retrieval.recallTopK;
		// Phase 0 §7.6: stale-recall suppression filter. Stamping `now` here keeps
		// the cutoff deterministic across the parallel vector + keyword branches
		// and makes the audit decision auditable from the same timestamp. The same
		// stamp drives tombstone exclusion (W1.3): superseded facts are dropped on
		// every recall path, unconditionally.
		const suppressionNow = Date.now();
		const results = await Promise.race([
			retrieveForAutoRecall(retriever, {
				diagnostics: retrievalDiagnostics,
				query: recallQuery,
				limit: recallLimit,
				scopeFilter,
				signal: signal ? AbortSignal.any([signal, recallController.signal]) : recallController.signal,
				sessionId,
				nowMs: suppressionNow,
			}),
			timeoutPromise,
		]);
		signal?.throwIfAborted();
		// Treat the empty collection as a first-class outcome instead of widening behavior.
		if (results.length === 0) {
			outcome = "empty_success";
			// Persist the decision breadcrumb so later debugging can reconstruct this path.
			appendAuditEntry(stateDir, {
				event: "auto_recall",
				hook: "before_prompt_build",
				resultStatus: "ok",
				decision: "executed_empty",
				details: {
					resolvedAgentId,
					queryChars: recallQuery.length,
					queryPreview: debugContentPreview(recallQuery),
					limit: recallLimit,
				},
			});
			return;
		}

		const minRepeated = config.autoRecallMinRepeated ?? 0;
		let finalResults = results;
		const sessionHistory = touchLruEntry(recallHistory, sessionId) ?? new Map<string, number>();

		// Guard min repeated here so the remaining module behavior path works with normalized inputs.
		if (minRepeated > 0) {
			const filtered = results.filter((r) => {
				const lastTurn = sessionHistory.get(r.entry.id) ?? -999;
				return currentTurn - lastTurn >= minRepeated;
			});
			repeatRemoved = results.length - filtered.length;

			// Treat the empty collection as a first-class outcome instead of widening behavior.
			if (filtered.length === 0) {
				outcome = "empty_success";
				// Persist the decision breadcrumb so later debugging can reconstruct this path.
				appendAuditEntry(stateDir, {
					event: "auto_recall",
					hook: "before_prompt_build",
					resultStatus: "ok",
					decision: "executed_filtered_empty",
					details: {
						resolvedAgentId,
						queryChars: recallQuery.length,
						queryPreview: debugContentPreview(recallQuery),
						retrievedCount: results.length,
						minRepeated,
						limit: recallLimit,
					},
				});
				return;
			}

			finalResults = filtered;
		}

		// Iterate deterministically so plugin lifecycle output order remains stable.
		for (const r of finalResults) {
			sessionHistory.set(r.entry.id, currentTurn);
		}
		pruneOldestEntries(sessionHistory, MAX_SESSION_RECALL_ENTRIES);
		setLruEntry(recallHistory, sessionId, sessionHistory, MAX_TRACKED_SESSIONS);

		// Persist the decision breadcrumb so later debugging can reconstruct this path.
		appendAuditEntry(stateDir, {
			event: "auto_recall",
			hook: "before_prompt_build",
			resultStatus: "ok",
			decision: "executed",
			details: {
				resolvedAgentId,
				queryChars: recallQuery.length,
				queryPreview: debugContentPreview(recallQuery),
				injectedCount: finalResults.length,
				limit: recallLimit,
				topResultIds: finalResults.slice(0, 5).map((r) => r.entry.id),
				topScores: finalResults.slice(0, 5).map((r) => Number(r.score.toFixed(4))),
				topResultPreviews:
					process.env.SNO_STATION_MEM_DEBUG_CONTENT === "1"
						? finalResults
								.slice(0, 5)
								.map((r) =>
									debugContentPreview(r.snippet && r.snippet.length > 0 ? r.snippet : r.entry.text),
								)
						: undefined,
			},
		});

		recordAutoRecallUsage({
			api,
			telemetryUsage,
			results: finalResults,
			resolvedAgentId,
			sessionId,
			currentTurn,
		});
		served = finalResults.map((row) => row.entry.id);
		outcome = "success";

		return {
			prependContext: formatRelevantMemoriesContext(
				finalResults.map((result) => {
					// Keep the source anchor even when an event date has already been resolved.
					const eventDate = episodicEventDate(result.entry);
					// The original sentence travels with the paraphrase, so a question about exact
					// wording has something to read. See `sourceQuote`.
					const quote = sourceQuote(result.entry);
					return {
						category: result.entry.category,
						text: result.snippet && result.snippet.length > 0 ? result.snippet : result.entry.text,
						lane: result.entry.lane,
						...(quote === undefined ? {} : { quote }),
						eventDate,
						saidOn: saidOnDate(result.entry),
					};
				}),
			),
		};
	} catch (error) {
		// Expected recall timeouts are informational; unexpected failures remain
		// warnings because they may indicate embedder or store issues.
		const msg = error instanceof Error ? error.message : String(error);
		// Guard msg here so the remaining module behavior path works with normalized inputs.
		if (msg === "auto-recall timeout") {
			outcome = "cancelled";
		} else {
			outcome = "failed";
			log.warn("Auto recall failed", { error }, { event_name: "memory.auto_recall.failed", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-auto-recall-hook.ts", function: "onBeforeAgentStart", site_id: "memory.auto_recall.failed" });
		}
	} finally {
		// Guard guard condition here so the remaining module behavior path works with normalized inputs.
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
	} finally {
		log.info("Auto recall completed", { outcome, duration_ms: performance.now() - started,
			served_ids: served.slice(0, 128), served_count: served.length, ids_truncated: served.length > 128,
			repeat_removed_count: repeatRemoved, token_budget_removed_count: 0,
			retired_closed_removed_count: retrievalDiagnostics.retired_closed_removed_count ?? "unavailable",
			sql_excluded_count: "unavailable", sql_excluded_reason: "query_does_not_report_excluded_rows",
		}, { event_name: "memory.auto_recall.completed", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-auto-recall-hook.ts", function: "onBeforeAgentStart", site_id: "memory.auto_recall.completed" });
	}
	});
}

function recordAutoRecallUsage(params: {
	api: SnoStationMemPluginApi;
	telemetryUsage: MemoryTelemetryUsageOutbox | undefined;
	results: RetrievalResult[];
	resolvedAgentId: string;
	sessionId: string;
	currentTurn: number;
}): void {
	if (!params.telemetryUsage) return;
	for (const [index, result] of params.results.entries()) {
		const factId = result.entry.factId;
		if (!factId) {
			log.warn("Recall telemetry lacks fact identity", { memory_id: result.entry.id },
				{ event_name: "memory.auto_recall.telemetry.skipped", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-auto-recall-hook.ts", function: "recordAutoRecallUsage", site_id: "memory.auto_recall.telemetry.skipped" });
			continue;
		}
		const retrievalRank = index + 1;
		const retrievalScore = finiteNumberOrUndefined(result.score);
		const base = {
			factId,
			memoryKind: result.entry.category,
			projectId: result.entry.projectId,
			agentId: params.resolvedAgentId,
			sessionUuid: params.sessionId,
			turnId: String(params.currentTurn),
			retrievalRank,
			retrievalScore,
		};
		const recallAccepted = params.telemetryUsage.tryAcceptUsage({
			eventType: "recall",
			...base,
			metadata: buildRecallUsageMetadata(result, retrievalRank, retrievalScore),
		});
		const injectAccepted = params.telemetryUsage.tryAcceptUsage({
			eventType: "inject",
			...base,
			metadata: {
				injection_surface: "auto_recall_prepend_context",
				retrieval_rank: retrievalRank,
				...(retrievalScore !== undefined && { retrieval_score: retrievalScore }),
			},
		});
		if (!recallAccepted || !injectAccepted) {
			log.warn("Recall telemetry admission failed", { fact_id: factId, recall_accepted: recallAccepted, inject_accepted: injectAccepted },
				{ event_name: "memory.auto_recall.telemetry.failed", file: "packages/sno-station-mem/src/engine/bindings/sno-station-mem-auto-recall-hook.ts", function: "recordAutoRecallUsage", site_id: "memory.auto_recall.telemetry.failed" });
		}
	}
}

function buildRecallUsageMetadata(
	result: RetrievalResult,
	retrievalRank: number,
	retrievalScore: number | undefined,
): MemoryTelemetryMetadata {
	const metadata: MemoryTelemetryMetadata = {
		retrieval_rank: retrievalRank,
		...(retrievalScore !== undefined && { retrieval_score: retrievalScore }),
	};
	addFiniteScore(metadata, "dense_score", result.denseScore);
	addFiniteScore(metadata, "bm25_score", result.bm25Score);
	addFiniteScore(metadata, "fused_score", result.fusedScore);
	addFiniteScore(metadata, "rerank_score", result.rerankScore);
	addFiniteScore(metadata, "mmr_score", result.mmrScore);
	return metadata;
}

function addFiniteScore(
	metadata: MemoryTelemetryMetadata,
	key: string,
	value: number | undefined,
): void {
	const score = finiteNumberOrUndefined(value);
	if (score !== undefined) metadata[key] = score;
}

function finiteNumberOrUndefined(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
