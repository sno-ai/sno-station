import { z } from "zod";
import { createLogger } from "@snoai/utils/logger";

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
	type AgentNativeFlavor,
	agentNativeConfigSchema,
	type LlmOccasionTiers,
	DEFAULT_MODEL_MODE,
	PRODUCT_MODES,
	type ProductMode,
	remEnhancedConfigSchema,
} from "./plugin-config-mode-schema";
import { observeConfigSchema } from "./plugin-config-observe-schema";
import { retrievalConfigSchema } from "./plugin-config-retrieval-schema";
import { SESSION_STRATEGIES } from "./session-strategy";

const log = createLogger("sno-station-mem:plugin-config");

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

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/**
 * Which reranker a mode gets when the operator did not name one. Keyed on every
 * product mode, so a mode added later cannot silently inherit another's ranker.
 *
 * `cross-encoder` needs `retrieval.rerankApiKey` and a reachable endpoint. A
 * keyless config keeps the local cosine blend so self-upgrade can load configs
 * written before reranker selection became explicit.
 */
const MODE_RERANK = {
	"local-first": "lightweight",
	"agent-native": "cross-encoder",
	"rem-enhanced": "cross-encoder",
} as const satisfies Record<ProductMode, "cross-encoder" | "lightweight">;

function isProductMode(value: unknown): value is ProductMode {
	return typeof value === "string" && (PRODUCT_MODES as readonly string[]).includes(value);
}

/**
 * Applies the mode's reranker to the RAW config. An operator who wrote
 * `retrieval.rerank` keeps it in every mode; only an absent value is filled, which
 * is the same rule the mode itself follows — a defaulted value is never an
 * explicit choice.
 */
function withModeRerank(
	cfg: Record<string, unknown>,
	mode: ProductMode,
): Record<string, unknown> {
	const retrieval = asPlainObject(cfg.retrieval);
	// A present-but-unusable `retrieval` is left exactly as written so the schema
	// reports it, rather than being replaced by a synthesized object.
	if (cfg.retrieval !== undefined && retrieval === undefined) return cfg;
	if (retrieval?.rerank !== undefined) return cfg;
	const rerank = retrieval?.rerankApiKey === undefined ? "lightweight" : MODE_RERANK[mode];
	return { ...cfg, retrieval: { ...retrieval, rerank } };
}

/**
 * Product-mode normalization over the RAW config, before Zod defaults fill
 * in (defaulted values must never count as explicit route configuration).
 *
 * - Explicit `mode` is the sole behavior input.
 * - `local-first` with LLM route config remains an invalid contradiction.
 * - LLM route config without `mode` fails instead of changing behavior silently.
 * - True zero-config defaults to `agent-native`.
 */
function normalizeProductMode(raw: unknown): unknown {
	const rawConfig = asPlainObject(raw);
	if (rawConfig === undefined) return raw;
	const cfg = { ...rawConfig };
	if ("llmGates" in cfg) {
		delete cfg.llmGates;
		log.debug("sno-station-mem: stripped retired llmGates config key", undefined, {
			event_name: "sno_station_mem.plugin-config-schema.sno.station.mem.stripped.retired.llmgates.config.key",
			file: "packages/sno-station-mem/config/plugin-config-schema.ts",
			function: "normalizeProductMode",
			site_id: "plugin-config-schema.normalizeProductMode.834ccfc110",
		});
	}
	if (cfg.mode !== undefined) {
		// An unrecognized mode is left for the enum to reject; filling a reranker for
		// it would be inventing a route for a mode that does not exist.
		return isProductMode(cfg.mode) ? withModeRerank(cfg, cfg.mode) : cfg;
	}
	return withModeRerank({ ...cfg, mode: DEFAULT_MODEL_MODE }, DEFAULT_MODEL_MODE);
}

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
		memoryTelemetry: { enabled: boolean; currentKeyVersion: number };
		mode: (typeof PRODUCT_MODES)[number];
		remOperations: (typeof REM_OPERATIONS)[number][];
		remEnhanced: { occasions: LlmOccasionTiers; trigger?: { tick: boolean } };
		agentNative: { flavor: AgentNativeFlavor };
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
		autoRecallMinLength: z.number().int().min(1).max(200).default(2),
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
			})
			.prefault({}),
		/**
		 * Product LLM mode, tier-ordered: local-first → agent-native →
		 * rem-enhanced. A true bare config defaults to agent-native; model route
		 * config requires an explicit product mode.
		 */
		mode: z.enum(PRODUCT_MODES).default(DEFAULT_MODEL_MODE),
		remOperations: z.array(z.enum(REM_OPERATIONS)).min(1).max(2).default([...REM_OPERATIONS]),
		remEnhanced: remEnhancedConfigSchema,
		agentNative: agentNativeConfigSchema,
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
	.strict()
	.transform((cfg) => {
		if (cfg.sessionStrategy !== "systemSessionMemory") return cfg;
		if (cfg.sessionMemory.enabled === false) {
			return { ...cfg, sessionStrategy: "none" as const };
		}
		return cfg;
	});

function requireRerankKey(
	cfg: PluginConfigOutput,
	ctx: z.RefinementCtx,
): PluginConfigOutput {
	if (cfg.retrieval.rerank === "cross-encoder" && !cfg.retrieval.rerankApiKey?.trim()) {
		log.error("memory.rerank.key.missing", { cause: "missing-rerank-key" }, {
			event_name: "memory.rerank.key.missing", file: "packages/sno-station-mem/config/plugin-config-schema.ts",
			function: "requireRerankKey", site_id: "memory.rerank.key.missing",
		});
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["retrieval", "rerankApiKey"],
			message: "retrieval.rerankApiKey is required for cross-encoder reranking",
		});
	}
	return cfg;
}

export const pluginConfigSchema: z.ZodType<PluginConfigOutput, unknown> = z
	.unknown()
	.transform(normalizeProductMode)
	.pipe(pluginConfigBaseSchema)
	.transform(requireRerankKey);

export type PluginConfig = z.output<typeof pluginConfigSchema>;
