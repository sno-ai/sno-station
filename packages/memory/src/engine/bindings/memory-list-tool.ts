/** @file memory-list-tool.ts
 * @purpose Registers the memory_list tool.
 * @boundary One host tool registration and its handler logic.
 */

import {
	assertAccessibleScopeForTool,
	resolveAgentAccess,
	resolveReadableScopesForTool,
} from "./memory-tool-access";

import { clampInt, DEFAULT_LIST_LIMIT, SnoStationMemError, MAX_LIST_LIMIT, readEstimatedSpendToday, normalizeCategory } from "./memory-tool-dependencies";
import { serializeMemory } from "./memory-tool-formatting";
import {
	makeResult,
	runWithAudit,
} from "./memory-tool-results";
import { listParamsSchema, type ToolContext, type ToolResult } from "./memory-tool-schemas";



export async function executeMemoryListTool(ctx: ToolContext, access: ReturnType<typeof resolveAgentAccess>, _toolCallId: unknown, params: unknown): Promise<ToolResult> {
					// Centralize the tool execution fallback value at the boundary of this helper.
					return runWithAudit(ctx, "memory_list", undefined, async () => {
						const parsed = listParamsSchema.parse(params);
						const limit = clampInt(parsed.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
						const offset = clampInt(parsed.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
						// Compute the normalized validated scope once so later tool execution checks use one value.
						let validatedScope = parsed.scope
							? assertAccessibleScopeForTool(ctx.scopePolicy, parsed.scope, access)
							: undefined;
						const resolvedScopes = validatedScope
							? []
							: resolveReadableScopesForTool(ctx.scopePolicy, access);
						// Guard validated scope here so the remaining tool execution path works with normalized inputs.
						if (!validatedScope) {
							// Treat the empty collection as a first-class outcome instead of widening behavior.
							if (resolvedScopes.length === 0) {
								const emptyDetails = {
									count: 0,
									limit,
									offset,
									estimatedSpendTodayUsd: await readEstimatedSpendToday(ctx.stateDir),

								};
								// Serialize metadata once at the boundary so storage receives a stable payload.
								return makeResult(JSON.stringify([]), emptyDetails);
							}
							const [onlyScope] = resolvedScopes;
							// Guard only scope here so the remaining tool execution path works with normalized inputs.
							if (resolvedScopes.length === 1 && !onlyScope) {
								// Surface this invalid tool execution state as an explicit typed failure.
								throw new SnoStationMemError(
									"invalid_scope",
									"No accessible scope available for memory_list.",
								);
							}
							validatedScope = resolvedScopes.length === 1 ? onlyScope : undefined;
						}
						const listOptions = {
							...(validatedScope ? { projectId: validatedScope } : {}),
							...(!validatedScope && resolvedScopes.length > 1
								? { projectIdFilter: resolvedScopes }
								: {}),
							limit,
							offset,
							...(parsed.category
								? {
										category: normalizeCategory(parsed.category),
									}
								: {}),
							...(typeof parsed.importance_min === "number"
								? { importanceMin: parsed.importance_min }
								: {}),
						};
						const entries = await ctx.store.list(listOptions);
						const serialized = entries.map((entry) => serializeMemory(entry));
						const estimatedSpendTodayUsd = await readEstimatedSpendToday(ctx.stateDir);
						const details = {
							count: serialized.length,
							limit,
							offset,
							estimatedSpendTodayUsd,

						};
						// Serialize metadata once at the boundary so storage receives a stable payload.
						return makeResult(JSON.stringify(serialized), details);
					});
				}
