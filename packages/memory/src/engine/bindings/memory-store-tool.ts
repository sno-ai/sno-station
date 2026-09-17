/** @file memory-store-tool.ts
 * @purpose Registers the memory_store tool.
 * @boundary One host tool registration and its handler logic.
 */

import {
	assertAccessibleScopeForTool,
	getDefaultScopeForTool,
	type ResolvedAgentAccess,
	resolveAgentAccess,
} from "./memory-tool-access";
import type { MemoryCategory } from "./memory-tool-dependencies";
import { appendAuditEntry, clamp01, DEFAULT_IMPORTANCE, DEFAULT_LOCALE, detectCategory, normalizeCategory, serializeIntervalMetadata, stableHash, stripEnvelopeMetadata } from "./memory-tool-dependencies";
import { resolveMemoryDate, type DateResolutionResult } from "../extraction/date-resolution";
import {
	makeResult,
	runWithAudit,
} from "./memory-tool-results";
import { storeParamsSchema, type ToolContext, type ToolResult } from "./memory-tool-schemas";
import {
	createRetireByNameRunBudget,
	runProfileSectionUpdate,
} from "../extraction/profile-section-writer";

type StoreParams = ReturnType<(typeof storeParamsSchema)["parse"]>;
function resolveStoreScope(
	parsed: StoreParams,
	ctx: ToolContext,
	access: ResolvedAgentAccess,
): string {
	if (parsed.scope) {
		return assertAccessibleScopeForTool(ctx.scopePolicy, parsed.scope, access);
	}
	return getDefaultScopeForTool(ctx.scopePolicy, access);
}

function auditEnvelopeStrip(ctx: ToolContext, original: string, stripped: string): void {
	if (stripped.length === original.length) return;
	appendAuditEntry(ctx.stateDir, {
		event: "envelope_strip",
		tool: "memory_store",
		resultStatus: "ok",
		decision: "stripped",
		details: {
			beforeChars: original.length,
			afterChars: stripped.length,
		},
	});
}

function rejectContentIfNeeded(stripped: string): ToolResult | undefined {
	if (stripped.trim()) return undefined;
	return makeResult(
		"Skipped: content is purely envelope metadata with no extractable memory.",
		{ resultStatus: "skipped" },
	);
}

function resolveStoreCategory(
	parsed: StoreParams,
	stripped: string,
	ctx: ToolContext,
): MemoryCategory | undefined {
	const explicitCategory = parsed.category ? normalizeCategory(parsed.category) : undefined;
	if (explicitCategory) return explicitCategory;
	const detectedCategory = detectCategory(stripped, { explicitLocale: ctx.language });
	if (detectedCategory === "lesson") return "episodic";
	if (detectedCategory) return detectedCategory;
	// A keyword vote failing to name a category is not a reason to discard the user's memory, and
	// it used to be exactly that: the tool wrote `rejected_ambiguous_category` and saved nothing.
	// Measured 2026-08-19 against the 24,201 Memora turns the corpus marks as facts worth
	// remembering, the vote named no category for 17,257 of them — 71.3% — including plain
	// episodic statements like "I just spent $12.69 on breakfast this morning." The user asked
	// for this to be stored; the only open question was where to file it.
	//
	// Episodic assumes the least when the routing vote has no winner.
	appendAuditEntry(ctx.stateDir, {
		event: "tool_call",
		tool: "memory_store",
		resultStatus: "ok",
		decision: "category_fallback_episodic",
		details: { chars: stripped.length },
	});
	return "episodic";
}

function buildStoreMetadata(
	parsed: StoreParams,
	category: MemoryCategory,
	dateResolution: DateResolutionResult,
): Record<string, unknown> {
	const callerValidFrom = normalizeCallerValidFrom(parsed.metadata?.["valid_from"]);
	const temporalMetadata = serializeIntervalMetadata(category, dateResolution.interval);
	return {
		...(parsed.metadata ?? {}),
		source: "manual",
		memory_category: category,
		...temporalMetadata,
		...(callerValidFrom === undefined ? {} : { valid_from: callerValidFrom }),
	};
}

function normalizeCallerValidFrom(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
	}
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const trimmed = value.trim();
	const numeric = Number(trimmed);
	const parsed = Number.isFinite(numeric) ? numeric : Date.parse(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
function metadataStringValue(
	metadata: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function executeMemoryStore(
	ctx: ToolContext,
	access: ResolvedAgentAccess,
	params: unknown,
): Promise<ToolResult> {
	const parsed = storeParamsSchema.parse(params);
	const scope = resolveStoreScope(parsed, ctx, access);
	const importance = clamp01(parsed.importance ?? DEFAULT_IMPORTANCE, DEFAULT_IMPORTANCE);
	const stripped = stripEnvelopeMetadata(parsed.content);

	auditEnvelopeStrip(ctx, parsed.content, stripped);
	const rejected = rejectContentIfNeeded(stripped);
	if (rejected) return rejected;

	const category = resolveStoreCategory(parsed, stripped, ctx);
	if (!category) {
		return makeResult("Skipped: content has no unambiguous memory category.", {
			resultStatus: "skipped",
		});
	}

	const hash = stableHash(stripped);
	const duplicate = ctx.store.findByContentHash(hash, scope);
	if (duplicate) {
		return makeResult(`Memory already exists: ${duplicate.id}`, {
			id: duplicate.id,
			scope,
		});
	}

	if (category === "profile") {
		const sectionName = metadataStringValue(parsed.metadata, "section_name");
		if (!sectionName) {
			return makeResult(
				"Rejected: memory_store profile writes require metadata.section_name.",
				{ resultStatus: "rejected", category },
				true,
			);
		}
		const at = ctx.sessionTimestamp ?? Date.now();
		const callerValidFrom = normalizeCallerValidFrom(parsed.metadata?.["valid_from"]);
		const retireByNameBudget = createRetireByNameRunBudget(60_000);
		const result = await runProfileSectionUpdate({
			scope,
			sectionName,
			topic: metadataStringValue(parsed.metadata, "topic"),
			newAssertion: stripped,
			evidence: stripped,
			source: {
				source: "manual",
				messageId: `manual:${hash}`,
			},
			...(callerValidFrom === undefined
				? {}
				: { metadataPatch: { valid_from: callerValidFrom } }),
			store: ctx.store,
			...(ctx.profileToolLlm ? { llm: ctx.profileToolLlm } : {}),
			...(ctx.llmRouting ? { routing: ctx.llmRouting } : {}),
			at,
			timeoutMs: 60_000,
			retireByNameBudget,
		});
		if (!result.rowId) {
			return makeResult(
				"Rejected: profile memory was not stored because the active-task assertion could not be applied.",
				{
					resultStatus: "rejected",
					category,
					profileOutcome: result.outcome,
				},
				true,
			);
		}
		return makeResult(`Stored profile memory ${result.rowId}`, {
			id: result.rowId,
			scope,
			category,
			profileOutcome: result.outcome,
		});
	}

	const dateResolution = await resolveMemoryDate({
		text: stripped,
		sessionTimestamp: ctx.sessionTimestamp,
		sessionTimezone: ctx.sessionTimezone,
		locale: ctx.language ?? DEFAULT_LOCALE,
		llm: ctx.profileToolLlm,
		routing: ctx.llmRouting,
	});
	const stored = await ctx.store.store({
		offlineFamily: true,
		text: stripped,
		category,
		projectId: scope,
		importance,
		metadata: JSON.stringify(buildStoreMetadata(parsed, category, dateResolution)),
		...(dateResolution.timestamp === undefined ? {} : { timestamp: dateResolution.timestamp }),
		timezone: dateResolution.timezone,
	});
	return makeResult(`Stored memory ${stored.id}`, {
		id: stored.id,
		scope,
		category: stored.category,
	});
}



export async function executeMemoryStoreTool(ctx: ToolContext, access: ReturnType<typeof resolveAgentAccess>, _toolCallId: unknown, params: unknown): Promise<ToolResult> {
					return runWithAudit(ctx, "memory_store", undefined, () =>
						executeMemoryStore(ctx, access, params),
					);
				}
