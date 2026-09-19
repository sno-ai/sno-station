import type { Registration } from "../src/contract/inputs";
import { engineSettingsSchema } from "../src/contract/settings";
import { installationSettingsSchema, type InstallationSettings } from "./installation-settings";
import { llmRoutingConfigSchema } from "./plugin-config-mode-schema";
export { HOST_MODEL_CALLBACK_HOST, HOST_MODEL_CALLBACK_PATH } from "./skin-defaults";

export const CODING_SKIN_CHILD_DEADLINE_MS = 110_000;
export const CODING_SKIN_WORKER_LIFETIME_MS: number = 9 * 60_000;
export const CODING_SKIN_RETRY_DELAYS_MS = [2_000, 10_000] as const;
export const CODING_SKIN_MAX_ATTEMPTS = 3;
export const CODING_SKIN_IMPORT_INTERVAL_MS = 2_010;
export const CODING_SKIN_CHILD_MAX_BUFFER_BYTES: number = 8 * 1024 * 1024;
export const CODING_SKIN_MANUAL_SESSION_ID = "manual";
export const CODING_SKIN_CORRECTION_LOCK_STALE_MS: number = 2 * 60_000;

export const CODING_SKIN_SESSION_QUERY =
	"standing decisions, open tasks, conventions and known pitfalls for this repository";
export const CODING_SKIN_SESSION_CONTEXT_MAX_CHARS = 3_500;
export const CODING_SKIN_PROMPT_CONTEXT_MAX_CHARS = 1_500;
export const CODING_SKIN_LEDGER_MAX_CHARS = 12_000;
export const CODING_SKIN_SESSION_RECALL_LIMIT = 5;
export const CODING_SKIN_PROMPT_RECALL_LIMIT = 3;
export const CODING_SKIN_EXPLICIT_RECALL_LIMIT = 5;
export const CODING_SKIN_PROMPT_MIN_CHARS = 12;
export const CODING_SKIN_SESSION_TIMEOUT_MS = 8_000;
export const CODING_SKIN_PROMPT_TIMEOUT_MS = 4_000;
export const CODING_SKIN_RECALL_SENTENCE_MAX_CHARS = 200;
export const CODING_SKIN_RECALL_ITEM_MAX_CHARS = 240;

export const CODING_SKIN_HOOKS = {
	SessionStart: { eventName: "session_start", subcommand: "session-start", timeout: 15 },
	UserPromptSubmit: { eventName: "user_prompt_submit", subcommand: "user-prompt-submit", timeout: 8 },
	Stop: { eventName: "stop", subcommand: "stop", timeout: 5 },
} as const;

export type CodingSkinHookName = keyof typeof CODING_SKIN_HOOKS;

export const CODING_SKIN_MODEL_COMMANDS = ["recall", "get", "remember", "correct"] as const;

export const codingSkinInstallationSchema: typeof installationSettingsSchema =
	installationSettingsSchema;

export function createCodingSkinRegistration(input: {
	skinId: string;
	installed: InstallationSettings;
	model: NonNullable<Registration["model"]>;
}): Registration {
	const routing = llmRoutingConfigSchema.parse({
		mode: input.installed.mode,
		remEnhanced: input.installed.remEnhanced,
		agentNative: { flavor: "subscription" },
		language: "en",
	});
	const settings = engineSettingsSchema.parse({
		embedding: input.installed.embedding,
		observe: { enabled: false },
		dbPath: input.installed.storePath,
		provider: {},
		ambientLearning: true,
		autoRecall: true,
		autoRecallMinLength: 2,
		autoRecallMinRepeated: 0,
		autoRecallMaxQueryLength: 2_000,
		autoRecallTimeoutMs: input.installed.autoRecallTimeoutMs ?? 5_000,
		autoRecallIncludeAgents: [],
		autoRecallExcludeAgents: [],
		captureAssistant: true,
		retrieval: {
			...input.installed.retrieval,
			...(input.installed.rerankKeyRef
				? { rerankApiKey: `\${${input.installed.rerankKeyRef}}` }
				: {}),
		},
		scopes: {
			default: "global",
			definitions: { global: { description: "Shared knowledge across all agents" } },
			agentAccess: {},
		},
		enableManagementTools: false,
		sessionStrategy: "systemSessionMemory",
		sessionMemory: { enabled: true, messageCount: 15 },
		selfImprovement: {
			enabled: true,
			beforeResetNote: true,
			skipSubagentBootstrap: true,
			ensureLearningFiles: true,
		},
		extraction: {},
		memoryReflection: {},
		recallLifecycle: {},
		memoryTelemetry: input.installed.memoryTelemetry ?? {
			enabled: false,
			currentKeyVersion: 1,
		},
		remOperations: input.installed.remOperations ?? ["rem-replace", "rem-update"],
	});
	return { skinId: input.skinId, routing, settings, model: input.model };
}
