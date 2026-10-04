import { z } from "zod";

import {
	DEFAULT_AUTO_RECALL_MAX_QUERY_LENGTH,
	DEFAULT_SCOPE,
	recallLifecycleSchema,
} from "./index";
import { SUPPORTED_LOCALES } from "../src/engine/i18n/locales";
import { embeddingConfigSchema } from "./plugin-config-embedding-schema";
import {
	extractionConfigSchema,
	memoryReflectionConfigSchema,
	selfImprovementConfigSchema,
	sessionMemoryConfigSchema,
} from "./plugin-config-feature-schema";
import {
	DEFAULT_MODEL_MODE,
	PRODUCT_MODES,
	modelCallsConfigSchema,
	remEnhancedConfigSchema,
} from "./plugin-config-mode-schema";
import { observeConfigSchema } from "./plugin-config-observe-schema";
import { retrievalConfigSchema } from "./plugin-config-retrieval-schema";
import { SESSION_STRATEGIES } from "./session-strategy";
import type { Settings } from "./settings";


const scopesConfigSchema = z
	.object({
		default: z.string().default(DEFAULT_SCOPE),
		definitions: z
			.record(
				z.string(),
				z.object({
					description: z.string().optional(),
					metadata: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.prefault({
				global: { description: "Shared knowledge across all agents" },
			}),
		agentAccess: z.record(z.string(), z.array(z.string())).default({}),
	})
	.prefault({});

const providerConfigSchema = z
	.object({
		userId: z.string().trim().optional(),
	})
	.strict()
	.prefault({});

const ONBOARDING_PROFILES = ["local-active", "capture-only", "manual-only", "custom"] as const;
const REM_OPERATIONS = ["rem-replace", "rem-update"] as const;

type PluginConfigOutput = {
		embedding: z.output<typeof embeddingConfigSchema>;
		observe: z.output<typeof observeConfigSchema>;
		dbPath?: string | undefined;
		provider: { userId?: string | undefined };
		ambientLearning: boolean;
		autoRecall: boolean;
		autoRecallMinLength: number;
		autoRecallMinRepeated: number;
		autoRecallMaxQueryLength: number;
		autoRecallTimeoutMs: number;
		autoRecallIncludeAgents: string[];
		autoRecallExcludeAgents: string[];
		captureAssistant: boolean;
		retrieval: z.output<typeof retrievalConfigSchema>;
		scopes: {
			default: string;
			definitions: Record<
				string,
				{ description?: string | undefined; metadata?: Record<string, unknown> | undefined }
			>;
			agentAccess: Record<string, string[]>;
		};
		enableManagementTools: boolean;
		language?: (typeof SUPPORTED_LOCALES)[number] | undefined;
		sessionStrategy: (typeof SESSION_STRATEGIES)[number];
		sessionMemory: z.output<typeof sessionMemoryConfigSchema>;
		compression?: { enabled: boolean } | undefined;
		selfImprovement: z.output<typeof selfImprovementConfigSchema>;
		extraction: z.output<typeof extractionConfigSchema>;
		memoryReflection: z.output<typeof memoryReflectionConfigSchema>;
		recallLifecycle: z.output<typeof recallLifecycleSchema>;
		memoryTelemetry: { enabled: boolean; currentKeyVersion: number; key: string; historicKeys: string[] };
		debugContent: boolean;
		mode: (typeof PRODUCT_MODES)[number];
		modelCalls?: Settings["modelCalls"];
		remOperations: (typeof REM_OPERATIONS)[number][];
		remEnhanced?: { trigger: { tick: boolean } };
		onboarding?:
			| { version: number; completedAt: string; profile: (typeof ONBOARDING_PROFILES)[number] }
			| undefined;
};

const pluginConfigBaseSchema = z
	.object({
		embedding: embeddingConfigSchema,
		observe: observeConfigSchema,
		dbPath: z.string().optional(),
		provider: providerConfigSchema,
		ambientLearning: z.boolean().default(true),
		autoRecall: z.boolean().default(false),
		/** Minimum query length for auto-recall to fire (default: 15) */
		// A mechanical floor only: do not search on nothing. It was 15, which meant a bare proper
		// noun got no memory at all and nothing said a search had never run — measured 2026-08-19,
		// "Charlie Parker" (14 chars), "Berlin move" and "my budget" all returned without searching,
		// while "Lisbon?" searched because of one question mark. Retrieval here is a local SQLite
		// plus local-embedding search; it is cheap, and relevance scoring is what should decide
		// whether anything comes back. The knob stays so an operator can raise it deliberately.
		autoRecallMinLength: z.number().int().min(0).max(200).default(2),
		/** Skip re-injecting a memory if it was shown within the last N turns (0 = no dedup) */
		autoRecallMinRepeated: z.number().int().min(0).max(100).default(0),
		/** Maximum character length of auto-recall query before truncation */
		autoRecallMaxQueryLength: z
			.number()
			.int()
			.min(100)
			.max(10000)
			.default(DEFAULT_AUTO_RECALL_MAX_QUERY_LENGTH),
		/** Timeout in ms for the entire auto-recall pipeline (embed + search + rerank) */
		autoRecallTimeoutMs: z.number().int().min(500).max(60000).default(5000),
		/**
		 * Whitelist: if non-empty, ONLY these agentIds receive auto-recall injection.
		 * Takes precedence over autoRecallExcludeAgents when both are set. Entries
		 * are trimmed; empty strings are dropped.
		 */
		autoRecallIncludeAgents: z
			.array(z.string().transform((s) => s.trim()))
			.transform((arr) => arr.filter((s) => s.length > 0))
			.default([]),
		/**
		 * Blocklist: agentIds excluded from auto-recall injection. The implicit
		 * "main" fallback used when hook context lacks a parseable agent identity
		 * is evaluated against this blocklist too.
		 */
		autoRecallExcludeAgents: z
			.array(z.string().transform((s) => s.trim()))
			.transform((arr) => arr.filter((s) => s.length > 0))
			.default([]),
		captureAssistant: z.boolean().default(false),
		retrieval: retrievalConfigSchema,
		scopes: scopesConfigSchema,
		enableManagementTools: z.boolean().default(false),
		/**
		 * Optional user-facing language for tool descriptions and other static
		 * locale-bound surface that cannot be derived from query text.
		 */
		language: z.enum(SUPPORTED_LOCALES).optional(),
		sessionStrategy: z.enum(SESSION_STRATEGIES).default("systemSessionMemory"),
		sessionMemory: sessionMemoryConfigSchema,
		compression: z.object({ enabled: z.boolean().default(false) }).optional(),
		selfImprovement: selfImprovementConfigSchema,
		extraction: extractionConfigSchema,
		memoryReflection: memoryReflectionConfigSchema,
		/**
		 * Phase 0 lifecycle stub channel. All flags default false; enabling any
		 * lights up its dedicated wire site without altering the others.
		 */
		recallLifecycle: recallLifecycleSchema,
		memoryTelemetry: z
			.object({
				enabled: z.boolean().default(true),
				currentKeyVersion: z.number().int().positive().default(1),
				key: z.string().default(""),
				historicKeys: z.array(z.string()).default([]),
			})
			.prefault({}),
		debugContent: z.boolean().default(false),
		/**
		 * Product LLM mode, tier-ordered: local-first → agent-native →
		 * rem-enhanced. A true bare config defaults to agent-native; model route
		 * config requires an explicit product mode.
		 */
		mode: z.enum(PRODUCT_MODES).default(DEFAULT_MODEL_MODE),
		modelCalls: modelCallsConfigSchema,
		remOperations: z.array(z.enum(REM_OPERATIONS)).min(1).max(2).default([...REM_OPERATIONS]),
		remEnhanced: remEnhancedConfigSchema,
		/**
		 * Installer completion marker (bin/_onboarding-core.js writes it into
		 * this same config block). The runtime never reads it, but the strict
		 * schema must accept it or every installer-onboarded config fails to
		 * load.
		 */
		onboarding: z
			.object({
				version: z.number().int().positive(),
				completedAt: z.string(),
				profile: z.enum(ONBOARDING_PROFILES),
			})
			.strict()
			.optional(),
	})
	.strict();

export const pluginConfigSchema: z.ZodType<PluginConfigOutput, unknown> = pluginConfigBaseSchema;

export type PluginConfig = z.output<typeof pluginConfigSchema>;
