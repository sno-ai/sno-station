import { z } from "zod";
import { createLogger } from "@snoai/utils/logger";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from "../src/engine/i18n/locales";

const log = createLogger("sno-station-mem:registration-routing");

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
> = z.preprocess((value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const routing = { ...value };
	if ("agentNative" in routing) {
		delete routing.agentNative;
		log.warn("Ignored agentNative from registration", undefined, {
			event_name: "memory.registration.agent_native_ignored", file: "packages/memory/config/plugin-config-mode-schema.ts",
			function: "llmRoutingConfigSchema", site_id: "plugin-config-mode-schema.routing.agentNative",
		});
	}
	if ("remEnhanced" in routing) {
		delete routing.remEnhanced;
		log.warn("Ignored remEnhanced from registration", undefined, {
			event_name: "memory.registration.rem_enhanced_ignored", file: "packages/memory/config/plugin-config-mode-schema.ts",
			function: "llmRoutingConfigSchema", site_id: "plugin-config-mode-schema.routing.remEnhanced",
		});
	}
	return routing;
}, z
	.object({
		mode: z.enum(PRODUCT_MODES),
		language: z.enum(SUPPORTED_LOCALES).default(DEFAULT_LOCALE),
	})
	.strict());

export type LlmRoutingConfigInput = {
	mode: ProductMode;
	language?: unknown;
};
