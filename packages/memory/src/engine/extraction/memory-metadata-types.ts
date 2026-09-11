/** @file memory-metadata-types.ts
 * @purpose Defines typed insight metadata contracts via Zod discriminated union.
 * @boundary Metadata shape declarations only.
 */

import { z } from "zod";
import { MEMORY_CATEGORIES } from "../shared/types";
import type { MemoryCategory } from "../shared/types";

export type EntryLike = {
	text?: string;
	category?: MemoryCategory;
	importance?: number;
	timestamp?: number;
	metadata?: string;
};

export interface MemoryRelation {
	/** Predicate / edge label (e.g. "friend_of", "owns", "lives_in"). */
	type: string;
	/** Object — memory id when known, otherwise canonical-name slug. */
	targetId: string;
	/**
	 * Optional explicit subject. When omitted, the parent memory's
	 * `fact_key` is the implicit subject. Set explicitly when the
	 * relation describes a triple between two third parties (e.g. an
	 * `event` candidate that involves two entities).
	 */
	source?: string;
}

const memoryCategory: z.ZodEnum<{ episodic: "episodic"; profile: "profile"; persona: "persona"; lesson: "lesson"; summary: "summary"; state: "state" }> =
	z.enum(MEMORY_CATEGORIES);
const memoryTier: z.ZodEnum<{ core: "core"; working: "working"; peripheral: "peripheral" }> = z.enum([
	"core",
	"working",
	"peripheral",
]);
const memoryState: z.ZodEnum<{ pending: "pending"; confirmed: "confirmed"; archived: "archived" }> = z.enum([
	"pending",
	"confirmed",
	"archived",
]);
const memorySource: z.ZodEnum<{ manual: "manual"; "ambient-learning": "ambient-learning"; agent_end: "agent_end"; reflection: "reflection"; "session-summary": "session-summary"; legacy: "legacy" }> = z.enum(["manual", "ambient-learning", "agent_end", "reflection", "session-summary", "legacy"]);
const memoryLayer: z.ZodEnum<{ durable: "durable"; working: "working"; reflection: "reflection"; archive: "archive" }> = z.enum([
	"durable",
	"working",
	"reflection",
	"archive",
]);

export type MemoryState = z.infer<typeof memoryState>;
export type MemoryLayer = z.infer<typeof memoryLayer>;
export type MemorySource = z.infer<typeof memorySource>;

const memoryRelation = z.object({
	type: z.string(),
	targetId: z.string(),
	source: z.string().optional(),
});
type ActiveTaskStatusMetadata = "active" | "completed" | "removed";
type ActiveTaskOriginMetadata =
	| {
			kind: "runtime";
			source_id: string;
			normalized_description: string;
	  }
	| {
			kind: "legacy";
			omnibus_row_id: string;
			item_index: number;
			legacy_item_id: string;
	  };
type ActiveTaskLifecycleMetadata = {
	from: ActiveTaskStatusMetadata | null;
	to: ActiveTaskStatusMetadata;
	at: number;
	source_id: string;
};

const activeTaskStatus: z.ZodEnum<{ active: "active"; completed: "completed"; removed: "removed" }> = z.enum([
	"active",
	"completed",
	"removed",
]);
const activeTaskOrigin: z.ZodType<ActiveTaskOriginMetadata> = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("runtime"),
		source_id: z.string().min(1),
		normalized_description: z.string().min(1),
	}),
	z.object({
		kind: z.literal("legacy"),
		omnibus_row_id: z.string().min(1),
		item_index: z.number().int().nonnegative(),
		legacy_item_id: z.string().min(1),
	}),
]);
const activeTaskLifecycleEvent: z.ZodType<ActiveTaskLifecycleMetadata> = z.object({
	from: activeTaskStatus.nullable(),
	to: activeTaskStatus,
	at: z.number(),
	source_id: z.string().min(1),
});

type MemoryMetadataCommonShape = {
	l0_abstract: z.ZodString;
	l1_overview: z.ZodString;
	l2_content: z.ZodString;
	tier: typeof memoryTier;
	access_count: z.ZodNumber;
	confidence: z.ZodNumber;
	last_accessed_at: z.ZodNumber;
	asserted_at: z.ZodNumber;
	valid_from: z.ZodNumber;
	invalidated_at: z.ZodOptional<z.ZodNumber>;
	fact_key: z.ZodOptional<z.ZodString>;
	supersedes: z.ZodOptional<z.ZodString>;
	superseded_by: z.ZodOptional<z.ZodString>;
	relations: z.ZodOptional<
		z.ZodArray<
			z.ZodObject<{
				type: z.ZodString;
				targetId: z.ZodString;
				source: z.ZodOptional<z.ZodString>;
			}>
		>
	>;
	source_session: z.ZodOptional<z.ZodString>;
	state: typeof memoryState;
	source: typeof memorySource;
	memory_layer: typeof memoryLayer;
	injected_count: z.ZodNumber;
	last_injected_at: z.ZodOptional<z.ZodNumber>;
	last_confirmed_use_at: z.ZodOptional<z.ZodNumber>;
	bad_recall_count: z.ZodNumber;
	suppressed_until_turn: z.ZodNumber;
	canonical_id: z.ZodOptional<z.ZodString>;
	memory_temporal_type: z.ZodOptional<z.ZodEnum<{ static: "static"; dynamic: "dynamic" }>>;
	temporal_resolution_status: z.ZodOptional<z.ZodEnum<{ resolved: "resolved"; unresolved: "unresolved"; static: "static" }>>;
	temporal_phrase: z.ZodOptional<z.ZodString>;
	valid_until: z.ZodOptional<z.ZodNumber>;
	merge_lineage: z.ZodOptional<z.ZodArray<z.ZodString>>;
};

const memoryMetadataBase: z.ZodObject<
	MemoryMetadataCommonShape & {
		kind: typeof memoryCategory;
		memory_category: typeof memoryCategory;
	}
> = z.object({
	kind: memoryCategory,
	l0_abstract: z.string(),
	l1_overview: z.string(),
	l2_content: z.string(),
	memory_category: memoryCategory,
	tier: memoryTier,
	access_count: z.number(),
	confidence: z.number(),
	last_accessed_at: z.number(),
	asserted_at: z.number(),
	valid_from: z.number(),
	invalidated_at: z.number().optional(),
	fact_key: z.string().optional(),
	supersedes: z.string().optional(),
	superseded_by: z.string().optional(),
	relations: z.array(memoryRelation).optional(),
	source_session: z.string().optional(),
	state: memoryState,
	source: memorySource,
	memory_layer: memoryLayer,
	injected_count: z.number(),
	last_injected_at: z.number().optional(),
	last_confirmed_use_at: z.number().optional(),
	bad_recall_count: z.number(),
	suppressed_until_turn: z.number(),
	canonical_id: z.string().optional(),
	memory_temporal_type: z.enum(["static", "dynamic"]).optional(),
	temporal_resolution_status: z.enum(["resolved", "unresolved", "static"]).optional(),
	temporal_phrase: z.string().optional(),
	valid_until: z.number().optional(),
	merge_lineage: z.array(z.string()).optional(),
});

const episodicMetadata: z.ZodObject<
	Omit<MemoryMetadataCommonShape, "valid_from"> & {
		valid_from: z.ZodOptional<z.ZodNumber>;
		kind: z.ZodLiteral<"episodic">;
		memory_category: z.ZodLiteral<"episodic">;
		event_at: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
		entity_kind: z.ZodOptional<z.ZodString>;
	},
	z.core.$catchall<z.ZodUnknown>
> = memoryMetadataBase
	.extend({
		kind: z.literal("episodic"),
		memory_category: z.literal("episodic"),
		valid_from: z.number().optional(),
		event_at: z.union([z.string(), z.number()]).optional(),
		entity_kind: z.string().optional(),
	})
	.catchall(z.unknown());

const profileMetadata: z.ZodObject<
	MemoryMetadataCommonShape & {
		kind: z.ZodLiteral<"profile">;
		memory_category: z.ZodLiteral<"profile">;
		section_name: z.ZodString;
		rawTopicPhrase: z.ZodOptional<z.ZodString>;
		active_task_kind: z.ZodOptional<z.ZodEnum<{ task: "task"; projection: "projection" }>>;
		active_task_id: z.ZodOptional<z.ZodString>;
		active_task_origin: z.ZodOptional<typeof activeTaskOrigin>;
		active_task_status: z.ZodOptional<typeof activeTaskStatus>;
		active_task_created_at: z.ZodOptional<z.ZodNumber>;
		active_task_transitioned_at: z.ZodOptional<z.ZodNumber>;
		active_task_lifecycle: z.ZodOptional<z.ZodArray<typeof activeTaskLifecycleEvent>>;
		active_task_ids: z.ZodOptional<z.ZodArray<z.ZodString>>;
		active_task_titles: z.ZodOptional<z.ZodArray<z.ZodString>>;
	},
	z.core.$catchall<z.ZodUnknown>
> = memoryMetadataBase
	.extend({
		kind: z.literal("profile"),
		memory_category: z.literal("profile"),
		section_name: z.string().min(1),
		rawTopicPhrase: z.string().optional(),
		active_task_kind: z.enum(["task", "projection"]).optional(),
		active_task_id: z.string().min(1).optional(),
		active_task_origin: activeTaskOrigin.optional(),
		active_task_status: activeTaskStatus.optional(),
		active_task_created_at: z.number().optional(),
		active_task_transitioned_at: z.number().optional(),
		active_task_lifecycle: z.array(activeTaskLifecycleEvent).optional(),
		active_task_ids: z.array(z.string().min(1)).optional(),
		active_task_titles: z.array(z.string()).optional(),
	})
	.catchall(z.unknown());

const personaMetadata: z.ZodObject<
	MemoryMetadataCommonShape & {
		kind: z.ZodLiteral<"persona">;
		memory_category: z.ZodLiteral<"persona">;
		section_name: z.ZodString;
	},
	z.core.$catchall<z.ZodUnknown>
> = memoryMetadataBase
	.extend({
		kind: z.literal("persona"),
		memory_category: z.literal("persona"),
		section_name: z.string().min(1),
	})
	.catchall(z.unknown());

const lessonMetadata: z.ZodObject<
	MemoryMetadataCommonShape & {
		kind: z.ZodLiteral<"lesson">;
		memory_category: z.ZodLiteral<"lesson">;
		anti_pattern_signature: z.ZodString;
	},
	z.core.$catchall<z.ZodUnknown>
> = memoryMetadataBase
	.extend({
		kind: z.literal("lesson"),
		memory_category: z.literal("lesson"),
		anti_pattern_signature: z.string().min(1),
	})
	.catchall(z.unknown());

const summaryMetadata: z.ZodObject<
	MemoryMetadataCommonShape & {
		kind: z.ZodLiteral<"summary">;
		memory_category: z.ZodLiteral<"summary">;
		children_ids: z.ZodArray<z.ZodString>;
		depth: z.ZodNumber;
	},
	z.core.$catchall<z.ZodUnknown>
> = memoryMetadataBase
	.extend({
		kind: z.literal("summary"),
		memory_category: z.literal("summary"),
		children_ids: z.array(z.string()),
		depth: z.number().int().min(1),
	})
	.catchall(z.unknown());

const stateMetadata: z.ZodObject<
	MemoryMetadataCommonShape & {
		kind: z.ZodLiteral<"state">;
		memory_category: z.ZodLiteral<"state">;
	},
	z.core.$catchall<z.ZodUnknown>
> = memoryMetadataBase
	.extend({
		kind: z.literal("state"),
		memory_category: z.literal("state"),
	})
	.catchall(z.unknown());

export const memoryMetadata: z.ZodDiscriminatedUnion<
	[
		typeof episodicMetadata,
		typeof profileMetadata,
		typeof personaMetadata,
		typeof lessonMetadata,
		typeof summaryMetadata,
		typeof stateMetadata,
	],
	"kind"
> = z.discriminatedUnion("kind", [
	episodicMetadata,
	profileMetadata,
	personaMetadata,
	lessonMetadata,
	summaryMetadata,
	stateMetadata,
]);

export type InsightMetadata = z.infer<typeof memoryMetadata>;

export type InsightMetadataPatch = Partial<z.input<typeof memoryMetadataBase>> & Record<string, unknown>;

/**
 * Flat inferred type of the shared insight-metadata base (all category-agnostic
 * fields). This is the single source the loose `MemoryMetadata` structural view
 * in `@/shared/types` derives its insight fields from — so a new field on the
 * Zod schema (or a changed enum) propagates without hand-copying. The 5 category
 * variants add a few discriminant-gated extras (event_at, entity_kind,
 * section_name, anti_pattern_signature, children_ids, depth) that a
 * discriminated union cannot be flattened into automatically; `MemoryMetadata`
 * mirrors those six by hand. A compile-time assignability guard is not viable
 * because the variants use `.catchall(z.unknown())`, whose index signature
 * makes every storage-only field on `MemoryMetadata` resolve to `unknown`; the
 * base-field bulk is instead kept in sync structurally via the `Partial<…>` it
 * feeds, and the six extras are the only hand-maintained mirror.
 */
export type MemoryMetadataBaseFields = z.infer<typeof memoryMetadataBase>;

export {
	memoryMetadataBase,
	episodicMetadata,
	profileMetadata,
	personaMetadata,
	lessonMetadata,
	summaryMetadata,
	stateMetadata,
	memoryCategory as memoryCategorySchema,
	memoryTier as memoryTierSchema,
	memoryState as memoryStateSchema,
	memorySource as memorySourceSchema,
	memoryLayer as memoryLayerSchema,
};
