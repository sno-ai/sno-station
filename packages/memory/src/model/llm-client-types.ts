import { FIXED_MEMORY_OPENAI_GPT_5_NANO, FIXED_MEMORY_OPENROUTER_AUTO, FIXED_MEMORY_SNO_AI_EXTRACT, FIXED_MEMORY_SNO_CONFLICT_VERDICT, FIXED_MEMORY_SNO_EXTRACT_CHAT, FIXED_MEMORY_SNO_EXTRACT_PROFILE } from "./signed-registry-constants";
/** @file llm-client-types.ts
 * @purpose Defines provider-neutral LLM client contracts.
 * @boundary Types only; transport and JSON parsing live in sibling modules.
 */

import type { LLMConfig } from "@snoai/llmix";

import type { AgentLlmPort } from "./agent-llm-port";
import type { LlmRoutingConfig } from "../../config/plugin-config-mode-schema";

export const LLM_PRESETS = [
	FIXED_MEMORY_OPENAI_GPT_5_NANO as typeof FIXED_MEMORY_OPENAI_GPT_5_NANO,
	FIXED_MEMORY_OPENROUTER_AUTO as typeof FIXED_MEMORY_OPENROUTER_AUTO,
	FIXED_MEMORY_SNO_AI_EXTRACT as typeof FIXED_MEMORY_SNO_AI_EXTRACT,
	FIXED_MEMORY_SNO_EXTRACT_CHAT as typeof FIXED_MEMORY_SNO_EXTRACT_CHAT,
	FIXED_MEMORY_SNO_EXTRACT_PROFILE as typeof FIXED_MEMORY_SNO_EXTRACT_PROFILE,
	FIXED_MEMORY_SNO_CONFLICT_VERDICT as typeof FIXED_MEMORY_SNO_CONFLICT_VERDICT,
] as const;

export type LlmPreset = (typeof LLM_PRESETS)[number];

export type LlmProvider = "openai" | "openrouter" | "sno-gpu";

export const MEMORY_LLM_ADAPTER_SLOTS = [
	"memory-extract",
	"dedup-decision",
	"profile-merge",
	"intent-classifier",
	"compaction-merge",
	"conflict-adjudication",
	"summary-build",
	"date-resolution",
] as const;

export type MemoryLlmAdapterSlot = (typeof MEMORY_LLM_ADAPTER_SLOTS)[number];

export type MemoryLlmRequest = {
	prompt: string;
	callLabel: string;
	adapterSlot: MemoryLlmAdapterSlot;
	/** Content-free correlation token forwarded as X-Request-ID when present. */
	requestId?: string;
	/** Hash of the static prompt asset, never the rendered user prompt. */
	promptTemplateHash?: string;
	extractionSkillHash?: string;
	maxTokens?: number;
	/** Per-request empty-body attempts. Defaults to the shared bounded retry policy. */
	emptyReplyAttempts?: number;
	timeoutMs?: number;
	enableThinking?: boolean;
	signal?: AbortSignal;
	/**
	 * completeJson only: the caller's own shape check, run on each payload candidate in order.
	 *
	 * Without it the first syntactically valid object wins and a caller whose schema rejects it
	 * never sees the correct payload sitting behind it — measured on the live route, the subject
	 * guard returned null that way and parked a whole batch.
	 */
	accept?: (value: unknown) => boolean;
};

export interface LlmClientConfig {
	/** Signed LLMIx preset id. */
	preset: LlmPreset;
	/** Optional override; provider-native env vars are used when omitted. */
	apiKey?: string;
	/** Full base URL including /v1 suffix. */
	baseURL?: string;
	/** Helicone API key for OpenAI-compatible request logging. */
	heliconeApiKey?: string;
	timeoutMs?: number;
	agentPort?: AgentLlmPort;
	onTransportAttempt?: (attempt: {
		adapterSlot: MemoryLlmAdapterSlot;
		callLabel: string;
		transport: "chat-completions" | "raw-completions" | "agent-host-seam";
	}) => void;
	onProviderResponse?: (response: ProviderResponseTrace) => void;
	/**
	 * Product-mode routing slice. When present, every request is resolved
	 * through resolveLlmRoute first; a routed-OFF request returns null without
	 * touching the network (callers' deterministic fallbacks take over).
	 */
	routing?: LlmRoutingConfig;
}

export type ResolvedLlmConfig = {
	preset: LlmPreset;
	provider: LlmProvider;
	model: string;
	providerOptions?: LLMConfig["providerOptions"];
	baseURL?: string;
	heliconeApiKey?: string;
	timeoutMs?: number;
};

export interface LlmClient {
	/** Send a prompt and parse the JSON response. Degradable failures return null; host cancellation and authentication rejection throw. */
	completeJson<T>(request: MemoryLlmRequest): Promise<T | null>;
	/** Send a prompt and return raw text. Degradable failures return null; host cancellation and authentication rejection throw. */
	completeText(request: MemoryLlmRequest): Promise<string | null>;
	/** Signed preset resolved through the bundled LLMIx registry. */
	getResolvedConfig(): Promise<ResolvedLlmConfig>;
	/** Best-effort diagnostics for the most recent failure, if any. */
	getLastError(): string | null;
	/** Provider-reported usage from the most recent successful response, if available. */
	getLastUsage(): TokenUsage | null;
}

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type TokenUsage = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	estimated?: boolean;
};

export type ProviderResponseTrace = {
	durationMs?: number;
	adapterSlot: MemoryLlmAdapterSlot;
	callLabel: string;
	provider: LlmProvider;
	requestId?: string;
	model?: string;
	usage?: Omit<TokenUsage, "estimated">;
};

export type DispatchContext = {
	provider: string;
	model: string;
	apiKey: string;
	messages: unknown[];
	kwargs: Record<string, unknown>;
	config: LLMConfig & {
		adapterSlot?: MemoryLlmAdapterSlot;
		callLabel?: string;
		baseUrl?: string;
		endpointUrl?: string;
		heliconeApiKey?: string;
		shouldSendHeliconeAuth?: boolean;
		signal?: AbortSignal;
		timeoutMs?: number;
		userBaseUrlOverride?: boolean;
		requestId?: string;
		promptTemplateHash?: string;
		extractionSkillHash?: string;
		onProviderResponse?: (response: ProviderResponseTrace) => void;
		rawCompletion?: {
			endpointUrl: string;
			prompt: string;
			timeoutMs: number;
			requestId?: string;
			maxTokens?: number;
			singleTokenVerdict?: boolean;
			signal?: AbortSignal;
		};
	};
};

export type ProviderResult = {
	content: string;
	model: string;
	usage: TokenUsage;
};

export type LocalCallResult =
	| (ProviderResult & { success: true })
	| {
			success: false;
			error: string;
			content: "";
			model: string;
			usage: TokenUsage;
	  };

export type ResolvedBaseUrl = {
	baseUrl?: string;
	shouldSendHeliconeAuth: boolean;
	userBaseUrlOverride: boolean;
};
