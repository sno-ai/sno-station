import { memoryOperationSignal, checkMemoryOperation } from "../engine/operation-cancellation";
/** @file llm-client.ts
 * @purpose Creates the provider-neutral LLM client facade.
 * @boundary Public LLM client API; JSON parsing and transport live in focused modules.
 * @see llm-json-utils.ts, llm-provider-transport.ts.
 */

import type { LLMConfig } from "@snoai/llmix";
import { isCredentialFailure } from "./llm-failure";
import { CallPipeline, KeyPool } from "@snoai/llmix";
import { createLogger, withLogContext } from "@snoai/utils/logger";
import { createHash, randomUUID } from "node:crypto";

import type {
	LlmClient,
	LlmClientConfig,
	MemoryLlmAdapterSlot,
	MemoryLlmRequest,
	LlmPreset,
	LlmProvider,
	ResolvedLlmConfig,
} from "./llm-client-types";
import { MEMORY_LLM_ADAPTER_SLOTS } from "./llm-client-types";
import {
	resolveLlmEndpoint,
	resolveSignedPreset,
	type ResolvedLlmEndpoint,
} from "./llm-endpoint-resolution";
import { extractJsonFromResponse, previewText, repairCommonJson } from "./llm-json-utils";
import { readModelReplyJson } from "../engine/shared/model-reply-text";
import { resolveLlmOccasion, resolveLlmRoute } from "./llm-mode-routing";
import {
	callProvider,
	getProviderTerminalCategory,
	resolveProviderApiKey,
} from "./llm-provider-transport";
import type { LlmOccasion } from "../../config/plugin-config-mode-schema";

export type {
	LlmClient,
	LlmClientConfig,
	MemoryLlmAdapterSlot,
	MemoryLlmRequest,
	LlmPreset,
	LlmProvider,
	ResolvedLlmConfig,
};
export { extractJsonFromResponse, repairCommonJson };

const log = createLogger("sno-station-mem:llm-client");
let hostRequestsInFlight = 0;
/**
 * Last-resort output cap for a raw-completion caller that set none. Every use is logged as an
 * error naming the caller, because this exists to keep a broken call alive, not to spare anyone
 * from choosing their own budget.
 */
const RAW_COMPLETION_FALLBACK_MAX_TOKENS = 4096;
/**
 * How many times one request may be asked before an empty reply is accepted as the answer.
 *
 * The serving side answers an otherwise valid request with an empty body often enough to matter:
 * measured 2026-08-17 against the live endpoint, 25% of 36 paired calls with `enable_thinking`
 * and 31% without (llm-provider-transport.ts:242, where that fault is recorded as still open).
 * An empty body is not a transport error, so the call pipeline never retried it, and every caller
 * turned it into `null`. The REM replace clause stage then journals that null as
 * `clause_parse_failed` and releases the pair, so the memory is never updated at all — measured
 * 2026-08-26, 2 of 4 identical runs of `rem-replace-roundtrip-reopen` died that way on a
 * two-clause fixture the model answers correctly 12 times out of 12 when asked directly.
 *
 * Asking again is all this does. It is bounded by attempt count AND by the caller's own deadline,
 * so a slow endpoint cannot turn one request into three timeouts. It does not repair the
 * serving-side fault and must not be read as having repaired it.
 */
const EMPTY_REPLY_ATTEMPTS = 3;

export const JSON_SYSTEM_CONTENT =
	"You are a memory extraction assistant. Always respond with valid JSON only.";
const JSON_REPAIR_INSTRUCTION =
	"Your previous reply was not valid JSON. Respond with ONLY the JSON object, no prose.";
const REFLECTION_TEXT_SYSTEM_CONTENT =
	"You are a memory reflection assistant. Return concise plain text only.";
const CONFLICT_ADJUDICATION_SYSTEM_CONTENT =
	"You adjudicate memory conflicts. Follow the verdict contract and return only the requested JSON object or verdict token.";

type RequestTransport = "chat-completions" | "raw-completions" | "agent-host-seam";

type JsonParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export class LlmClientTerminalError extends Error {
	constructor(
		readonly category: "cancelled" | "timeout" | "auth" | "transport",
		message: string,
		readonly requestTimedOut = false,
	) {
		super(message);
		this.name = "LlmClientTerminalError";
	}
}

/**
 * Whether a failure ends the whole run rather than costing one call.
 *
 * A real cancellation and an auth failure are terminal: nothing downstream should keep spending
 * model time or, worse, keep writing. A timeout is NOT — the transport aborts on its own deadline
 * and reports `cancelled` with `requestTimedOut` set, and treating that as a cancellation once
 * cost an entire conversation for one slow call.
 *
 * SOURCE OF TRUTH. The same predicate is spelled out by hand in memory-extraction-pipeline.ts,
 * task-lifecycle-route.ts, profile-section-writer.ts and b-profile-extraction.ts; those copies
 * should be replaced by this import, and are flagged rather than changed here.
 */
export function isTerminalLlmFailure(error: unknown): error is LlmClientTerminalError {
	return (
		error instanceof LlmClientTerminalError &&
		((error.category === "cancelled" && !error.requestTimedOut) || error.category === "auth")
	);
}

function parseJsonResponse<T>(
	raw: string,
	accept?: (value: unknown) => boolean,
): JsonParseResult<T> {
	// Every candidate the shared unwrapper offers, in its order, checked against the caller's own
	// shape when it supplied one — so a schema-wrong example ahead of the real payload no longer
	// consumes the caller's only chance. With no check, the first candidate that parses wins.
	const parsedValue = readModelReplyJson<{ value: T }>(raw, (value) =>
		accept === undefined || accept(value) ? { value: value as T } : undefined,
	);
	if (parsedValue !== undefined) return { ok: true, value: parsedValue.value };
	const jsonStr = extractJsonFromResponse(raw);
	if (!jsonStr) {
		return {
			ok: false,
			error: `no JSON found (chars=${raw.length}, preview=${JSON.stringify(previewText(raw))})`,
		};
	}

	try {
		const value: unknown = JSON.parse(jsonStr);
		if (accept && !accept(value)) return { ok: false, error: "caller check rejected payload" };
		return { ok: true, value: value as T };
	} catch (error) {
		const repairedJsonStr = repairCommonJson(jsonStr);
		if (repairedJsonStr !== jsonStr) {
			try {
				const value: unknown = JSON.parse(repairedJsonStr);
				if (accept && !accept(value)) return { ok: false, error: "caller check rejected payload" };
				return { ok: true, value: value as T };
			} catch {
				return {
					ok: false,
					error: `JSON.parse failed: ${error instanceof Error ? error.message : String(error)}; repair also failed (chars=${jsonStr.length})`,
				};
			}
		}
		return {
			ok: false,
			error: `JSON.parse failed: ${error instanceof Error ? error.message : String(error)} (chars=${jsonStr.length})`,
		};
	}
}

function buildPipelineConfig(
	preset: ResolvedLlmConfig,
	config: LlmClientConfig,
	endpoint: ResolvedLlmEndpoint,
	request: MemoryLlmRequest,
): LLMConfig &
	ResolvedLlmConfig & {
		baseUrl: string;
		endpointUrl: string;
		shouldSendHeliconeAuth?: boolean;
		userBaseUrlOverride?: boolean;
		callLabel: string;
		adapterSlot: string;
		requestId?: string;
		signal?: AbortSignal;
		onProviderResponse?: LlmClientConfig["onProviderResponse"];
	} {
	return {
		provider: preset.provider,
		model: preset.model,
		...(preset.providerOptions ? { providerOptions: preset.providerOptions } : {}),
		timeout: { totalTime: Math.ceil((config.timeoutMs ?? preset.timeoutMs ?? 30_000) / 1_000) },
		common: {
			enableThinking: request.enableThinking ?? false,
			maxOutputTokens: request.maxTokens ?? 4096,
		},
		caching: { strategy: "disabled" },
		preset: preset.preset,
		baseUrl: endpoint.url,
		endpointUrl: endpoint.url,
		...(endpoint.userBaseUrlOverride
			? { userBaseUrlOverride: endpoint.userBaseUrlOverride }
			: {}),
		...(config.heliconeApiKey ? { heliconeApiKey: config.heliconeApiKey } : {}),
		timeoutMs: request.timeoutMs ?? config.timeoutMs ?? preset.timeoutMs ?? 30_000,
		callLabel: request.callLabel,
		adapterSlot: request.adapterSlot,
		...(request.requestId ? { requestId: request.requestId } : {}),
		...(request.promptTemplateHash ? { promptTemplateHash: request.promptTemplateHash } : {}),
		...(request.extractionSkillHash ? { extractionSkillHash: request.extractionSkillHash } : {}),
		...(request.signal ? { signal: request.signal } : {}),
		...(config.onProviderResponse ? { onProviderResponse: config.onProviderResponse } : {}),
	};
}

const MEMORY_LLM_ADAPTER_SLOT_SET = new Set<string>(MEMORY_LLM_ADAPTER_SLOTS);

function hasAbortSignalShape(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { aborted?: unknown }).aborted === "boolean" &&
		typeof (value as { addEventListener?: unknown }).addEventListener === "function"
	);
}

function readRequiredString(
	request: Record<string, unknown>,
	field: keyof Pick<MemoryLlmRequest, "prompt" | "callLabel" | "adapterSlot">,
): string {
	const value = request[field];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`sno-station-mem llm-client: ${field} is required`);
	}
	return value;
}

function normalizeMemoryLlmRequest(value: unknown): MemoryLlmRequest {
	if (typeof value !== "object" || value === null) {
		throw new Error("sno-station-mem llm-client: structured request object is required");
	}
	const raw = value as Record<string, unknown>;
	const prompt = readRequiredString(raw, "prompt");
	const callLabel = readRequiredString(raw, "callLabel");
	const adapterSlot = readRequiredString(raw, "adapterSlot");
	if (!MEMORY_LLM_ADAPTER_SLOT_SET.has(adapterSlot)) {
		throw new Error(`sno-station-mem llm-client: unknown adapterSlot "${adapterSlot}"`);
	}
	const timeoutMs = raw.timeoutMs;
	if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || Number(timeoutMs) <= 0)) {
		throw new Error("sno-station-mem llm-client: timeoutMs must be a positive number");
	}
	const maxTokens = raw.maxTokens;
	if (
		maxTokens !== undefined &&
		(!Number.isInteger(maxTokens) || Number(maxTokens) <= 0)
	) {
		throw new Error("sno-station-mem llm-client: maxTokens must be a positive integer");
	}
	const emptyReplyAttempts = raw.emptyReplyAttempts;
	if (
		emptyReplyAttempts !== undefined &&
		(!Number.isInteger(emptyReplyAttempts) ||
			Number(emptyReplyAttempts) < 1 ||
			Number(emptyReplyAttempts) > EMPTY_REPLY_ATTEMPTS)
	) {
		throw new Error(
			`sno-station-mem llm-client: emptyReplyAttempts must be an integer from 1 to ${EMPTY_REPLY_ATTEMPTS}`,
		);
	}
	const enableThinking = raw.enableThinking;
	if (enableThinking !== undefined && typeof enableThinking !== "boolean") {
		throw new Error("sno-station-mem llm-client: enableThinking must be a boolean");
	}
	const signal = raw.signal;
	if (signal !== undefined && !hasAbortSignalShape(signal)) {
		throw new Error("sno-station-mem llm-client: signal must be an AbortSignal");
	}
	const requestId = raw.requestId;
	if (
		requestId !== undefined &&
		(typeof requestId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))
	) {
		throw new Error("sno-station-mem llm-client: requestId must be a content-free correlation token");
	}
	return {
		prompt,
		callLabel,
		adapterSlot: adapterSlot as MemoryLlmRequest["adapterSlot"],
		...(timeoutMs !== undefined ? { timeoutMs: Number(timeoutMs) } : {}),
		...(maxTokens !== undefined ? { maxTokens: Number(maxTokens) } : {}),
		...(emptyReplyAttempts !== undefined
			? { emptyReplyAttempts: Number(emptyReplyAttempts) }
			: {}),
		...(enableThinking !== undefined ? { enableThinking } : {}),
		...(requestId !== undefined ? { requestId } : {}),
		...(typeof raw.promptTemplateHash === "string" && /^[a-f0-9]{64}$/.test(raw.promptTemplateHash)
			? { promptTemplateHash: raw.promptTemplateHash } : {}),
		...(typeof raw.extractionSkillHash === "string" && /^[a-f0-9]{64}$/.test(raw.extractionSkillHash)
			? { extractionSkillHash: raw.extractionSkillHash } : {}),
		...(signal ? { signal } : {}),
	};
}

function textSystemContent(request: MemoryLlmRequest): string {
	return request.adapterSlot === "conflict-adjudication"
		? CONFLICT_ADJUDICATION_SYSTEM_CONTENT
		: REFLECTION_TEXT_SYSTEM_CONTENT;
}

/** Creates the LLM client facade with provider routing, key rotation, and JSON parsing. */
export function createLlmClient(config: LlmClientConfig): LlmClient {
	let presetPromise: Promise<ResolvedLlmConfig> | null = null;
	const getPreset = () => {
		presetPromise ??= resolveSignedPreset(config.preset).catch((error: unknown) => {
			presetPromise = null;
			throw error;
		});
		return presetPromise;
	};
	const endpointPromises = new Map<string, Promise<ResolvedLlmEndpoint>>();
	const getEndpoint = (
		occasion: LlmOccasion,
		transport: Exclude<RequestTransport, "agent-host-seam">,
	) => {
		const key = `${occasion}:${transport}`;
		let endpointPromise = endpointPromises.get(key);
		if (!endpointPromise) {
			endpointPromise = resolveLlmEndpoint({
				configuredPreset: config.preset,
				occasion,
				transport,
				...(config.baseURL ? { baseOverride: config.baseURL } : {}),
			}).catch((error: unknown) => {
				endpointPromises.delete(key);
				throw error;
			});
			endpointPromises.set(key, endpointPromise);
		}
		return endpointPromise;
	};
	const pipeline = new CallPipeline({
		dispatch: callProvider,
		maxRetries: 2,
		retryBaseMs: 100,
		retryMaxDelayMs: 500,
		transformKwargsOverrides: {
			// The signed registry resolves the full endpoint; our transport owns Sno request fields.
			"sno-gpu": (_context, kwargs) => kwargs,
		},
	});

	let lastError: string | null = null;
	let lastUsage: ReturnType<LlmClient["getLastUsage"]> = null;
	const resolveRequestTimeoutMs = (request: MemoryLlmRequest): number =>
		request.timeoutMs ?? config.timeoutMs ?? 30_000;
	/**
	 * Resolves the transport this facade can dispatch. A routed-OFF request is
	 * a graceful no-op (not an error), and an unavailable transport also skips.
	 * Neither case substitutes another tier.
	 */
	const resolveRequestTransport = (request: MemoryLlmRequest): RequestTransport | null => {
		if (!config.routing) return "chat-completions";
		const decision = resolveLlmRoute({
			slot: request.adapterSlot,
			callLabel: request.callLabel,
			config: config.routing,
		});
		if ("off" in decision) {
			log.debug("Model client request diagnostic", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: `sno-station-mem: llm-client [${request.callLabel}] routed off (${decision.reason}); deterministic fallback applies` }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "resolveRequestTransport", site_id: "shared.llm-client.resolveRequestTransport.8f631601af" });
			return null;
		}
		if (decision.transport === "agent-host-seam") {
			if (config.agentPort) return "agent-host-seam";
			lastError = `sno-station-mem: llm-client [${request.callLabel}] routed to agent-host-seam but AgentLlmPort is unavailable`;
			log.warn("Model client request diagnostic", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "resolveRequestTransport", site_id: "shared.llm-client.resolveRequestTransport.ffa933b519" });
			throw new LlmClientTerminalError("transport", lastError);
		}
		return decision.transport;
	};
	const requestContent = async (
		request: MemoryLlmRequest,
		systemContent: string,
		prompt = request.prompt,
	): Promise<{ raw: string; transport: RequestTransport } | null> => {
		checkMemoryOperation();
		lastError = null;
		lastUsage = null;
		const transport = resolveRequestTransport(request);
		if (!transport) return null;
		if (transport === "agent-host-seam") {
			const agentPort = config.agentPort;
			if (!agentPort) {
				throw new LlmClientTerminalError(
					"transport",
					`sno-station-mem: llm-client [${request.callLabel}] AgentLlmPort is unavailable`,
				);
			}
			config.onTransportAttempt?.({
				adapterSlot: request.adapterSlot,
				callLabel: request.callLabel,
				transport,
			});
			const hostStarted = performance.now();
			const hostInFlight = ++hostRequestsInFlight;
			const result = await withLogContext({ attempt_id: randomUUID() }, async () => {
				let outcome = "failed";
				try {
					const completion = await agentPort.complete({
						system: systemContent,
						prompt,
						maxTokens: request.maxTokens ?? 4096,
						...(request.enableThinking !== undefined
							? { enableThinking: request.enableThinking } : {}),
						timeoutMs: resolveRequestTimeoutMs(request),
						...(request.signal ? { signal: request.signal } : {}),
					});
					outcome = completion.kind;
					return completion;
				} finally {
					hostRequestsInFlight -= 1;
					log.info("Host model request completed", { outcome, transport: "agent-host-seam",
						adapter_slot: request.adapterSlot, call_label: request.callLabel,
						duration_ms: performance.now() - hostStarted, in_flight_at_dispatch: hostInFlight,
						requested_model: "unavailable", returned_model: "unavailable", usage: { source: "unavailable" },
						prompt_template_hash: request.promptTemplateHash ?? "unavailable",
						extraction_skill_hash: request.extractionSkillHash ?? "unavailable",
						prompt_template_unavailable_reason: request.promptTemplateHash ? undefined : "caller_does_not_provide_template_identity",
						config_hash: createHash("sha256").update(JSON.stringify({ transport, maxTokens: request.maxTokens ?? 4096, timeoutMs: resolveRequestTimeoutMs(request) })).digest("hex"),
						output_cap: "unavailable", passed_output_cap: request.maxTokens ?? 4096,
						output_cap_reason: "host_may_strip_requested_cap", timeout_ms: resolveRequestTimeoutMs(request),
						sampling: { source: "unknown" }, finish_reason: "unavailable", route: "agent-host-seam",
						dispatch_to_headers_ms: "unavailable", headers_to_body_ms: "unavailable", first_token_ms: "unavailable",
						provider_unavailable_reason: "host_port_does_not_report_provider_fields",
					}, { event_name: "llm.request.completed", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "requestContent", site_id: "llm.host.request.completed" });
				}
			});
			if (result.kind === "cancelled") {
				lastError = `[${request.callLabel}] agent-llm cancelled (${result.reason})`;
				log.warn("Host model request cancelled", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "requestContent", site_id: "llm.client.host_cancelled" });
				throw new LlmClientTerminalError(
					"cancelled",
					lastError,
					result.reason === "deadline" && !request.signal?.aborted,
				);
			}
			if (result.kind === "error") {
				lastError = `[${request.callLabel}] agent-llm ${result.category}: ${result.message}`;
				log.warn("Host model request failed", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "requestContent", site_id: "llm.client.host_error" });
				if (isCredentialFailure(result.category)) {
					throw new LlmClientTerminalError("auth", lastError);
				}
				return null;
			}
			return { raw: result.text, transport };
		}
		const occasion =
			resolveLlmOccasion(request.adapterSlot, request.callLabel) ??
			(request.adapterSlot === "memory-extract" ? "memoryExtract" : undefined);
		if (!occasion) {
			throw new Error(
				`sno-station-mem llm-client: no LLM occasion for ${request.adapterSlot}/${request.callLabel}`,
			);
		}
		const endpoint = await getEndpoint(occasion, transport);
		checkMemoryOperation();
		const preset = endpoint.preset;
		const apiKey = resolveProviderApiKey(config, preset, endpoint.userBaseUrlOverride);
		if (transport === "raw-completions") {
			if (preset.provider !== "sno-gpu") {
				throw new Error("raw completion requires the sno-gpu provider");
			}
			// This route sends only what the caller asked for, and the serving side's own output
			// default is 16 tokens — measured 2026-08-18, enough to cut a JSON reply mid-string with
			// no error anywhere, so the whole chunk is lost. A caller that forgets its cap must fail
			// loudly here rather than silently receive truncated replies forever. The one-token
			// verdict route sets its own cap below and is exempt.
			// A caller that forgot its cap is a defect in the caller, and it must be impossible to
			// miss — but it must not stop the run. Failing here would cost the extraction the
			// serving side would have completed perfectly well. So: say it loudly, every single
			// call, then carry on with a cap that works. The number below is a floor for a broken
			// caller, never a design decision anyone gets to rely on silently; the log line is what
			// makes it temporary. Without any cap the serving side truncates at 16 output tokens,
			// measured 2026-08-18, which cuts the JSON mid-string and loses the whole chunk.
			if (occasion !== "conflictAdjudication" && !request.maxTokens) {
				log.error("Model client request diagnostic", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: `sno-station-mem llm-client: raw completion [${request.callLabel}] set no maxTokens; sending ${RAW_COMPLETION_FALLBACK_MAX_TOKENS} so the call still runs. Fix the caller — without a cap the serving side truncates at 16 tokens.` }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "requestContent", site_id: "shared.llm-client.requestContent.ff17976562" });
			}
			const pipelineConfig = {
				...buildPipelineConfig(preset, config, endpoint, request),
					rawCompletion: {
					endpointUrl: endpoint.url,
					prompt,
						timeoutMs: resolveRequestTimeoutMs(request),
					maxTokens: request.maxTokens ?? RAW_COMPLETION_FALLBACK_MAX_TOKENS,
						...(request.requestId ? { requestId: request.requestId } : {}),
					...(occasion === "conflictAdjudication" ? { singleTokenVerdict: true } : {}),
					...(request.signal ? { signal: request.signal } : {}),
				},
			};
			pipeline.setKeyPool(preset.provider, new KeyPool(apiKey.split(",")));
			config.onTransportAttempt?.({
				adapterSlot: request.adapterSlot,
				callLabel: request.callLabel,
				transport,
			});
			const response = await pipeline.call({ config: pipelineConfig, messages: [prompt] });
			if (!response.success) {
				lastError = `sno-station-mem: llm-client [${request.callLabel}] pipeline error: ${response.error}`;
				log.warn("Raw model request failed", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "requestContent", site_id: "llm.client.raw_pipeline_failed" });
				const category = getProviderTerminalCategory(response.error);
				if (category) throw new LlmClientTerminalError(category, lastError);
				return null;
			}
			lastUsage = response.usage;
			return { raw: response.content, transport };
		}
		const pipelineConfig = buildPipelineConfig(preset, config, endpoint, request);
		pipeline.setKeyPool(preset.provider, new KeyPool(apiKey.split(",")));
		config.onTransportAttempt?.({
			adapterSlot: request.adapterSlot,
			callLabel: request.callLabel,
			transport,
		});
		const response = await pipeline.call({
			config: pipelineConfig,
			messages: [
				{
					role: "system",
					content: systemContent,
				},
				{ role: "user", content: prompt },
			],
		});

		if (!response.success) {
			lastError = `sno-station-mem: llm-client [${request.callLabel}] pipeline error: ${response.error}`;
			log.warn("Chat model request failed", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "requestContent", site_id: "llm.client.chat_pipeline_failed" });
			const category = getProviderTerminalCategory(response.error);
			if (category) throw new LlmClientTerminalError(category, lastError);
			return null;
		}
		lastUsage = response.usage;

		const raw = response.content;
		if (!raw) {
			// Warn, not debug: the default log level is "info", so this line was invisible while it
			// silently cost a third of one benchmark persona's memories (measured 2026-08-17 — 45
			// failed extractions, exactly one warn line in the whole run).
			lastError = `sno-station-mem: llm-client [${request.callLabel}] empty response from preset ${config.preset}`;
			log.warn("Model reply empty", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "requestContent", site_id: "llm.client.empty_reply" });
			// Empty text, not `null`: the call reached the endpoint and came back with nothing, which
			// is the one failure worth asking about again. `null` is reserved for "no call happened"
			// — routed off, or a pipeline error already classified above — and retrying those would
			// be wrong.
			return { raw: "", transport };
		}
		return { raw, transport };
	};

	/**
	 * Wraps `requestContent` with the bounded re-ask described on `EMPTY_REPLY_ATTEMPTS`. A `null`
	 * result is returned untouched — it means no call was made, not that the model said nothing.
	 */
	const requestContentRetryingEmpty = async (
		request: MemoryLlmRequest,
		systemContent: string,
		deadlineMs: number,
		prompt = request.prompt,
	): Promise<{ raw: string; transport: RequestTransport } | null> => {
		let content = await requestContent(request, systemContent, prompt);
		checkMemoryOperation();
		const attemptLimit = request.emptyReplyAttempts ?? EMPTY_REPLY_ATTEMPTS;
		for (let attempt = 2; attempt <= attemptLimit; attempt += 1) {
			if (content === null || content.raw.trim().length > 0) return content;
			if (performance.now() >= deadlineMs) break;
			log.debug("Retrying empty model reply", { adapter_slot: request.adapterSlot, call_label: request.callLabel, attempt, attempt_limit: attemptLimit }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "requestContentRetryingEmpty", site_id: "shared.llm-client.requestContentRetryingEmpty.cd874fefff" });
			content = await requestContent(request, systemContent, prompt);
			checkMemoryOperation();
		}
		return content;
	};

	return {
		/** Implements complete json as the local LLM transport operation. */
		async completeJson<T>(input: MemoryLlmRequest): Promise<T | null> {
			const request = normalizeMemoryLlmRequest({ ...input, signal: memoryOperationSignal(input.signal) });
			checkMemoryOperation();
			const deadlineMs = performance.now() + resolveRequestTimeoutMs(request);
			try {
				let content = await requestContentRetryingEmpty(request, JSON_SYSTEM_CONTENT, deadlineMs);
				if (content === null) return null;

				let parsed = parseJsonResponse<T>(content.raw, input.accept);
				if (parsed.ok) return parsed.value;

				if (content.transport === "agent-host-seam") {
					const remainingTimeoutMs = Math.floor(deadlineMs - performance.now());
					if (remainingTimeoutMs <= 0) {
						lastError = `sno-station-mem: llm-client [${request.callLabel}] deadline exhausted before JSON repair`;
						log.warn("Model repair deadline exhausted", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "completeJson", site_id: "llm.client.json.deadline_exhausted" });
						throw new LlmClientTerminalError("cancelled", lastError, true);
					}
					content = await requestContentRetryingEmpty(
						{ ...request, timeoutMs: remainingTimeoutMs },
						JSON_SYSTEM_CONTENT,
						deadlineMs,
						`${request.prompt}\n\n${JSON_REPAIR_INSTRUCTION}`,
					);
					if (content === null) return null;
					parsed = parseJsonResponse<T>(content.raw, input.accept);
					if (parsed.ok) return parsed.value;
				}

				lastError = `sno-station-mem: llm-client [${request.callLabel}] ${parsed.error}`;
				log.debug("Model client request diagnostic", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "completeJson", site_id: "shared.llm-client.completeJson.e04c8e7e82" });
				return null;
			} catch (err) {
				checkMemoryOperation();
				if (err instanceof LlmClientTerminalError) throw err;
				lastError = `sno-station-mem: llm-client [${request.callLabel}] request failed for preset ${config.preset}: ${err instanceof Error ? err.message : String(err)}`;
				log.warn("Model request failed", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "completeJson", site_id: "llm.client.json.request_failed" });
				return null;
			}
		},

		async completeText(input: MemoryLlmRequest): Promise<string | null> {
			const request = normalizeMemoryLlmRequest({ ...input, signal: memoryOperationSignal(input.signal) });
			checkMemoryOperation();
			const deadlineMs = performance.now() + resolveRequestTimeoutMs(request);
			try {
				const content = await requestContentRetryingEmpty(
					request,
					textSystemContent(request),
					deadlineMs,
				);
				const text = content?.raw.trim();
				return text && text.length > 0 ? text : null;
			} catch (err) {
				checkMemoryOperation();
				if (err instanceof LlmClientTerminalError) throw err;
				lastError = `sno-station-mem: llm-client [${request.callLabel}] request failed for preset ${config.preset}: ${err instanceof Error ? err.message : String(err)}`;
				log.warn("Model client request diagnostic", { adapter_slot: request.adapterSlot, call_label: request.callLabel, error: lastError }, { event_name: "memory.llm_client.diagnostic", file: "packages/sno-station-mem/src/model/llm-client.ts", function: "completeText", site_id: "shared.llm-client.completeText.ffa933b519" });
				return null;
			}
		},

		getResolvedConfig(): Promise<ResolvedLlmConfig> {
			return getPreset();
		},

		/** Returns last error from LLM transport state without side effects. */
		getLastError(): string | null {
			return lastError;
		},

		/** Returns provider usage from the last successful provider response. */
		getLastUsage() {
			return lastUsage;
		},
	};
}
