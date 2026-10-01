/** @file memory-tool-schemas.ts
 * @purpose Defines host parameter schemas and shared memory tool context/result contracts.
 * @boundary Schema and type definitions only.
 */



import type {
	AggregationQuery,
	Embedder,
	Locale,
	MemoryCategory,
	MemoryRetriever,
	MemoryScopePolicy,
	MemoryStore,
} from "./memory-tool-dependencies";
import { AGGREGATION_OPERATIONS, MEMORY_CATEGORIES, z } from "./memory-tool-dependencies";
import type { LlmClient } from "../../model/llm-client-types";
import type { LlmRoutingConfig } from "../../../config/plugin-config-mode-schema";





const TOOL_CATEGORY_INPUTS = [...MEMORY_CATEGORIES] as const;
const toolCategoryInputSchema = z.enum(TOOL_CATEGORY_INPUTS);

export const recallParamsSchema: z.ZodType<
	{
		query: string;
		external_reference?: string | undefined;
		external_reference_visibility?: "public" | "private" | undefined;
		top_k?: number | undefined;
		min_score?: number | undefined;
		scope?: string | undefined;
		category?: MemoryCategory | undefined;
		include_metadata?: boolean | undefined;
		include_history?: boolean | undefined;
		include_refused?: boolean | undefined;
		token_budget?: number | undefined;
		aggregation?: AggregationQuery | undefined;
	},
	unknown
> = z.object({
	query: z.string().min(1),
	external_reference: z.string().optional(),
	external_reference_visibility: z.enum(["public", "private"]).optional(),
	top_k: z.number().int().optional(),
	min_score: z.number().optional(),
	scope: z.string().optional(),
	category: toolCategoryInputSchema.optional(),
	include_metadata: z.boolean().optional(),
	include_history: z.boolean().optional(),
	include_refused: z.boolean().optional(),
	token_budget: z.number().int().optional(),
	aggregation: z
		.object({
			operation: z.enum(AGGREGATION_OPERATIONS),
			terms: z.array(z.string().trim().min(1).max(128)).min(1).max(8),
		})
		.strict()
		.optional(),
});
export const storeParamsSchema: z.ZodType<
	{
		content: string;
		category?: MemoryCategory | undefined;
		scope?: string | undefined;
		importance?: number | undefined;
		metadata?: Record<string, unknown> | undefined;
	},
	unknown
> = z.object({
	content: z.string().min(1),
	category: toolCategoryInputSchema.optional(),
	scope: z.string().optional(),
	importance: z.number().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});
export const forgetParamsSchema: z.ZodType<
	{
		id?: string | undefined;
		query?: string | undefined;
		suppress_key?: { subject: string; attribute: string } | undefined;
		suppress_content?: string | undefined;
		scope?: string | undefined;
		min_score?: number | undefined;
		max_delete?: number | undefined;
		confirm?: boolean | undefined;
	},
	unknown
> = z
	.object({
		id: z.string().trim().min(1).optional(),
		query: z.string().trim().min(1).optional(),
		suppress_key: z
			.object({ subject: z.string().trim().min(1), attribute: z.string().trim().min(1) })
			.strict()
			.optional(),
		suppress_content: z.string().min(1).optional(),
		scope: z.string().optional(),
		min_score: z.number().optional(),
		max_delete: z.number().int().positive().optional(),
		confirm: z.boolean().optional(),
	})
	.superRefine((value, context) => {
		const actionCount = [value.id, value.query, value.suppress_key, value.suppress_content].filter(
			Boolean,
		).length;
		if (actionCount !== 1) {
			context.addIssue({
				code: "custom",
				message: "Exactly one forget action is required",
			});
		}
		if ((value.suppress_key || value.suppress_content) && !value.scope?.trim()) {
			context.addIssue({ code: "custom", message: "Suppression requires scope", path: ["scope"] });
		}
	});
export const updateParamsSchema: z.ZodType<
	{
		id: string;
		text?: string | undefined;
		category?: MemoryCategory | undefined;
		importance?: number | undefined;
		metadata?: Record<string, unknown> | undefined;
		timestamp?: number | undefined;
	},
	unknown
> = z
	.object({
		id: z.string().min(1),
		text: z.string().trim().min(1).optional(),
		category: toolCategoryInputSchema.optional(),
		importance: z.number().optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		timestamp: z.number().int().nonnegative().optional(),
	})
	.refine(
		(value) =>
			value.text !== undefined ||
			value.category !== undefined ||
			value.importance !== undefined ||
			value.metadata !== undefined ||
			value.timestamp !== undefined,
		{ message: "At least one update field is required" },
	);
export const statsParamsSchema: z.ZodType<{ scope?: string | undefined }, unknown> =
	z.object({ scope: z.string().optional() });
export const listParamsSchema: z.ZodType<
	{
		scope?: string | undefined;
		category?: MemoryCategory | undefined;
		limit?: number | undefined;
		offset?: number | undefined;
		importance_min?: number | undefined;
	},
	unknown
> = z.object({
	scope: z.string().optional(),
	category: toolCategoryInputSchema.optional(),
	limit: z.number().int().optional(),
	offset: z.number().int().optional(),
	importance_min: z.number().optional(),
});

export interface ToolContext {
	recallSession?: {
		sessionId: string;
		turn: number;
		history: Map<string, Map<string, number>>;
	};
	retriever: MemoryRetriever;
	store: MemoryStore;
	scopePolicy: MemoryScopePolicy;
	embedder: Embedder;
	agentId?: string;
	stateDir: string;
	workspaceDir?: string;
	selfImprovementEnabled?: boolean;
	language?: Locale;
	sessionTimestamp?: number;
	sessionKey?: string;
	sessionTimezone?: string;
	/**
	 * Invalidates the reflection slice cache (TTL-bounded, built by the
	 * memoryReflection strategy). Set only when that strategy is active; the
	 * reflection-resolve tool calls it so a freshly resolved item stops being
	 * injected before the cache would otherwise expire.
	 */
	clearReflectionSliceCache?: () => void;
	/**
	 * Mode-routed LLM client for manual profile stores, built from the
	 * deployment config at registration. Absent (or routed off per request)
	 * means the profile writer's deterministic fallbacks run.
	 */
	profileToolLlm?: LlmClient;
	/** Product-mode routing slice; gates the profile conflict scan. */
	llmRouting?: LlmRoutingConfig;
	/**
	 * The host operator (the contract's `scope.host.systemCaller`), whose repairs write with
	 * offline-family authority the way maintenance does; a skin or agent never carries this.
	 */
	systemCaller?: boolean;
}

export type ToolResult = {
	isError?: boolean;
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};
