import { z } from "zod";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from "../src/engine/i18n/locales";

/**
 * Product LLM modes, tier-ordered: Local First (selected calls on host) → Agent
 * Native (every call borrows the host agent's model) → REM Enhanced (top
 * tier: SNO-REM-MEM serves the LoRA-covered calls, the host model covers
 * the rest).
 */
export const PRODUCT_MODES = ["local-first", "agent-native", "rem-enhanced"] as const;

export type ProductMode = (typeof PRODUCT_MODES)[number];

export const DEFAULT_MODEL_MODE: ProductMode = "agent-native";

/** Occasions select system messages; call ids select destinations. */
export const LLM_OCCASIONS = [
	"memoryExtract",
	"profileSectionMerge",
	"profileActiveTaskClassify",
	"conflictAdjudication",
	"summaryBuild",
	"dateResolution",
] as const;

export type LlmOccasion = (typeof LLM_OCCASIONS)[number];

export const remEnhancedConfigSchema: z.ZodType<{ trigger: { tick: boolean } }, unknown> = z
	.object({
		trigger: z.object({ tick: z.boolean().default(true) }).strict().prefault({}),
	})
	.strict()
	.prefault({});

/** The schema-defaulted config slice the request-time route resolver consumes. */
export type LlmRoutingConfig = {
	mode: ProductMode;
	language: Locale;
};

export const llmRoutingConfigSchema: z.ZodType<
	LlmRoutingConfig,
	unknown
> = z
	.object({
		mode: z.enum(PRODUCT_MODES),
		language: z.enum(SUPPORTED_LOCALES).default(DEFAULT_LOCALE),
	})
	.strict();

export type LlmRoutingConfigInput = {
	mode: ProductMode;
	language?: unknown;
};
