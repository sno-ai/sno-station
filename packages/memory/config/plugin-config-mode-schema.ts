import { z } from "zod";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from "../src/engine/i18n/locales";

/**
 * Product LLM modes, tier-ordered: Local First (no LLM anywhere) → Agent
 * Native (every call borrows the host agent's model) → REM Enhanced (top
 * tier: SNO-REM-MEM serves the LoRA-covered occasions, the host model covers
 * the rest, adjustable per occasion).
 */
export const PRODUCT_MODES = ["local-first", "agent-native", "rem-enhanced"] as const;

export type ProductMode = (typeof PRODUCT_MODES)[number];

export const DEFAULT_MODEL_MODE: ProductMode = "agent-native";

export const LLM_TIERS = ["snoRemMem", "agent"] as const;

export type LlmTier = (typeof LLM_TIERS)[number];

/**
 * The eight live LLM occasions. One occasion per adapter slot, except
 * profile-merge, whose section-update occasion is a two-call judgment/text
 * pipeline and whose task occasions are mutually exclusive branches.
 */
export const LLM_OCCASIONS = [
	"memoryExtract",
	"dedupDecision",
	"profileSectionMerge",
	"profileActiveTaskClassify",
	"profileActiveTaskMatch",
	"conflictAdjudication",
	"summaryBuild",
	"intentClassifier",
	"dateResolution",
] as const;

export type LlmOccasion = (typeof LLM_OCCASIONS)[number];

export type LlmOccasionTiers = Record<LlmOccasion, LlmTier>;

export const AGENT_NATIVE_FLAVORS = ["subscription", "byok"] as const;

export type AgentNativeFlavor = (typeof AGENT_NATIVE_FLAVORS)[number];

const tierSchema = z.enum(LLM_TIERS);

/**
 * REM Enhanced per-occasion tier switches. Defaults are the v1 release
 * targets: only the LoRA-covered occasions (extraction, conflict
 * adjudication) ride SNO-REM-MEM; everything else rides the host agent's
 * model. Changing a default is a release decision — the switch exists so
 * that change is config, not code.
 */
export const remEnhancedConfigSchema: z.ZodType<
	{ occasions: LlmOccasionTiers; trigger?: { tick: boolean } },
	unknown
> = z
	.object({
		trigger: z.object({ tick: z.boolean().default(true) }).strict().prefault({}),
		occasions: z
			.object({
				memoryExtract: tierSchema.default("snoRemMem"),
				dedupDecision: tierSchema.default("agent"),
				profileSectionMerge: tierSchema.default("agent"),
				profileActiveTaskClassify: tierSchema.default("agent"),
				profileActiveTaskMatch: tierSchema.default("agent"),
				conflictAdjudication: tierSchema.default("snoRemMem"),
				summaryBuild: tierSchema.default("agent"),
				intentClassifier: tierSchema.default("agent"),
				dateResolution: tierSchema.default("agent"),
			})
			.strict()
			.prefault({}),
	})
	.strict()
	.prefault({});

/**
 * Agent Native flavor selects transport only. Subscription borrows the host
 * model over the in-process seam; BYOK uses the user's API-key preset over the
 * ordinary chat transport. Both carry identical occasion-to-tier routing.
 */
export const agentNativeConfigSchema: z.ZodType<
	{ flavor: AgentNativeFlavor },
	unknown
> = z
	.object({
		flavor: z.enum(AGENT_NATIVE_FLAVORS).default("subscription"),
	})
	.strict()
	.prefault({});

/** The schema-defaulted config slice the request-time route resolver consumes. */
export type LlmRoutingConfig = {
	mode: ProductMode;
	remEnhanced: { occasions: LlmOccasionTiers; trigger?: { tick: boolean } };
	agentNative: { flavor: AgentNativeFlavor };
	language: Locale;
};

export const llmRoutingConfigSchema: z.ZodType<
	LlmRoutingConfig,
	unknown
> = z
	.object({
		mode: z.enum(PRODUCT_MODES),
		remEnhanced: remEnhancedConfigSchema,
		agentNative: agentNativeConfigSchema,
		language: z.enum(SUPPORTED_LOCALES).default(DEFAULT_LOCALE),
	})
	.strict();

export type LlmRoutingConfigInput = {
	mode: ProductMode;
	remEnhanced?: unknown;
	agentNative?: unknown;
	language?: unknown;
};
