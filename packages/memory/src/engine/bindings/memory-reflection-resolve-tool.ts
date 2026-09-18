/** @file memory-reflection-resolve-tool.ts
 * @purpose Registers the memory_reflection_resolve tool.
 * @boundary Marks reflection items resolved so they stop participating in reflection recall.
 */

import { z } from "zod";
import { parseReflectionMetadata } from "../reflection/entry-metadata-parser";
import {
	assertAccessibleScopeForTool,
	isScopeAccessibleForTool,
	resolveAgentAccess,
	resolveReadableScopesForTool,
} from "./memory-tool-access";

import { clampInt } from "./memory-tool-dependencies";
import {
	makeResult,
	runWithAudit,
} from "./memory-tool-results";
import type { ToolContext, ToolResult } from "./memory-tool-schemas";
import type { MemoryEntry } from "../shared/types";

const REFLECTION_ITEM_TYPE = "memory-reflection-item";
/** Bounded scan ceiling for query-mode candidate discovery. */
const REFLECTION_SCAN_LIMIT = 240;

type AgentAccess = ReturnType<typeof resolveAgentAccess>;

const resolveParamsSchema = z.object({
	memoryId: z.string().trim().min(1).optional(),
	query: z.string().trim().min(1).optional(),
	scope: z.string().optional(),
	dryRun: z.boolean().optional(),
	note: z.string().optional(),
	limit: z.number().int().optional(),
});

function isUnresolvedReflectionItem(entry: MemoryEntry): boolean {
	const metadata = parseReflectionMetadata(entry.metadata);
	return metadata.type === REFLECTION_ITEM_TYPE && metadata.resolvedAt === undefined;
}

function describeCandidate(entry: MemoryEntry): Record<string, unknown> {
	const metadata = parseReflectionMetadata(entry.metadata);
	return {
		id: entry.id,
		itemKind: typeof metadata.itemKind === "string" ? metadata.itemKind : "item",
		scope: entry.projectId,
		text: entry.text.replace(/\s+/g, " ").trim().slice(0, 180),
	};
}

/** Lexical relevance: count of distinct query tokens present in the entry text. */
function lexicalScore(text: string, queryTokens: string[]): number {
	const lower = text.toLowerCase();
	let score = 0;
	for (const token of queryTokens) if (lower.includes(token)) score += 1;
	return score;
}



async function resolveById(
	ctx: ToolContext,
	access: AgentAccess,
	memoryId: string,
	options: { dryRun: boolean; note: string | undefined },
): Promise<ToolResult> {
	const entry = ctx.store.getById(memoryId);
	if (!entry) {
		return makeResult(`Memory not found: ${memoryId}`, { error: "not_found", memoryId }, true);
	}
	const metadata = parseReflectionMetadata(entry.metadata);
	if (metadata.type !== REFLECTION_ITEM_TYPE) {
		return makeResult(
			`Memory ${entry.id} is not a reflection item.`,
			{ error: "not_reflection_item", memoryId: entry.id },
			true,
		);
	}
	if (!isScopeAccessibleForTool(ctx.scopePolicy, entry.projectId, access)) {
		return makeResult(
			`Access denied to scope: ${entry.projectId}`,
			{ error: "scope_access_denied", scope: entry.projectId },
			true,
		);
	}
	if (options.dryRun) {
		if (metadata.resolvedAt !== undefined) {
			return makeResult(`Reflection item already resolved: ${entry.id}`, {
				action: "already_resolved",
				memoryId: entry.id,
			});
		}
		return makeResult(`Reflection resolve preview (no changes): ${entry.id}`, {
			action: "preview",
			candidate: describeCandidate(entry),
		});
	}
	// Atomic guard+write under the store mutex; a concurrent resolve sees
	// `already_resolved` instead of clobbering the first resolution.
	const outcome = await ctx.store.resolveReflectionItem(entry.id, {
		writerAuthority: "offline-family",
		resolvedAt: Date.now(),
		...(access.agentId ? { resolvedBy: access.agentId } : {}),
		...(options.note ? { note: options.note } : {}),
	});
	// Handle every outcome — the row can be deleted or change type between the
	// pre-check above and the mutex-guarded write.
	switch (outcome) {
		case "resolved":
			ctx.clearReflectionSliceCache?.();
			return makeResult(`Resolved reflection item: ${entry.id}`, {
				action: "resolved",
				memoryId: entry.id,
			});
		case "already_resolved":
			return makeResult(`Reflection item already resolved: ${entry.id}`, {
				action: "already_resolved",
				memoryId: entry.id,
			});
		case "not_found":
			return makeResult(`Memory not found: ${entry.id}`, { error: "not_found", memoryId: entry.id }, true);
		case "not_reflection_item":
			return makeResult(
				`Memory ${entry.id} is not a reflection item.`,
				{ error: "not_reflection_item", memoryId: entry.id },
				true,
			);
	}
}

async function resolveByQuery(
	ctx: ToolContext,
	access: AgentAccess,
	query: string,
	options: { projectIdFilter: string[]; dryRun: boolean; note: string | undefined; limit: number },
): Promise<ToolResult> {
	if (options.projectIdFilter.length === 0) {
		return makeResult("No accessible scopes.", { action: "preview", candidates: [] });
	}
	// Scan reflection-item rows directly (SQL type filter) so ordinary memories
	// can never crowd unresolved items out of a semantic top-N.
	const items = await ctx.store.listReflectionItems({
		projectIdFilter: options.projectIdFilter,
		limit: REFLECTION_SCAN_LIMIT,
		unresolvedOnly: true,
	});
	// SQL already excludes resolved/malformed rows; re-filter defensively.
	const unresolved = items.filter(isUnresolvedReflectionItem);
	if (unresolved.length === 0) {
		return makeResult("No unresolved reflection items found.", { action: "preview", candidates: [] });
	}
	const queryTokens = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	// Stable sort by lexical score (input is already newest-first), so equal
	// scores keep recency order. Best matches first; discovery is guaranteed.
	const ranked = unresolved
		.map((entry, index) => ({ entry, index, score: lexicalScore(entry.text, queryTokens) }))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, options.limit)
		.map((ranking) => ranking.entry);

	if (options.dryRun) {
		return makeResult(`Reflection resolve preview: ${ranked.length} unresolved item(s). No changes made.`, {
			action: "preview",
			candidates: ranked.map((entry) => describeCandidate(entry)),
		});
	}
	const resolvedIds: string[] = [];
	for (const entry of ranked) {
		const outcome = await ctx.store.resolveReflectionItem(entry.id, {
			writerAuthority: "offline-family",
			resolvedAt: Date.now(),
			...(access.agentId ? { resolvedBy: access.agentId } : {}),
			...(options.note ? { note: options.note } : {}),
		});
		if (outcome === "resolved") resolvedIds.push(entry.id);
	}
	if (resolvedIds.length > 0) ctx.clearReflectionSliceCache?.();
	return makeResult(`Resolved ${resolvedIds.length} reflection item(s).`, {
		action: "resolved",
		resolvedIds,
	});
}

export async function executeMemoryReflectionResolveTool(ctx: ToolContext, access: ReturnType<typeof resolveAgentAccess>, _toolCallId: unknown, params: unknown): Promise<ToolResult> {
					return runWithAudit(ctx, "memory_reflection_resolve", undefined, async () => {
						const parsed = resolveParamsSchema.parse(params);
						if (!parsed.memoryId && !parsed.query) {
							return makeResult("Provide memoryId or query.", { error: "missing_selector" }, true);
						}
						if (parsed.memoryId && parsed.query) {
							return makeResult(
								"Provide only one of memoryId or query.",
								{ error: "ambiguous_selector" },
								true,
							);
						}

						if (parsed.memoryId) {
							return resolveById(ctx, access, parsed.memoryId, {
								dryRun: parsed.dryRun ?? false,
								note: parsed.note,
							});
						}

						const scopeFilter = parsed.scope
							? [assertAccessibleScopeForTool(ctx.scopePolicy, parsed.scope, access)]
							: resolveReadableScopesForTool(ctx.scopePolicy, access);
						return resolveByQuery(ctx, access, parsed.query ?? "", {
							projectIdFilter: scopeFilter,
							dryRun: parsed.dryRun ?? true,
							note: parsed.note,
							limit: clampInt(parsed.limit ?? 5, 1, 20),
						});
					});
				}
