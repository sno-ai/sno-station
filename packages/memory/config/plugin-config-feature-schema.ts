import { FIXED_MEMORY_SNO_AI_EXTRACT } from "../src/model/signed-registry-constants";
import { z } from "zod";
import { createLogger } from "@snoai/utils/logger";

import {
	DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES,
	DEFAULT_REFLECTION_MAX_INPUT_CHARS,
	DEFAULT_REFLECTION_MESSAGE_COUNT,
	DEFAULT_REFLECTION_TIMEOUT_MS,
	DEFAULT_SESSION_MESSAGE_COUNT,
} from "./index";
import { LLM_PRESETS } from "../src/model/llm-client-types";

export const sessionMemoryConfigSchema: z.ZodType<
	{ enabled: boolean; messageCount: number },
	unknown
> = z
	.object({
		enabled: z.boolean().default(true),
		messageCount: z.number().int().min(1).max(100).default(DEFAULT_SESSION_MESSAGE_COUNT),
	})
	.prefault({});

export const selfImprovementConfigSchema: z.ZodType<
	{
		enabled: boolean;
		beforeResetNote: boolean;
		skipSubagentBootstrap: boolean;
		ensureLearningFiles: boolean;
	},
	unknown
> = z
	.object({
		enabled: z.boolean().default(true),
		beforeResetNote: z.boolean().default(true),
		skipSubagentBootstrap: z.boolean().default(true),
		ensureLearningFiles: z.boolean().default(true),
	})
	.prefault({});

const log = createLogger("sno-station-mem:plugin-config-feature");

/** Presets removed in 0.23; an older plugin config or registration still carries them. */
function replaceRemovedPreset(preset: unknown): unknown {
	if (preset !== "mem_claw/openai_gpt_5_nano" && preset !== "mem_claw/openrouter_auto") return preset;
	log.warn("Replaced removed extraction.llm.preset", { preset }, {
		event_name: "memory.plugin_config.old_preset_replaced", file: "packages/memory/config/plugin-config-feature-schema.ts",
		function: "replaceRemovedPreset", site_id: "plugin-config-feature-schema.replaceRemovedPreset",
	});
	return FIXED_MEMORY_SNO_AI_EXTRACT;
}

export const extractionConfigSchema: z.ZodType<
	{
		llm: {
			preset: (typeof LLM_PRESETS)[number];
			baseURL?: string | undefined;
			apiKey?: string | undefined;
			heliconeApiKey?: string | undefined;
			timeoutMs: number;
		};
	},
	unknown
> = z
	.object({
		llm: z
			.object({
				preset: z.preprocess(replaceRemovedPreset, z.enum(LLM_PRESETS).default(FIXED_MEMORY_SNO_AI_EXTRACT)),
				/** Overrides provider default / env baseURL if set. */
				baseURL: z.string().optional(),
				/** Overrides provider-native env if set. */
				apiKey: z.string().optional(),
				/** Enables Helicone request logging for OpenAI-compatible calls. Defaults to HELICONE_API_KEY env if unset. */
				heliconeApiKey: z.string().optional(),
				timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
		})
			.strict()
			.prefault({}),
	})
	.strict()
	.prefault({});

export const memoryReflectionConfigSchema: z.ZodType<
	{
		messageCount: number;
		maxInputChars: number;
		timeoutMs: number;
		errorReminderMaxEntries: number;
		dedupeErrorSignals: boolean;
		injectMode: "inheritance+derived" | "inheritance-only" | "none";
		storeToDb: boolean;
		injectIntoPrompt: boolean;
		agentId?: string | undefined;
	},
	unknown
> = z
	.object({
		messageCount: z.number().int().min(1).max(500).default(DEFAULT_REFLECTION_MESSAGE_COUNT),
		maxInputChars: z
			.number()
			.int()
			.min(1000)
			.max(200_000)
			.default(DEFAULT_REFLECTION_MAX_INPUT_CHARS),
		timeoutMs: z.number().int().min(5000).max(300_000).default(DEFAULT_REFLECTION_TIMEOUT_MS),
		errorReminderMaxEntries: z
			.number()
			.int()
			.min(0)
			.max(50)
			.default(DEFAULT_REFLECTION_ERROR_REMINDER_MAX_ENTRIES),
		dedupeErrorSignals: z.boolean().default(true),
		injectMode: z
			.enum(["inheritance+derived", "inheritance-only", "none"])
			.default("inheritance+derived"),
		storeToDb: z.boolean().default(true),
		/**
		 * Inject reflection invariants/derived slices into agent prompts at recall
		 * time. Default `false` until the LoCoMo paired-arm gate validates eval-
		 * neutrality (PRD §4.4.1, §5 eval gate). Permanent kill switch even after
		 * the default flips.
		 */
		injectIntoPrompt: z.boolean().default(false),
		agentId: z.string().optional(),
	})
	.prefault({});
