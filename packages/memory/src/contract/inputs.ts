import { z } from "zod";
import {
	llmRoutingConfigSchema,
	type LlmRoutingConfig,
} from "./config/plugin-config-mode-schema";
import { AGGREGATION_OPERATIONS, MEMORY_CATEGORIES, type MemoryCategory } from "../engine/shared/types";

export type JsonValue = z.infer<ReturnType<typeof z.json>>;
export type ScopeCtx = { principal: string; project: string; session: string };
export type Message = {
	role: "system" | "developer" | "user" | "assistant" | "tool";
	content: JsonValue;
	at: number;
};
export type Turn = { turnId: string; rewindEpoch: number; messages: Message[] };
export type Registration = {
	skinId: string;
	routing: LlmRoutingConfig;
	model?: { baseUrl: string; credential: string; model: string };
};
export type RecallOptions = {
	source?: "auto" | "manual";
	limit?: number;
	minScore?: number;
	category?: MemoryCategory;
	includeMetadata?: boolean;
	includeHistory?: boolean;
	includeRefused?: boolean;
	tokenBudget?: number;
	externalReference?: string;
	externalReferenceVisibility?: "public" | "private";
	aggregation?: { operation: (typeof AGGREGATION_OPERATIONS)[number]; terms: string[] };
};
export type Mutation =
	| { op: "store"; content: string; category?: "episodic" | "profile"; importance?: number; metadata?: Record<string, JsonValue> }
	| { op: "forget"; id?: string; query?: string; suppressKey?: { subject: string; attribute: string }; suppressContent?: string; minScore?: number; maxDelete?: number; confirm?: boolean }
	| { op: "update"; id: string; text?: string; category?: MemoryCategory; importance?: number; metadata?: Record<string, JsonValue> }
	| { op: "clear"; confirm: boolean; all?: boolean }
	| { op: "resolveReflection"; memoryId?: string; query?: string; dryRun?: boolean; note?: string; limit?: number };
export type Inspection =
	| { op: "stats" }
	| { op: "list"; category?: MemoryCategory; limit?: number; offset?: number; importanceMin?: number }
	| { op: "get"; id?: string; path?: string; from?: number; lines?: number }
	| { op: "listReflection"; limit?: number; unresolvedOnly?: boolean };
export type UsageSignal = {
	event: "inject" | "used" | "rejected" | "tool-error";
	memoryIds: string[];
	toolName?: string;
	text?: string;
	at: number;
};
export interface ContractInputs {
	init: { scope: ScopeCtx; registration: Registration };
	getRecall: { query: string; scope: ScopeCtx; options: RecallOptions };
	capture: { turn: Turn; scope: ScopeCtx };
	mutate: { op: Mutation; scope: ScopeCtx };
	inspect: { op: Inspection; scope: ScopeCtx };
	recordUsage: { recallId: string; signal: UsageSignal; scope: ScopeCtx };
	onSessionEnd: { messages: Message[]; scope: ScopeCtx };
	staticBlock: { scope: ScopeCtx };
}

const nonempty = z.string().min(1).refine((value) => value.trim().length > 0);
const timestamp = z.number().finite().nonnegative();
const category = z.enum(MEMORY_CATEGORIES);
const metadata = z.record(z.string(), z.json());
export const scopeSchema: z.ZodType<ScopeCtx, unknown> = z.strictObject({
	principal: nonempty, project: nonempty, session: nonempty,
});
export const messageSchema: z.ZodType<Message, unknown> = z.strictObject({
	role: z.enum(["system", "developer", "user", "assistant", "tool"]),
	content: z.json(), at: timestamp,
});
export const turnSchema: z.ZodType<Turn, unknown> = z.strictObject({
	turnId: nonempty, rewindEpoch: z.number().int().nonnegative(), messages: z.array(messageSchema),
});
export const registrationSchema: z.ZodType<Registration, unknown> = z.strictObject({
	skinId: nonempty,
	routing: llmRoutingConfigSchema,
	model: z.strictObject({
		baseUrl: z.url({ protocol: /^https?$/ }), credential: z.string(), model: nonempty,
	}).optional(),
});
export const recallOptionsSchema: z.ZodType<RecallOptions, unknown> = z.strictObject({
	source: z.enum(["auto", "manual"]).optional(),
	limit: z.number().int().optional(), minScore: z.number().finite().optional(),
	category: category.optional(), includeMetadata: z.boolean().optional(),
	includeHistory: z.boolean().optional(), includeRefused: z.boolean().optional(),
	tokenBudget: z.number().int().optional(), externalReference: z.string().optional(),
	externalReferenceVisibility: z.enum(["public", "private"]).optional(),
	aggregation: z.strictObject({
		operation: z.enum(AGGREGATION_OPERATIONS),
		terms: z.array(z.string().trim().min(1).max(128)).min(1).max(8),
	}).optional(),
});
export const mutationSchema: z.ZodType<Mutation, unknown> = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("store"), content: nonempty,
		category: z.enum(["episodic", "profile"]).optional(),
		importance: z.number().finite().optional(), metadata: metadata.optional() }),
	z.strictObject({ op: z.literal("forget"), id: nonempty.optional(), query: nonempty.optional(),
		suppressKey: z.strictObject({ subject: nonempty, attribute: nonempty }).optional(),
		suppressContent: nonempty.optional(), minScore: z.number().finite().optional(),
		maxDelete: z.number().int().positive().optional(), confirm: z.boolean().optional(),
	}).refine((value) => [value.id, value.query, value.suppressKey, value.suppressContent]
		.filter((item) => item !== undefined).length === 1),
	z.strictObject({ op: z.literal("update"), id: nonempty,
		text: nonempty.optional(), category: category.optional(),
		importance: z.number().finite().optional(), metadata: metadata.optional(),
	}).refine((value) => value.text !== undefined || value.category !== undefined
		|| value.importance !== undefined || value.metadata !== undefined),
	z.strictObject({ op: z.literal("clear"), confirm: z.boolean(), all: z.boolean().optional() }),
	z.strictObject({ op: z.literal("resolveReflection"), memoryId: nonempty.optional(),
		query: nonempty.optional(), dryRun: z.boolean().optional(), note: z.string().optional(),
		limit: z.number().int().optional(),
	}).refine((value) => (value.memoryId !== undefined) !== (value.query !== undefined)),
]);
export const inspectionSchema: z.ZodType<Inspection, unknown> = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("stats") }),
	z.strictObject({ op: z.literal("list"), category: category.optional(),
		limit: z.number().int().optional(), offset: z.number().int().optional(),
		importanceMin: z.number().finite().optional() }),
	z.strictObject({ op: z.literal("get"), id: nonempty.optional(), path: nonempty.optional(),
		from: z.number().int().positive().optional(), lines: z.number().int().positive().optional(),
	}).refine((value) => (value.id !== undefined) !== (value.path !== undefined)),
	z.strictObject({ op: z.literal("listReflection"), limit: z.number().int().optional(),
		unresolvedOnly: z.boolean().optional() }),
]);
export const usageSignalSchema: z.ZodType<UsageSignal, unknown> = z.strictObject({
	event: z.enum(["inject", "used", "rejected", "tool-error"]), memoryIds: z.array(nonempty),
	toolName: nonempty.optional(), text: z.string().optional(), at: timestamp,
});
export const inputSchemas: { [K in keyof ContractInputs]: z.ZodType<ContractInputs[K], unknown> } = {
	init: z.strictObject({ scope: scopeSchema, registration: registrationSchema }),
	getRecall: z.strictObject({ query: nonempty, scope: scopeSchema, options: recallOptionsSchema }),
	capture: z.strictObject({ turn: turnSchema, scope: scopeSchema }),
	mutate: z.strictObject({ op: mutationSchema, scope: scopeSchema }),
	inspect: z.strictObject({ op: inspectionSchema, scope: scopeSchema }),
	recordUsage: z.strictObject({ recallId: nonempty, signal: usageSignalSchema, scope: scopeSchema }),
	onSessionEnd: z.strictObject({ messages: z.array(messageSchema), scope: scopeSchema }),
	staticBlock: z.strictObject({ scope: scopeSchema }),
};
