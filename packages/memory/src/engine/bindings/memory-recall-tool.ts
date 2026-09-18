import {
	assertAccessibleScopeForTool,
	resolveAgentAccess,
	resolveReadableScopesForTool,
} from "./memory-tool-access";
import type { TodoListResult } from "./memory-tool-dependencies";
import { clamp01, clampInt, countTokens, DEFAULT_MIN_SCORE, DEFAULT_SCOPE, formatAtDepth, DEFAULT_MAX_CONTEXT_TOKENS, MAX_RECALL_TOOL_CANDIDATES, MAX_AGGREGATION_RESULT_TOKENS, MAX_RECALLED_TODOS, MAX_RECALLED_TODO_TOKENS, normalizeCategory, truncateGraphemes } from "./memory-tool-dependencies";
import {
	episodicEventDate,
	safeParseMetadata,
	sanitizeRecalledText,
	serializeMemory,
} from "./memory-tool-formatting";
import {
	makeResult,
	runWithAudit,
} from "./memory-tool-results";
import { recallParamsSchema, type ToolContext, type ToolResult } from "./memory-tool-schemas";
import {
	packManualRecallRows,
	type RecallFilterDiagnostics,
	retrieveForMemoryRecallOrEval,
} from "../retrieval/rem-consumer-retrieval";
import { createLogger, currentLogContext, privateLogReference, withLogContext } from "@snoai/utils/logger";
import { randomUUID } from "node:crypto";

const log = createLogger("sno-station-mem:memory-recall-tool");



function appendStructuredRecallContent(result: ToolResult): ToolResult {
	const count = result.details["count"];
	const memories = result.details["memories"];
	const memoryCount = typeof count === "number" ? count : 0;
	const memoryRows = Array.isArray(memories) ? memories : [];
	// SnoStationMem reads only array length, so keep one entry per reported row even without an id.
	const memoryReferences = Array.from({ length: memoryCount }, (_, index) => {
		const memory = memoryRows[index];
		if (
			typeof memory === "object" &&
			memory !== null &&
			"id" in memory &&
			typeof memory.id === "string" &&
			memory.id.trim().length > 0
		) {
			return memory.id;
		}
		return `unknown-memory-${index + 1}`;
	});
	return {
		...result,
		content: [
			...result.content,
			{
				type: "text",
				text: JSON.stringify({
					status: count === 0 ? "no_results" : "ok",
					count,
					memories: memoryReferences,
				}),
			},
		],
	};
}

function makeRecallResult(text: string, details: Record<string, unknown>): ToolResult {
	return appendStructuredRecallContent(makeResult(text, details));
}

function prependTodoBlock(result: ToolResult, todos: TodoListResult): ToolResult {
	if (todos.items.length === 0) return result;
	const lines: string[] = [];
	for (const todo of todos.items) {
		const description = sanitizeRecalledText(todo.description);
		const closedAt = todo.closedAt === null ? "unknown" : new Date(todo.closedAt).toISOString();
		const closeReason = sanitizeRecalledText(todo.closeReason ?? "unknown");
		const line = todo.status === "open"
			? `- [open] ${description}`
			: `- [${todo.status}] ${description} | closed_at=${closedAt} | close_reason=${closeReason}`;
		// Reserve the omission notice before accepting a complete to-do line.
		const candidate = `To-dos:\n${[...lines, line].join("\n")}\n... showing ${lines.length + 1} of ${todos.totalCount} to-dos.`;
		if (countTokens(candidate) > MAX_RECALLED_TODO_TOKENS) break;
		lines.push(line);
	}
	if (todos.totalCount > lines.length) {
		lines.push(`... showing ${lines.length} of ${todos.totalCount} to-dos.`);
	}
	const text = `To-dos:\n${lines.join("\n")}`;
	return {
		...result,
		content: [{ type: "text", text }, ...result.content],
	};
}





export async function executeMemoryRecallTool(ctx: ToolContext, access: ReturnType<typeof resolveAgentAccess>, _toolCallId: unknown, params: unknown, options: { name: string; label: string; description: string; signal?: AbortSignal }): Promise<ToolResult> {
			const raw = typeof params === "object" && params !== null ? params as Record<string, unknown> : {};
			return withLogContext({ operation_id: currentLogContext().operation_id ?? randomUUID(),
				session_reference: ctx.sessionKey,
				...(typeof raw.external_reference === "string" ? { external_reference: raw.external_reference,
					external_reference_visibility: raw.external_reference_visibility === "public" ? "public" : "private" } : {}) }, async () => {
			const started = performance.now();
			let budgetRemoved = 0;
			const retrievalDiagnostics: RecallFilterDiagnostics = {};
			let outcome = "failed";
			let errorCode: unknown;
			let served: string[] = [];
			try {
			// Centralize the tool execution fallback value at the boundary of this helper.
			const output = await runWithAudit(ctx, options.name, undefined, async () => {
				const parsed = recallParamsSchema.parse(params);
				packManualRecallRows([], parsed.token_budget);
				// An explicit aggregation reports the exact population size while bounding the evidence
				// rows rendered into one tool result.
				const readsWholePopulation = parsed.aggregation !== undefined;
				const outputScope = readsWholePopulation
					? truncateGraphemes(parsed.scope ?? DEFAULT_SCOPE, 256)
					: parsed.scope ?? DEFAULT_SCOPE;
				// Candidate retrieval keeps its scoring safety bound. The caller's legacy row count no
				// longer cuts the served set; the token packer below is the final serving boundary.
				const effectiveTopK = MAX_RECALL_TOOL_CANDIDATES;
				const minScore = clamp01(parsed.min_score ?? DEFAULT_MIN_SCORE, DEFAULT_MIN_SCORE);
				// Compute the normalized scope filter once so later tool execution checks use one value.
				const scopeFilter = parsed.scope
					? [assertAccessibleScopeForTool(ctx.scopePolicy, parsed.scope, access)]
					: resolveReadableScopesForTool(ctx.scopePolicy, access);
				// Treat the empty collection as a first-class outcome instead of widening behavior.
				if (scopeFilter.length === 0) {
					// Centralize the tool execution fallback value at the boundary of this helper.
					return makeRecallResult("No relevant memories found.", {
						count: 0,
						memories: [],
						scope: outputScope,
					});
				}
				const todos = ctx.store.listTodos({
					projectIdFilter: scopeFilter,
					includeHistory: parsed.include_history ?? false,
					limit: MAX_RECALLED_TODOS,
				});
				const withTodoBlock = (result: ToolResult): ToolResult =>
					prependTodoBlock(result, todos);

				const category = parsed.category
					? normalizeCategory(parsed.category)
					: undefined;

				// Await the tool execution dependency before deriving downstream state.
				const retrieved = await retrieveForMemoryRecallOrEval(ctx.retriever, {
					diagnostics: retrievalDiagnostics,
					signal: options.signal,
					query: parsed.query,
					limit: effectiveTopK,
					scopeFilter,
					category,
					includeRefused: parsed.include_refused ?? true,
					aggregation: parsed.aggregation,
					// No facet policy by default. `current-only` excludes history chunks in SQL, so a
					// row REM retired whole — every chunk demoted to `history` — matches nothing and
					// vanishes from the answer. The owner ruled a retired row stays in the result
					// and says so on its text (2026-08-26); hiding it was rejected. Which generation
					// of a row's own text is served is decided per row in `attachSnippets`, not by
					// removing rows here.
					...(parsed.include_history ? { facetPolicy: "include-history" as const } : {}),
					nowMs: Date.now(),
					...(ctx.language ? { explicitLocale: ctx.language } : {}),
				});
				const aggregationIncomplete =
					readsWholePopulation && retrieved.some((result) => result.aggregationIncomplete === true);
				// A structured aggregation reads the whole population; filtering it by score would
				// report a real population as a complete zero.
				const filtered = parsed.aggregation
					? retrieved
					: retrieved.filter((result) => result.score >= minScore);
				// Treat the empty collection as a first-class outcome instead of widening behavior.
				if (filtered.length === 0 && (readsWholePopulation || !ctx.recallSession)) {
					if (parsed.aggregation) {
						const scopeRowCount = aggregationIncomplete ? "unknown" : "0";
						return withTodoBlock(makeRecallResult(
							`<relevant-memories>\n<recall-result scope-row-count="${scopeRowCount}" returned-count="0" population-complete="${!aggregationIncomplete}" truncated="${aggregationIncomplete}" />\nFound 0 memories.\n</relevant-memories>`,
							{
								count: 0,
								memories: [],
								scope: outputScope,
								...(!aggregationIncomplete && { scopeRowCount: 0 }),
								populationComplete: !aggregationIncomplete,
								truncated: aggregationIncomplete,
							},
						));
					}
					return withTodoBlock(makeRecallResult("No relevant memories found.", {
						count: 0,
						memories: [],
						scope: outputScope,
					}));
				}

				// No wording-derived re-ranking. Until 2026-08-21 a matched intent multiplied its
				// categories' scores by 1.15 and a miss shortened every memory to its first sentence.
				const boosted = filtered;
				const observedScopeRowCount = readsWholePopulation && !aggregationIncomplete
					? boosted[0]?.scopeRowCount
					: undefined;
				const completeReduction =
					parsed.aggregation !== undefined && parsed.aggregation.operation !== "evidence";
				// A structured count/first/last reduces to one row by construction. Everything else keeps
				// the WHOLE population, and the token budget below is the only thing allowed to cut it:
				// two independent ceilings is how 8 rows of a 138-row population reached a counting
				// question and scored 0.000 across 28 of 30 questions (measured 2026-08-13).
				const limitedResults = readsWholePopulation
					? completeReduction
						? boosted.slice(0, 1)
						: boosted
					: boosted;
				// An explicitly requested row count is still a request, not the default cut REQ-1
				// removes: the caller asked for that many, and the budget only narrows it further.
				// Neither applies to a whole-population read. It has its own ceiling
				// (`MAX_AGGREGATION_RESULT_TOKENS`, applied further down), and letting the manual
				// default (`DEFAULT_RECALL_TOKEN_BUDGET`, ~4.7x smaller) or a caller's `top_k` cut it
				// first is the second ceiling that turned a 138-row population into 8 served rows.
				const requestedRows =
					readsWholePopulation || parsed.top_k === undefined
						? limitedResults
						: limitedResults.slice(0, clampInt(parsed.top_k, 1, MAX_RECALL_TOOL_CANDIDATES));
				const session = readsWholePopulation ? undefined : ctx.recallSession;
				const history = session ? session.history.get(session.sessionId) : undefined;
				const unseenRows = session
					? requestedRows.filter(row => history?.get(row.entry.id) !== session.turn)
					: requestedRows;
				const alreadyServedCount = requestedRows.length - unseenRows.length;
				const packedRecall = readsWholePopulation
					? { rows: requestedRows, budget_used: 0, dropped_count: 0 }
					: packManualRecallRows(unseenRows, parsed.token_budget);
				const packedResults = packedRecall.rows;
				budgetRemoved = packedRecall.dropped_count;
				const truncated =
					aggregationIncomplete ||
					packedRecall.dropped_count > 0 ||
					(!completeReduction &&
						((observedScopeRowCount !== undefined && observedScopeRowCount > packedResults.length) ||
							boosted.length > packedResults.length));

				// Phase 0 §7.8: manual recall is the user's explicit signal that the
				// memory remains useful. Clear suppression unconditionally (no flag
				// gate) so reactivation can never be hidden behind a feature flip.
				// RC-2: an aggregation/completeness recall (sum/count/"which week")
				// reads the whole matching population and is NOT a per-memory
				// endorsement, so it must not reactivate suppressed memories — that
				// would revive superseded/bad memories just for matching a broad query.
				// Guarded by the same verdict that chose the broad read, so the
				// wider the read gets, the wider this refusal gets with it.
				if (!readsWholePopulation) {
					for (const r of packedResults) {
						try {
							await ctx.store.updateMetadata(r.entry.id, {
								suppressed_until_ms: undefined,
								bad_recall_count: 0,
							});
						} catch {
							// best-effort: surfacing the memory is the priority, metadata
							// healing happens on next successful write.
						}
					}
				}

				let aggregationTextTruncated = false;
				let displayResults = packedResults.map((result) => {
					const sourceText = result.snippet?.trim() ? result.snippet : result.entry.text;
					const displayText = readsWholePopulation
						? ctx.store.embedder.truncateToTokens(sourceText, DEFAULT_MAX_CONTEXT_TOKENS)
						: sourceText;
					if (displayText !== sourceText) aggregationTextTruncated = true;
					return {
						...result,
						entry: {
							...result.entry,
							text: displayText,
						},
					};
				});
				// Every memory renders at full text (owner ruling, 2026-08-21). The compact tiers were
				// selected from query wording, and a query matching no pattern got the shortest one.
				const render = (
					results: typeof displayResults,
					outputTruncated: boolean,
					populationTruncated: boolean,
				): ToolResult => {
					const populationComplete =
						!aggregationIncomplete && (completeReduction || !populationTruncated);
					const text = results
						.map((result, i) =>
							formatAtDepth(result.entry, result.score, i, {
								bm25Hit: result.sources?.bm25 !== undefined,
								reranked: result.sources?.reranked !== undefined,
								sanitize: sanitizeRecalledText,
								eventDate: episodicEventDate(result.entry),
							}),
						)
						.join("\n");
					const serialized = results.map((result) => {
						const base = serializeMemory(result.entry);
						// Metadata is per-row provenance no counting consumer reads, and the
						// aggregation budget below is charged against JSON.stringify(memories) —
						// so attaching it to a whole-population read spends the population's
						// budget on bytes nobody uses. Measured 2026-08-17: with it attached the
						// 138-row population overflowed 32,768 tokens, truncation fired, and all
						// 38 whole-population questions were answered from the last day or two of
						// their window (MPA 0.168 against 0.798 on ordinary questions).
						// Verified before restoring this guard: every caller that asks for
						// metadata (the eval server and three test harnesses) asks a
						// single-fact question and supplies no `aggregation` parameter, so
						// no metadata reader loses a field it was using.
						if (parsed.include_metadata && !readsWholePopulation) {
							const metadata = safeParseMetadata(result.entry.metadata);
							return { ...base, metadata: { ...(typeof metadata === "object" && metadata !== null ? metadata : {}), id: result.entry.id } };
						}
						return base;
					});
					const aggregationSummary = readsWholePopulation
						? `<recall-result scope-row-count="${observedScopeRowCount ?? "unknown"}" returned-count="${results.length}" population-complete="${populationComplete}" truncated="${outputTruncated}" />\n`
						: "";
					return makeResult(
						`<relevant-memories>\n${aggregationSummary}Found ${results.length} memories:\n\n${text}\n</relevant-memories>` +
							(alreadyServedCount > 0 ? `\n${alreadyServedCount} memories already shown in this turn were omitted.` : ""),
						{
							count: serialized.length,
							scope: outputScope,
							memories: serialized,
							...(session && { already_served_count: alreadyServedCount }),
							...(!readsWholePopulation && {
								budget_used: packedRecall.budget_used,
								dropped_count: packedRecall.dropped_count,
							}),
							...(readsWholePopulation && {
								...(observedScopeRowCount !== undefined && { scopeRowCount: observedScopeRowCount }),
									populationComplete,
								truncated: outputTruncated,
							}),
						},
					);
				};

				// What ONE consumer actually receives, not the union of two. The rendered text and the
				// `memories` array carry the same rows: the SnoStationMem host puts the rendered text in the
				// model request, the eval reads `memories`, and neither is handed both. Charging each for
				// the other's copy halved the real budget on the one path whose job is completeness.
				// The text lives at `content[0].text` — reading `candidate.text` yields 0 forever and the
				// budget silently stops existing while every test stays green.
				const consumerTokens = (candidate: ToolResult): number =>
					Math.max(
						countTokens(candidate.content.map((part) => part.text).join("\n")),
						countTokens(JSON.stringify(candidate.details["memories"] ?? [])),
					);
				let outputTruncated = truncated || aggregationTextTruncated;
				let populationTruncated = truncated;
				let result = render(displayResults, outputTruncated, populationTruncated);
				// A whole-population read that gets cut answers a counting question from part of
				// the data and says nothing about it, so the cut has to be visible somewhere a
				// human looks. Both terms are logged, not just the max, because which one is
				// larger names the cause: the rendered text is the model's copy, the serialized
				// memories are the eval's, and the 2026-08-17 severing was the second term
				// overflowing alone after per-row metadata was attached to it.
				if (readsWholePopulation) {
					const textTokens = countTokens(result.content.map((part) => part.text).join("\n"));
					const memoriesTokens = countTokens(JSON.stringify(result.details["memories"] ?? []));
					const over = Math.max(textTokens, memoriesTokens) > MAX_AGGREGATION_RESULT_TOKENS;
					log[over ? "warn" : "debug"](
						"Aggregation population budget checked",
						{
							rows: displayResults.length,
							textTokens,
							memoriesTokens,
							budget: MAX_AGGREGATION_RESULT_TOKENS,
							over_budget: over,
						},
						{ event_name: "memory.recall.budget.checked", file: "packages/sno-station-mem/src/engine/bindings/memory-recall-tool.ts", function: "execute", site_id: "memory.recall.budget.checked" },
					);
				}
				if (readsWholePopulation && consumerTokens(result) > MAX_AGGREGATION_RESULT_TOKENS) {
					let lowerBound = 0;
					let upperBound = displayResults.length;
					while (lowerBound < upperBound) {
						const midpoint = Math.ceil((lowerBound + upperBound) / 2);
						const candidate = render(displayResults.slice(0, midpoint), true, true);
						if (consumerTokens(candidate) <= MAX_AGGREGATION_RESULT_TOKENS) {
							lowerBound = midpoint;
						} else {
							upperBound = midpoint - 1;
						}
					}
					budgetRemoved += displayResults.length - lowerBound;
					displayResults = displayResults.slice(0, lowerBound);
					outputTruncated = true;
					populationTruncated = true;
					result = render(displayResults, outputTruncated, populationTruncated);
				}
				if (readsWholePopulation && consumerTokens(result) > MAX_AGGREGATION_RESULT_TOKENS) {
					const populationComplete = !aggregationIncomplete && completeReduction;
					return withTodoBlock(makeRecallResult(
						`<relevant-memories>\n<recall-result scope-row-count="${observedScopeRowCount ?? "unknown"}" returned-count="0" population-complete="${populationComplete}" truncated="true" />\nFound 0 memories.\n</relevant-memories>`,
						{
							count: 0,
							memories: [],
							...(observedScopeRowCount !== undefined && { scopeRowCount: observedScopeRowCount }),
							populationComplete,
							truncated: true,
						},
					));
				}
				return prependTodoBlock(appendStructuredRecallContent(result), todos);
			});
			const memories = output.details["memories"];
			served = Array.isArray(memories) ? memories.flatMap((row: unknown) =>
				typeof row === "object" && row !== null && "id" in row && typeof row.id === "string" ? [row.id] : []) : [];
			errorCode = output.details["errorCode"];
			if (output.details["resultStatus"] === "skipped") outcome = "refused";
			else if (output.isError) outcome = "failed";
			else outcome = served.length ? "success" : "empty_success";
			return output;
			} finally {
				log[outcome === "failed" ? "error" : "info"]("Memory recall completed", { outcome, code: errorCode, duration_ms: performance.now() - started,
					store_reference: privateLogReference(ctx.store.dbPath),
					served_ids: served.slice(0, 128), served_count: served.length, ids_truncated: served.length > 128,
					token_budget_removed_count: budgetRemoved, retired_closed_removed_count: retrievalDiagnostics.retired_closed_removed_count ?? "unavailable",
					sql_excluded_count: "unavailable", sql_excluded_reason: "query_does_not_report_excluded_rows", external_reference: currentLogContext().external_reference,
				}, { event_name: "memory.recall.completed", file: "packages/sno-station-mem/src/engine/bindings/memory-recall-tool.ts", function: "execute", site_id: "memory.recall.completed" });
			}
			});
		}
