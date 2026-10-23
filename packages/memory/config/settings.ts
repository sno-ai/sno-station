import { LOCAL_EMBEDDING_MODEL_REVISION } from "@snoai/embedder";
import { isLowercaseCanonicalUUIDv7 } from "@snoai/common-core";
import { z } from "zod";
import { DEFAULT_SESSION_MESSAGE_COUNT, EMBEDDER_MODEL_DEFAULT } from "./index";
import { PRODUCT_MODES, type ProductMode } from "./plugin-config-mode-schema";
import { pluginConfigSchema } from "./plugin-config-schema";
import { rerankModeSchema, rerankTimeoutSchema } from "./plugin-config-retrieval-schema";
import { SESSION_STRATEGIES } from "./session-strategy";
import { MODEL_CALLS, type ModelDestination } from "../src/model/model-call-table";
import { SUPPORTED_LOCALES, type Locale } from "../src/engine/i18n/locales";

export type Settings = {
	mode: ProductMode;
	modelCalls: Record<keyof typeof MODEL_CALLS, Record<ProductMode, ModelDestination>>;
	user: { id: string; language: Locale };
	snoGpu: { baseUrl: string; apiKey: string };
	rerank: { mode: "lightweight" | "none"; timeoutMs: number };
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
) as Record<keyof typeof MODEL_CALLS, typeof destinations>)
	.extend({ R5: destinations.default(MODEL_CALLS.R5.destinations) });

const schema: z.ZodType<Settings> = z.strictObject({
	mode: z.enum(PRODUCT_MODES),
	modelCalls,
	user: z.strictObject({ id: z.string().refine((id) => id === "" || isLowercaseCanonicalUUIDv7(id)), language: z.enum(SUPPORTED_LOCALES) }),
	snoGpu: z.strictObject({ baseUrl: z.string(), apiKey: z.string() }),
	rerank: z.preprocess((value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value) || !("maxCandidates" in value)) return value;
		// Only this published, retired field is removed; unknown settings still fail strict validation.
		const { maxCandidates: _retired, ...current } = value;
		return current;
	}, z.strictObject({ mode: rerankModeSchema, timeoutMs: rerankTimeoutSchema })),
	store: z.strictObject({ path: z.string(), encryptionKey: z.string().min(1).regex(/^[0-9a-f]{64}$/u) }),
	embedding: z.strictObject({
		model: z.string(), revision: z.string(), dtype: z.enum(["q4", "q8", "fp16", "fp32"]),
		threads: z.number().int().nonnegative(), cacheDir: z.string(),
		offline: z.boolean(), mirror: z.string(),
	}),
	recall: z.strictObject({
		auto: z.boolean(),
		sessionStart: z.strictObject({ limit: z.number().int().nonnegative(), maxChars: z.number().int().nonnegative(), timeoutMs: z.number().int().nonnegative() }),
		prompt: z.strictObject({ limit: z.number().int().min(0).max(2000), maxChars: z.number().int().nonnegative(), timeoutMs: z.number().int().min(500).max(60000), minChars: z.number().int().min(0).max(200), minScore: z.number().min(0).max(1) }),
		explicitLimit: z.number().int().nonnegative(),
	}),
	capture: z.strictObject({
		assistant: z.boolean(), ambient: z.boolean(),
		sessionMemory: z.strictObject({ enabled: z.boolean(), messageCount: z.number().int().min(1).max(100) }),
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
		rerank: { mode: "lightweight", timeoutMs: engine.retrieval.rerankTimeoutMs },
		store: { path: "", encryptionKey: "" },
		embedding: { model: EMBEDDER_MODEL_DEFAULT, revision: LOCAL_EMBEDDING_MODEL_REVISION, dtype: engine.embedding.dtype,
			threads: 0, cacheDir: "", offline: false, mirror: "" },
		recall: { auto: true,
			sessionStart: { limit: 5, maxChars: 3_500, timeoutMs: 8_000 },
			prompt: { limit: 3, maxChars: 1_500,
				timeoutMs: 4_000, minChars: 12, minScore: 0 },
			explicitLimit: 5 },
		capture: { assistant: true, ambient: true, sessionMemory: { enabled: true, messageCount: DEFAULT_SESSION_MESSAGE_COUNT },
			sessionStrategy: "systemSessionMemory" },
		rem: { tick: engine.remEnhanced?.trigger.tick ?? true, operations: engine.remOperations },
		telemetry: { memoryUsage: { enabled: true, key: "", historicKeys: [] },
			observe: { enabled: true, baseUrl: "https://www.sno.ai" }, redactionRules: [] },
		logging: { level: "debug", file: "", debugContent: false },
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
			offline: settings.embedding.offline, mirror: settings.embedding.mirror,
			sessionOptions: { intraOpNumThreads: settings.embedding.threads || undefined } },
		retrieval: { rerank: settings.rerank.mode,
			recallTopK: settings.recall.prompt.limit, minScore: settings.recall.prompt.minScore,
			rerankTimeoutMs: settings.rerank.timeoutMs },
		autoRecall: settings.recall.auto, autoRecallTimeoutMs: settings.recall.prompt.timeoutMs,
		autoRecallMinLength: settings.recall.prompt.minChars,
		captureAssistant: settings.capture.assistant, ambientLearning: settings.capture.ambient,
		debugContent: settings.logging.debugContent,
		sessionMemory: settings.capture.sessionMemory, sessionStrategy: settings.capture.sessionStrategy,
		remEnhanced: { trigger: { tick: settings.rem.tick } }, remOperations: settings.rem.operations,
		memoryTelemetry: { enabled: settings.telemetry.memoryUsage.enabled,
			currentKeyVersion: settings.telemetry.memoryUsage.historicKeys.length + 1,
			key: settings.telemetry.memoryUsage.key, historicKeys: settings.telemetry.memoryUsage.historicKeys },
		observe: settings.telemetry.observe,
		extraction: { llm: { baseURL: settings.snoGpu.baseUrl, apiKey: settings.snoGpu.apiKey } },
	});
}
