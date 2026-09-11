import { z } from "zod";
import { MEMORY_CATEGORIES, type MemoryEntry, type RetrievalResult } from "../engine/shared/types";
import type { SnoStationMemMemorySearchResult } from "./provider-runtime-types";
import type { JsonValue } from "./inputs";

import { DEGRADED_REASONS, type DegradedReason } from "./error";
export { DEGRADED_REASONS, type DegradedReason } from "./error";
export type Result<T> = T & ({ degraded: false } | { degraded: true; reason: DegradedReason });
export type ToolResponse = {
	isError?: boolean;
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, JsonValue>;
};
export type InspectData =
	| { op: "storage"; dimension: number | null; failed: boolean; reason?: string }
	| { op: "stats"; total: number; projectBreakdown: Record<string, number>; categoryBreakdown: Record<string, number> }
	/** `project` is the call's resolved write project, so a caller can address it even when no entry exists. */
	| { op: "list" | "listReflection"; project: string; entries: MemoryEntry[] }
	| { op: "get"; entry: MemoryEntry | null; file?: { text: string; path: string; truncated?: boolean; from?: number; lines?: number; nextFrom?: number } };
export interface ContractOutputs {
	init: Result<{ principal: string; skinId: string }>;
	getRecall: Result<{ recallId: string; contextText: string; hits?: RetrievalResult[]; memoryIds?: string[]; toolResult?: ToolResponse; nativeHits?: SnoStationMemMemorySearchResult[]; unavailable?: string }>;
	capture: Result<{ turnId: string; committed: boolean }>;
	mutate: Result<{ result: ToolResponse }>;
	inspect: Result<{ result: InspectData }>;
	recordUsage: Result<{ accepted: boolean }>;
	onSessionEnd: Result<{ completed: boolean }>;
	staticBlock: Result<{ contextText: string }>;
}

export const memoryEntrySchema: z.ZodType<MemoryEntry, unknown> = z.strictObject({
	id: z.string().min(1), factId: z.string().optional(), text: z.string(),
	category: z.enum(MEMORY_CATEGORIES), projectId: z.string(), importance: z.number().finite(),
	timestamp: z.number().finite(), timezone: z.string(), metadata: z.string(), contentHash: z.string(),
	lane: z.enum(["active", "parked", "quarantined"]), rawCandidateJson: z.string().optional(),
	dispositionReason: z.string().optional(), dispositionedAt: z.number().finite().optional(),
});
const nativeHitSchema: z.ZodType<SnoStationMemMemorySearchResult, unknown> = z.strictObject({
	path: z.string(), startLine: z.number().int(), endLine: z.number().int(), score: z.number().finite(),
	vectorScore: z.number().finite().optional(), textScore: z.number().finite().optional(),
	snippet: z.string(), source: z.enum(["memory", "sessions"]), citation: z.string().optional(),
});
const score = z.strictObject({ score: z.number().finite() });
const rankedScore = score.extend({ rank: z.number().int() });
export const retrievalResultSchema: z.ZodType<RetrievalResult, unknown> = z.strictObject({
	entry: memoryEntrySchema, score: z.number().finite(), eventIdentity: z.string().optional(),
	scopeRowCount: z.number().int().nonnegative().optional(), aggregationIncomplete: z.boolean().optional(),
	sources: z.strictObject({ vector: rankedScore.optional(), bm25: rankedScore.optional(),
		fused: score.optional(), reranked: score.optional() }),
	chunkId: z.string().optional(), chunkIndex: z.number().int().optional(),
	bestChunkScore: z.number().finite().optional(), snippet: z.string().optional(),
	recallGroupKey: z.string().optional(), denseScore: z.number().finite().optional(),
	bm25Score: z.number().finite().optional(), fusedScore: z.number().finite().optional(),
	rerankScore: z.number().finite().optional(), mmrScore: z.number().finite().optional(),
});
export const toolResponseSchema: z.ZodType<ToolResponse, unknown> = z.strictObject({
	isError: z.boolean().optional(),
	content: z.array(z.strictObject({ type: z.literal("text"), text: z.string() })),
	details: z.record(z.string(), z.json()),
});
export const inspectDataSchema: z.ZodType<InspectData, unknown> = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("storage"), dimension: z.number().int().positive().nullable(), failed: z.boolean(), reason: z.string().optional() }),
	z.strictObject({ op: z.literal("stats"), total: z.number().int().nonnegative(),
		projectBreakdown: z.record(z.string(), z.number().int().nonnegative()),
		categoryBreakdown: z.record(z.string(), z.number().int().nonnegative()) }),
	z.strictObject({ op: z.enum(["list", "listReflection"]), project: z.string().min(1), entries: z.array(memoryEntrySchema) }),
	z.strictObject({ op: z.literal("get"), entry: memoryEntrySchema.nullable(),
		file: z.strictObject({ text: z.string(), path: z.string(), truncated: z.boolean().optional(),
			from: z.number().int().optional(), lines: z.number().int().optional(),
			nextFrom: z.number().int().optional() }).optional() }),
]);

function resultSchema<T extends z.ZodRawShape>(shape: T) {
	return z.discriminatedUnion("degraded", [
		z.strictObject({ ...shape, degraded: z.literal(false) }),
		z.strictObject({ ...shape, degraded: z.literal(true), reason: z.enum(DEGRADED_REASONS) }),
	]);
}

export const outputSchemas: { [K in keyof ContractOutputs]: z.ZodType<ContractOutputs[K], unknown> } = {
	init: resultSchema({ principal: z.string().min(1), skinId: z.string().min(1) }),
	getRecall: resultSchema({ recallId: z.string(), contextText: z.string(), hits: z.array(retrievalResultSchema).optional(), memoryIds: z.array(z.string().min(1)).optional(), toolResult: toolResponseSchema.optional(), nativeHits: z.array(nativeHitSchema).optional(), unavailable: z.string().optional() }),
	capture: resultSchema({ turnId: z.string().min(1), committed: z.boolean() }),
	mutate: resultSchema({ result: toolResponseSchema }),
	inspect: resultSchema({ result: inspectDataSchema }),
	recordUsage: resultSchema({ accepted: z.boolean() }),
	onSessionEnd: resultSchema({ completed: z.boolean() }),
	staticBlock: resultSchema({ contextText: z.string() }),
};
