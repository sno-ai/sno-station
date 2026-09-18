/** @file memory-forget-tool.ts
 * @purpose Registers the memory_forget tool.
 * @boundary One host tool registration and its handler logic.
 */

import {
	assertAccessibleScopeForTool,
	isScopeAccessibleForTool,
	resolveAgentAccess,
	resolveReadableScopesForTool,
} from "./memory-tool-access";

import { clamp01, clampInt, SnoStationMemError, FORGET_QUERY_DEFAULT_LIMIT, FORGET_QUERY_MIN_SCORE, MAX_CANDIDATE_POOL_SIZE } from "./memory-tool-dependencies";
import {
	makeResult,
	runWithAudit,
} from "./memory-tool-results";
import { forgetParamsSchema, type ToolContext, type ToolResult } from "./memory-tool-schemas";
import { MEMORY_TELEMETRY_DELETE_REASONS } from "../telemetry/memory-telemetry-types";



export async function executeMemoryForgetTool(ctx: ToolContext, access: ReturnType<typeof resolveAgentAccess>, _toolCallId: unknown, params: unknown): Promise<ToolResult> {
					// Centralize the tool execution fallback value at the boundary of this helper.
					return runWithAudit(ctx, "memory_forget", undefined, async () => {
						const parsed = forgetParamsSchema.parse(params);
						if (parsed.suppress_key || parsed.suppress_content) {
							const projectId = assertAccessibleScopeForTool(
								ctx.scopePolicy,
								parsed.scope ?? "",
								access,
							);
							const suppression = parsed.suppress_key
								? await ctx.store.createMemorySuppression({
										projectId,
										subject: parsed.suppress_key.subject,
										attribute: parsed.suppress_key.attribute,
										nowMs: Date.now(),
									})
								: await ctx.store.createMemorySuppression({
										projectId,
										content: parsed.suppress_content ?? "",
										nowMs: Date.now(),
									});
							return makeResult(
								`${suppression.shape} suppression ${suppression.created ? "created" : "already exists"}.`,
								{ suppression },
							);
						}
						// Guard guard condition here so the remaining tool execution path works with normalized inputs.
						if (parsed.id) {
							const target = ctx.store.getById(parsed.id);
							// Guard target here so the remaining tool execution path works with normalized inputs.
							if (!target) {
								return makeResult(`Memory not found: ${parsed.id}`, {});
							}
							// Guard this branch early so the remaining tool execution path works with normalized inputs.
							if (!isScopeAccessibleForTool(ctx.scopePolicy, target.projectId, access)) {
								// Surface this invalid tool execution state as an explicit typed failure.
								throw new SnoStationMemError("invalid_scope", `Scope not accessible: ${target.projectId}`);
							}
							const deleted = await ctx.store.delete(parsed.id, {
								deleteReason: MEMORY_TELEMETRY_DELETE_REASONS.memoryForget,
							});
							// Centralize the tool execution fallback value at the boundary of this helper.
							return makeResult(`Deleted memory: ${parsed.id}`, {
								deletedCount: deleted,
							});
						}

						// Compute the normalized scope filter once so later tool execution checks use one value.
						const scopeFilter = parsed.scope
							? [assertAccessibleScopeForTool(ctx.scopePolicy, parsed.scope, access)]
							: resolveReadableScopesForTool(ctx.scopePolicy, access);
						const minScore = clamp01(
							parsed.min_score ?? FORGET_QUERY_MIN_SCORE,
							FORGET_QUERY_MIN_SCORE,
						);
						const maxDelete = clampInt(
							parsed.max_delete ?? FORGET_QUERY_DEFAULT_LIMIT,
							1,
							MAX_CANDIDATE_POOL_SIZE,
						);
						// Handle the absent-value case explicitly before the happy path depends on it.
						if (!parsed.scope && scopeFilter.length === 0) {
							return makeResult("No matching memories found to delete.", {});
						}
						const matches = await ctx.retriever.retrieve({
							query: parsed.query ?? "",
							limit: maxDelete,
							...(scopeFilter.length > 0 ? { scopeFilter } : {}),
							source: "manual",
							...(ctx.language ? { explicitLocale: ctx.language } : {}),
							// Removal is not serving: a retracted row is exactly the kind of row a
							// user asks to forget, so this path opts out of the serving validity
							// default (PRD 205). `0` makes the store predicate `invalidated_at > 0`,
							// which drops nothing.
							excludeInvalidatedBefore: 0,
						});
						const candidates = matches.filter((match) => match.score >= minScore);
						// Treat the empty collection as a first-class outcome instead of widening behavior.
						if (candidates.length === 0) {
							return makeResult("No matching memories found to delete.", {});
						}

						const ids = Array.from(
							new Set(candidates.map((candidate) => candidate.entry.id)),
						).slice(0, maxDelete);
						// Guard parsed.confirm here so the remaining tool execution path works with normalized inputs.
						if (parsed.confirm !== true) {
							return makeResult(
								`Found ${ids.length} matching memories. Re-run with confirm=true to delete.`,
								{
									deletedCount: 0,
									candidateCount: ids.length,
									ids,
									requireConfirm: true,
								},
								true,
							);
						}
						const deletedCount = await ctx.store.deleteMany(ids, {
							deleteReason: MEMORY_TELEMETRY_DELETE_REASONS.memoryForget,
						});
						return makeResult(`Deleted ${deletedCount} memories.`, {
							deletedCount,
							ids,
						});
					});
				}
