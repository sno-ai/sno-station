/** @file memory-stats-tool.ts
 * @purpose Registers the memory_stats tool.
 * @boundary One host tool registration and its handler logic.
 */

import {
	assertAccessibleScopeForTool,
	getStoreScopeFilterForTool,
	resolveAgentAccess,
	resolveReadableScopesForTool,
} from "./memory-tool-access";

import { isSystemBypassId, readEstimatedSpendToday } from "./memory-tool-dependencies";
import {
	makeResult,
	runWithAudit,
} from "./memory-tool-results";
import { statsParamsSchema, type ToolContext, type ToolResult } from "./memory-tool-schemas";



export async function executeMemoryStatsTool(ctx: ToolContext, access: ReturnType<typeof resolveAgentAccess>, _toolCallId: unknown, params: unknown): Promise<ToolResult> {
					// Centralize the tool execution fallback value at the boundary of this helper.
					return runWithAudit(ctx, "memory_stats", undefined, async () => {
						const parsed = statsParamsSchema.parse(params);
						// Compute the normalized requested scopes once so later tool execution checks use one value.
						const requestedScopes = parsed.scope
							? assertAccessibleScopeForTool(ctx.scopePolicy, parsed.scope, access)
							: resolveReadableScopesForTool(ctx.scopePolicy, access);
						// Compute the normalized scope filter once so later tool execution checks use one value.
						const scopeFilter = Array.isArray(requestedScopes)
							? requestedScopes
							: [requestedScopes];

						// Use unfiltered stats ONLY for explicit system-bypass principals,
						// so dynamic built-in scopes not returned by getAllScopes() remain
						// visible to system tooling. Non-system principals must always go
						// through the scoped path even when getStoreScopeFilterForTool
						// returns undefined (e.g. legacy/test scope managers without
						// getScopeFilter). Fail-closed matches the convention used by
						// memory_recall / memory_list elsewhere in this file.
						const useUnfiltered =
							!parsed.scope &&
							isSystemBypassId(access.agentId) &&
							getStoreScopeFilterForTool(ctx.scopePolicy, access) === undefined;

						let total = 0;
						// Compute the normalized scope breakdown once so later tool execution checks use one value.
						const projectBreakdown: Record<string, number> = {};
						const categoryBreakdown: Record<string, number> = {};
						// Guard guard condition here so the remaining tool execution path works with normalized inputs.
						if (useUnfiltered) {
							const allStats = await ctx.store.stats();
							total = allStats.total;
							// This tool execution step establishes state that later reads and cleanup paths depend on.
							Object.assign(projectBreakdown, allStats.projectBreakdown);
							Object.assign(categoryBreakdown, allStats.categoryBreakdown);
						} else {
							// Iterate deterministically so tool execution output order remains stable.
							for (const scope of scopeFilter) {
								// Await the tool execution dependency before deriving downstream state.
								const scoped = await ctx.store.stats(scope);
								// This tool execution step establishes state that later reads and cleanup paths depend on.
								total += scoped.total;
								// Iterate deterministically so tool execution output order remains stable.
								for (const [key, value] of Object.entries(scoped.projectBreakdown)) {
									// This tool execution step establishes state that later reads and cleanup paths depend on.
									projectBreakdown[key] = (projectBreakdown[key] ?? 0) + value;
								}
								// Iterate deterministically so tool execution output order remains stable.
								for (const [key, value] of Object.entries(scoped.categoryBreakdown)) {
									categoryBreakdown[key] = (categoryBreakdown[key] ?? 0) + value;
								}
							}
						}
						const estimatedSpendTodayUsd = await readEstimatedSpendToday(ctx.stateDir);
						const payload = {
							total,
							scopeBreakdown: projectBreakdown,
							categoryBreakdown,
							estimatedSpendTodayUsd,

						};
						// Serialize metadata once at the boundary so storage receives a stable payload.
						return makeResult(JSON.stringify(payload), payload);
					});
				}
