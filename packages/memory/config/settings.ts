import { LOCAL_EMBEDDING_MODEL_REVISION } from "@snoai/embedder";
import { z } from "zod";
import { CANDIDATE_POOL_SIZE, DEFAULT_SESSION_MESSAGE_COUNT, EMBEDDER_MODEL_DEFAULT } from "./index";
import {
	CODING_SKIN_EXPLICIT_RECALL_LIMIT,
	CODING_SKIN_PROMPT_CONTEXT_MAX_CHARS,
	CODING_SKIN_PROMPT_MIN_CHARS,
	CODING_SKIN_PROMPT_RECALL_LIMIT,
	CODING_SKIN_PROMPT_TIMEOUT_MS,
	CODING_SKIN_SESSION_CONTEXT_MAX_CHARS,
	CODING_SKIN_SESSION_RECALL_LIMIT,
	CODING_SKIN_SESSION_TIMEOUT_MS,
} from "./coding-skin";
import { PRODUCT_MODES, type ProductMode } from "./plugin-config-mode-schema";
import { pluginConfigSchema } from "./plugin-config-schema";
import { SESSION_STRATEGIES } from "./session-strategy";
import { MODEL_CALLS, type ModelDestination } from "../src/model/model-call-table";
import { SUPPORTED_LOCALES, type Locale } from "../src/engine/i18n/locales";

export type Settings = {
	mode: ProductMode;
	modelCalls: Record<keyof typeof MODEL_CALLS, Record<ProductMode, ModelDestination>>;
	user: { id: string; language: Locale };
	snoGpu: { baseUrl: string; apiKey: string };
	rerank: { mode: "lightweight" | "cross-encoder" | "none"; provider: "jina" | "siliconflow" | "pinecone" | "voyage" | "dashscope" | "tei" | "custom"; endpoint: string; model: string; apiKey: string; timeoutMs: number; maxCandidates: number };
	store: { path: string; encryptionKey: string };
	embedding: { model: string; revision: string; dtype: "q4" | "q8" | "fp16" | "fp32"; threads: number; cacheDir: string; offline: boolean; mirror: string };
	recall: { auto: boolean; sessionStart: { limit: number; maxChars: number; timeoutMs: number }; prompt: { limit: number; maxChars: number; timeoutMs: number; minChars: number; minScore: number }; explicitLimit: number };
	capture: { assistant: boolean; ambient: boolean; sessionMemory: { enabled: boolean; messageCount: number }; sessionStrategy: (typeof SESSION_STRATEGIES)[number] };
	rem: { tick: boolean; operations: ("rem-replace" | "rem-update")[] };
	telemetry: { memoryUsage: { enabled: boolean; key: string; historicKeys: string[] }; observe: { enabled: boolean; baseUrl: string }; redactionRules: string[] };
	logging: { level: "debug" | "info" | "warn" | "error"; file: string; debugContent: boolean };
	memoryPackage: { path: string; node: string };
};

const destination = z.enum(["off", "host", "sno-gpu"]);
const destinations = z.strictObject({
	"local-first": destination,
	"agent-native": destination,
	"rem-enhanced": destination,
});
const modelCalls = z.strictObject(Object.fromEntries(
	Object.keys(MODEL_CALLS).map((id) => [id, destinations]),
) as Record<keyof typeof MODEL_CALLS, typeof destinations>);

const schema: z.ZodType<Settings> = z.strictObject({
	mode: z.enum(PRODUCT_MODES),
	modelCalls,
	user: z.strictObject({ id: z.string(), language: z.enum(SUPPORTED_LOCALES) }),
	snoGpu: z.strictObject({ baseUrl: z.string(), apiKey: z.string() }),
	rerank: z.strictObject({
		mode: z.enum(["lightweight", "cross-encoder", "none"]),
		provider: z.enum(["jina", "siliconflow", "pinecone", "voyage", "dashscope", "tei", "custom"]),
		endpoint: z.string(), model: z.string(), apiKey: z.string(),
		timeoutMs: z.number().int().min(1000).max(120000),
		maxCandidates: z.number().int().positive(),
	}),
	store: z.strictObject({ path: z.string(), encryptionKey: z.string().min(1) }),
	embedding: z.strictObject({
		model: z.string(), revision: z.string(), dtype: z.enum(["q4", "q8", "fp16", "fp32"]),
		threads: z.number().int().nonnegative(), cacheDir: z.string(),
		offline: z.boolean(), mirror: z.string(),
	}),
	recall: z.strictObject({
		auto: z.boolean(),
		sessionStart: z.strictObject({ limit: z.number().int().nonnegative(), maxChars: z.number().int().nonnegative(), timeoutMs: z.number().int().nonnegative() }),
		prompt: z.strictObject({ limit: z.number().int().nonnegative(), maxChars: z.number().int().nonnegative(), timeoutMs: z.number().int().nonnegative(), minChars: z.number().int().nonnegative(), minScore: z.number().min(0).max(1) }),
		explicitLimit: z.number().int().nonnegative(),
	}),
	capture: z.strictObject({
		assistant: z.boolean(), ambient: z.boolean(),
		sessionMemory: z.strictObject({ enabled: z.boolean(), messageCount: z.number().int().positive() }),
		sessionStrategy: z.enum(SESSION_STRATEGIES),
	}),
	rem: z.strictObject({
		tick: z.boolean(), operations: z.array(z.enum(["rem-replace", "rem-update"])).min(1).max(2),
	}),
	telemetry: z.strictObject({
		memoryUsage: z.strictObject({ enabled: z.boolean(), key: z.string(), historicKeys: z.array(z.string()) }),
		observe: z.strictObject({ enabled: z.boolean(), baseUrl: z.string() }),
		redactionRules: z.array(z.string()),
	}),
	logging: z.strictObject({ level: z.enum(["debug", "info", "warn", "error"]), file: z.string(), debugContent: z.boolean() }),
	memoryPackage: z.strictObject({ path: z.string(), node: z.string() }),
});

export const settingsSchema: z.ZodType<Settings> = schema;

export function defaultSettings(): Settings {
	const engine = pluginConfigSchema.parse({});
	return {
		mode: engine.mode,
		modelCalls: Object.fromEntries(Object.entries(MODEL_CALLS).map(([id, call]) => [id, call.destinations])) as Settings["modelCalls"],
		user: { id: "", language: "en" },
		snoGpu: { baseUrl: "https://rt3-llm.sno.ai", apiKey: "" },
		rerank: { mode: "lightweight", provider: "voyage", endpoint: "", model: engine.retrieval.rerankModel,
			apiKey: "", timeoutMs: engine.retrieval.rerankTimeoutMs, maxCandidates: CANDIDATE_POOL_SIZE },
		store: { path: "", encryptionKey: "" },
		embedding: { model: EMBEDDER_MODEL_DEFAULT, revision: LOCAL_EMBEDDING_MODEL_REVISION, dtype: engine.embedding.dtype,
			threads: 0, cacheDir: "", offline: false, mirror: "" },
		recall: { auto: true,
			sessionStart: { limit: CODING_SKIN_SESSION_RECALL_LIMIT, maxChars: CODING_SKIN_SESSION_CONTEXT_MAX_CHARS, timeoutMs: CODING_SKIN_SESSION_TIMEOUT_MS },
			prompt: { limit: CODING_SKIN_PROMPT_RECALL_LIMIT, maxChars: CODING_SKIN_PROMPT_CONTEXT_MAX_CHARS,
				timeoutMs: CODING_SKIN_PROMPT_TIMEOUT_MS, minChars: CODING_SKIN_PROMPT_MIN_CHARS, minScore: 0 },
			explicitLimit: CODING_SKIN_EXPLICIT_RECALL_LIMIT },
		capture: { assistant: true, ambient: true, sessionMemory: { enabled: true, messageCount: DEFAULT_SESSION_MESSAGE_COUNT },
			sessionStrategy: "systemSessionMemory" },
		rem: { tick: engine.remEnhanced?.trigger.tick ?? true, operations: engine.remOperations },
		telemetry: { memoryUsage: { enabled: false, key: "", historicKeys: [] },
			observe: { enabled: true, baseUrl: "https://www.sno.ai" }, redactionRules: [] },
		logging: { level: "info", file: "", debugContent: false },
		memoryPackage: { path: "", node: "" },
	};
}

export function settingsToPluginConfig(settings: Settings): import("./plugin-config-schema").PluginConfig {
	return pluginConfigSchema.parse({
		mode: settings.mode, modelCalls: settings.modelCalls,
		provider: { userId: settings.user.id || undefined }, language: settings.user.language,
		dbPath: settings.store.path,
		embedding: { model: settings.embedding.model, revision: settings.embedding.revision || undefined,
			dtype: settings.embedding.dtype, cacheDir: settings.embedding.cacheDir || undefined,
			sessionOptions: { intraOpNumThreads: settings.embedding.threads || undefined } },
		retrieval: { rerank: settings.rerank.mode, rerankProvider: settings.rerank.provider,
			rerankEndpoint: settings.rerank.endpoint || undefined, rerankModel: settings.rerank.model,
			rerankApiKey: settings.rerank.apiKey, rerankTimeoutMs: settings.rerank.timeoutMs,
			rerankMaxCandidates: settings.rerank.maxCandidates },
		autoRecall: settings.recall.auto, autoRecallTimeoutMs: settings.recall.prompt.timeoutMs,
		captureAssistant: settings.capture.assistant, ambientLearning: settings.capture.ambient,
		sessionMemory: settings.capture.sessionMemory, sessionStrategy: settings.capture.sessionStrategy,
		remEnhanced: { trigger: { tick: settings.rem.tick } }, remOperations: settings.rem.operations,
		memoryTelemetry: { enabled: settings.telemetry.memoryUsage.enabled, currentKeyVersion: 1 },
		observe: settings.telemetry.observe,
		extraction: { llm: { baseURL: settings.snoGpu.baseUrl, apiKey: settings.snoGpu.apiKey } },
	});
}
