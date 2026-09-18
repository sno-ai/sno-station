import { FIXED_PROTOCOL_VALUE_69, FIXED_EXTRACTION_KEY_NAME } from "./signed-registry-constants";
import { classifyLlmFailure } from "./llm-failure";
/** @file llm-provider-transport.ts
 * @purpose Sends OpenAI-compatible chat requests with retries and provider routing.
 * @boundary HTTP transport, base URL resolution, key rotation, and retry behavior.
 */

import type { DispatchContext as LlmixDispatchContext } from "@snoai/llmix";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { countTokens } from "@snoai/chunking";
import { createLogger, withLogContext } from "@snoai/utils/logger";
import type {
	DispatchContext,
	LlmClientConfig,
	LlmProvider,
	ResolvedLlmConfig,
	LocalCallResult,
	ProviderResult,
	ProviderResponseTrace,
	TokenUsage,
} from "./llm-client-types";

const log = createLogger("sno-station-mem:llm-provider-transport");
const routeInFlight = new Map<string, number>();
const providerResponses = new AsyncLocalStorage<ProviderResponseTrace[]>();

/** Collect actual provider usage for the current sidecar request, without changing transport. */
export function withProviderResponses<T>(responses: ProviderResponseTrace[], run: () => Promise<T>): Promise<T> {
	return providerResponses.run(responses, run);
}


type RequestDiagnostic = {
	started: number;
	headersAt?: number;
	bodyAt?: number;
	status?: number;
	returnedModel?: string;
	finishReason?: string;
	usage?: TokenUsage;
};

async function observeRequest<T>(
	input: { endpoint: string; model: string; transport: string; slot?: string; label?: string;
		timeout: number; cap?: number; sampling: Record<string, unknown>; promptTemplateHash?: string; extractionSkillHash?: string; forwardedConfigHash?: string },
	run: (diagnostic: RequestDiagnostic) => Promise<T>,
): Promise<T> {
	const route = createHash("sha256").update(input.endpoint).digest("hex");
	const inFlight = (routeInFlight.get(route) ?? 0) + 1;
	routeInFlight.set(route, inFlight);
	const diagnostic: RequestDiagnostic = { started: performance.now() };
	return withLogContext({ attempt_id: randomUUID() }, async () => {
		let outcome = "failed";
		let failure: unknown;
		try {
			const result = await run(diagnostic);
			outcome = typeof result === "object" && result !== null && "content" in result && result.content === "" ? "empty_success" : "success";
			return result;
		} catch (error) {
			failure = error;
			outcome = getProviderTerminalCategory(error) ?? "failed";
			throw error;
		} finally {
			const remaining = (routeInFlight.get(route) ?? 1) - 1;
			if (remaining === 0) routeInFlight.delete(route);
			else routeInFlight.set(route, remaining);
			log.info("Model request completed", {
				outcome, error: failure, adapter_slot: input.slot ?? "unavailable",
				call_label: input.label ?? "unavailable", route_hash: route,
				transport: input.transport, requested_model: input.model,
				returned_model: diagnostic.returnedModel ?? "unavailable",
				prompt_template_hash: input.promptTemplateHash ?? "unavailable",
				extraction_skill_hash: input.extractionSkillHash ?? "unavailable",
				prompt_template_unavailable_reason: input.promptTemplateHash ? undefined : "caller_does_not_provide_template_identity",
				config_hash: createHash("sha256").update(JSON.stringify({ ...input, endpoint: route })).digest("hex"),
				output_cap: input.cap ?? "unavailable", timeout_ms: input.timeout,
				sampling: { source: Object.keys(input.sampling).length ? "sent" : "unknown", values: input.sampling },
				in_flight_at_dispatch: inFlight, status_code: diagnostic.status ?? "unavailable",
				duration_ms: performance.now() - diagnostic.started,
				dispatch_to_headers_ms: diagnostic.headersAt === undefined ? "unavailable" : diagnostic.headersAt - diagnostic.started,
				headers_to_body_ms: diagnostic.headersAt === undefined || diagnostic.bodyAt === undefined ? "unavailable" : diagnostic.bodyAt - diagnostic.headersAt,
				first_token_ms: "unavailable", first_token_reason: "non_streaming_transport",
				server_queue_ms: "unavailable", server_service_ms: "unavailable",
				finish_reason: diagnostic.finishReason ?? "unavailable",
				usage: diagnostic.usage ? { source: diagnostic.usage.estimated ? "estimated" : "provider_reported", ...diagnostic.usage } : { source: "unavailable" },
			}, { event_name: "llm.request.completed", file: "packages/sno-station-mem/src/model/llm-provider-transport.ts", function: "observeRequest", site_id: "llm.transport.request.completed" });
		}
	});
}

const CCPROXY_OPENAI_BASE_URL = FIXED_PROTOCOL_VALUE_69;
const CCPROXY_PLACEHOLDER_API_KEY = "ccproxy-placeholder";
const HELICONE_AUTH_HOSTNAMES = new Set([
	"oai.helicone.ai",
	"gateway.helicone.ai",
	"anthropic.helicone.ai",
]);
/** Keys from pipeline kwargs that belong in the chat/completions POST body. */
const FORWARDED_KWARGS = [
	"temperature",
	"top_p",
	"max_tokens",
	"max_completion_tokens",
	"seed",
	"response_format",
] as const;

/** Assembles call body from validated inputs for deterministic LLM transport. */
function buildCallBody(
	kwargs: Record<string, unknown>,
	provider: LlmProvider,
): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	for (const key of FORWARDED_KWARGS) {
		if (provider === "sno-gpu" && key === "temperature") continue;
		if (kwargs[key] != null) body[key] = kwargs[key];
	}
	return body;
}

function hasAbortSignalShape(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { aborted?: unknown }).aborted === "boolean" &&
		typeof (value as { addEventListener?: unknown }).addEventListener === "function"
	);
}

type RequestAbort = {
	signal: AbortSignal;
	timeoutSignal: AbortSignal;
	callerSignal?: AbortSignal;
};

function requestAbortSignal(timeoutMs: number, callerSignal: unknown): RequestAbort {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!hasAbortSignalShape(callerSignal)) return { signal: timeoutSignal, timeoutSignal };
	return {
		signal: callerSignal.aborted
			? callerSignal
			: AbortSignal.any([timeoutSignal, callerSignal]),
		timeoutSignal,
		callerSignal,
	};
}

const PROVIDER_TERMINAL_ERROR_PREFIX = "sno-station-mem provider terminal";

export type ProviderTerminalCategory = "cancelled" | "timeout" | "auth";

class ProviderTerminalError extends Error {
	readonly statusCode: number;

	constructor(
		readonly category: ProviderTerminalCategory,
		message: string,
		statusCode: number,
	) {
		super(`${PROVIDER_TERMINAL_ERROR_PREFIX} ${category}: ${message}`);
		this.name = "ProviderTerminalError";
		this.statusCode = statusCode;
	}
}

/** Recovers terminal transport semantics after CallPipeline serializes an error to text. */
export function getProviderTerminalCategory(error: unknown): ProviderTerminalCategory | null {
	if (error instanceof ProviderTerminalError) return error.category;
	const message = error instanceof Error ? error.message : String(error);
	const match = new RegExp(
		`^${PROVIDER_TERMINAL_ERROR_PREFIX} (cancelled|timeout|auth):`,
	).exec(message);
	return match?.[1] === "cancelled" || match?.[1] === "timeout" || match?.[1] === "auth"
		? match[1]
		: null;
}

function abortedProviderCategory(requestAbort: RequestAbort): "cancelled" | "timeout" | null {
	if (requestAbort.callerSignal?.aborted) return "cancelled";
	if (requestAbort.timeoutSignal.aborted) return "timeout";
	return null;
}

function throwTerminalAbort(error: unknown, requestAbort: RequestAbort): never {
	const category = abortedProviderCategory(requestAbort);
	if (category) {
		throw new ProviderTerminalError(
			category,
			error instanceof Error ? error.message : String(error),
			499,
		);
	}
	throw error;
}

function estimateTokens(text: string): number {
	return Math.max(1, countTokens(text));
}

function estimateUsage(messages: unknown[], content: string): TokenUsage {
	const inputTokens = estimateTokens(JSON.stringify(messages));
	const outputTokens = estimateTokens(content);
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
		estimated: true,
	};
}

function readProviderUsage(
	usage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	} | undefined,
): Omit<TokenUsage, "estimated"> | undefined {
	if (
		typeof usage?.prompt_tokens === "number" &&
		typeof usage.completion_tokens === "number" &&
		typeof usage.total_tokens === "number"
	) {
		return {
			inputTokens: usage.prompt_tokens,
			outputTokens: usage.completion_tokens,
			totalTokens: usage.total_tokens,
		};
	}
	return undefined;
}

function normalizeProviderUsage(
	usage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	} | undefined,
	messages: unknown[],
	content: string,
): TokenUsage {
	return readProviderUsage(usage) ?? estimateUsage(messages, content);
}

function readProviderRequestId(bodyId: unknown, headers: Headers): string | undefined {
	const candidates = [bodyId, headers.get("x-request-id")];
	return candidates.find(
		(value): value is string =>
			typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
	);
}

function notifyProviderResponse(
	callback: ((response: ProviderResponseTrace) => void) | undefined,
	response: ProviderResponseTrace,
): void {
	providerResponses.getStore()?.push(response);
	callback?.(response);
}

/**
 * The status line alone does not say what the provider objected to, and a 400 always does — it is
 * the one class of failure where the server knows the answer and we were throwing it away. Measured
 * 2026-08-12: a REM wave died on `B-profile extraction returned HTTP 400`, and the reason for it was
 * unreachable without editing this file and re-running.
 *
 * Read only for a non-auth status: an auth failure's body is the one that can carry credential
 * material back, and it is also the one status that needs no explanation.
 */
async function describeProviderFailure(response: Response, diagnostic?: RequestDiagnostic): Promise<string> {
	let detail: string;
	try {
		detail = (await response.text()).trim();
		if (diagnostic) diagnostic.bodyAt = performance.now();
	} catch {
		// A body that cannot be read is not worth failing differently over; the status still stands.
		return `HTTP ${response.status}`;
	}
	if (detail.length === 0) return `HTTP ${response.status}`;
	const collapsed = detail.replace(/\s+/g, " ");
	const shown = collapsed.length > 500 ? `${collapsed.slice(0, 500)}…` : collapsed;
	return `HTTP ${response.status}: ${shown}`;
}

export interface SnoProfileCompletionRequest {
	promptTemplateHash?: string;
	extractionSkillHash?: string;
	endpointUrl: string;
	model: string;
	apiKey: string;
	prompt: string;
	timeoutMs: number;
	requestId?: string;
	maxTokens?: number;
	singleTokenVerdict?: boolean;
	signal?: AbortSignal;
	adapterSlot?: ProviderResponseTrace["adapterSlot"];
	callLabel?: string;
	onProviderResponse?: (response: ProviderResponseTrace) => void;
}

/** Calls the fixed B-profile raw-completions route without transport-level retries. */
export async function callSnoProfileCompletion(
	request: SnoProfileCompletionRequest,
): Promise<ProviderResult> {
	return observeRequest({ endpoint: request.endpointUrl, model: request.model,
		transport: "raw-completions", slot: request.adapterSlot, label: request.callLabel,
		timeout: request.timeoutMs, cap: request.singleTokenVerdict ? 1 : request.maxTokens,
		sampling: {}, promptTemplateHash: request.promptTemplateHash, extractionSkillHash: request.extractionSkillHash }, async (diagnostic) => {
	const requestAbort = requestAbortSignal(request.timeoutMs, request.signal);
	let response: Response;
	try {
		response = await fetch(request.endpointUrl, {
			method: "POST",
			signal: requestAbort.signal,
			headers: {
				"Content-Type": "application/json",
				"X-Internal-Token": request.apiKey,
				...(request.requestId ? { "X-Request-ID": request.requestId } : {}),
			},
			body: JSON.stringify({
				model: request.model,
				prompt: request.prompt,
				// Only what the CALLER asked for. This body used to carry `enable_thinking: false`
				// and a hardcoded `max_tokens: 512`, neither of which is ours to decide: how the
				// model reasons internally belongs to the serving side, and an output cap nobody
				// chose truncates a longer reply mid-JSON with no error anywhere.
				//
				// The flag is NOT the cause of the empty replies. Measured against the live
				// endpoint on 2026-08-17, interleaving both arms over 36 paired calls: 25% empty
				// with the flag, 31% without. It is removed because it was never ours to send, and
				// the empty-reply defect is a separate serving-side fault still open.
				...(request.singleTokenVerdict
					? { max_tokens: 1 }
					: (request.maxTokens ? { max_tokens: request.maxTokens } : {})),
			}),
		});
		diagnostic.headersAt = performance.now();
		diagnostic.status = response.status;
	} catch (error) {
		throwTerminalAbort(error, requestAbort);
	}
	if (!response.ok) {
		if (classifyLlmFailure({ status: response.status }).category === "auth") {
			throw new ProviderTerminalError(
				"auth",
				`B-profile extraction returned HTTP ${response.status}`,
				response.status,
			);
		}
		const error = new Error(
			`B-profile extraction returned ${await describeProviderFailure(response, diagnostic)}`,
		) as Error & { statusCode: number };
		error.statusCode = response.status;
		throw error;
	}

	let body: {
		id?: unknown;
		model?: unknown;
		choices?: Array<{ text?: unknown; finish_reason?: string }>;
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
		};
	};
	try {
		body = await response.json();
		diagnostic.bodyAt = performance.now();
	} catch (error) {
		throwTerminalAbort(error, requestAbort);
	}
	const content = body.choices?.[0]?.text;
	if (typeof content !== "string") {
		throw new Error("B-profile extraction response is missing choices[0].text");
	}
	const model = typeof body.model === "string" && body.model.trim() ? body.model : undefined;
	const usage = readProviderUsage(body.usage);
	diagnostic.returnedModel = model;
	diagnostic.finishReason = body.choices?.[0]?.finish_reason;
	diagnostic.usage = normalizeProviderUsage(body.usage, [request.prompt], content);
	const requestId = readProviderRequestId(body.id, response.headers);
	if (request.onProviderResponse && request.adapterSlot && request.callLabel) {
		notifyProviderResponse(request.onProviderResponse, {
			durationMs: performance.now() - diagnostic.started,
			adapterSlot: request.adapterSlot,
			callLabel: request.callLabel,
			provider: "sno-gpu",
			...(requestId ? { requestId } : {}),
			...(model ? { model } : {}),
			...(usage ? { usage } : {}),
		});
	}
	return {
		content,
		model: model ?? request.model,
		usage: normalizeProviderUsage(body.usage, [request.prompt], content),
	};
	});
}

function isHeliconeBaseUrl(baseUrl: string): boolean {
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase();
		return HELICONE_AUTH_HOSTNAMES.has(hostname);
	} catch {
		return false;
	}
}

function resolveHeliconeApiKey(value?: string): string | undefined {
	return value?.trim() || process.env.HELICONE_API_KEY?.trim() || undefined;
}

function isCcproxyOpenAiBaseUrl(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const configured = new URL(value);
		const expected = new URL(CCPROXY_OPENAI_BASE_URL);
		return (
			configured.origin === expected.origin &&
			configured.pathname.replace(/\/+$/, "") === expected.pathname.replace(/\/+$/, "")
		);
	} catch {
		return false;
	}
}

async function snoStationMemDispatch(ctx: LlmixDispatchContext): Promise<ProviderResult> {
	const cfgExt = ctx.config as DispatchContext["config"];
	const provider = ctx.provider;
	if (provider !== "openai" && provider !== "openrouter" && provider !== "sno-gpu") {
		throw new Error(`sno-station-mem llm-client: unsupported provider "${provider}"`);
	}
	const endpointUrl = cfgExt.endpointUrl;
	if (typeof endpointUrl !== "string") {
		throw new Error("sno-station-mem llm-client: resolved endpointUrl is required");
	}
	const timeoutMs = (cfgExt.timeoutMs as number | undefined) ?? 30_000;
	const callBody = buildCallBody(ctx.kwargs, provider);
	const sampling = Object.fromEntries(["temperature", "top_p", "seed"].flatMap((key) => callBody[key] === undefined ? [] : [[key, callBody[key]]]));
	return observeRequest({ endpoint: endpointUrl, model: ctx.model, transport: "chat-completions",
		slot: cfgExt.adapterSlot, label: cfgExt.callLabel, timeout: timeoutMs,
		cap: typeof callBody.max_tokens === "number" ? callBody.max_tokens : typeof callBody.max_completion_tokens === "number" ? callBody.max_completion_tokens : undefined,
		sampling, promptTemplateHash: cfgExt.promptTemplateHash, extractionSkillHash: cfgExt.extractionSkillHash,
		forwardedConfigHash: createHash("sha256").update(JSON.stringify({
			response_format: callBody.response_format, seed: callBody.seed,
			max_tokens: callBody.max_tokens, max_completion_tokens: callBody.max_completion_tokens,
			temperature: callBody.temperature, top_p: callBody.top_p,
		})).digest("hex") }, async (diagnostic) => {
	const requestAbort = requestAbortSignal(timeoutMs, cfgExt.signal);
	const heliconeApiKey = resolveHeliconeApiKey(
		typeof cfgExt.heliconeApiKey === "string" ? cfgExt.heliconeApiKey : undefined,
	);
	const shouldSendHeliconeAuth =
		cfgExt.shouldSendHeliconeAuth === true || isHeliconeBaseUrl(endpointUrl);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (typeof cfgExt.requestId === "string") headers["X-Request-ID"] = cfgExt.requestId;
	if (provider === "sno-gpu") {
		headers["X-Internal-Token"] = ctx.apiKey;
	} else {
		headers.Authorization = `Bearer ${ctx.apiKey}`;
		if (heliconeApiKey && shouldSendHeliconeAuth) {
			headers["Helicone-Auth"] = `Bearer ${heliconeApiKey}`;
		}
	}
	let response: Response;
	try {
		response = await fetch(endpointUrl, {
			method: "POST",
			signal: requestAbort.signal,
			headers,
			body: JSON.stringify({
				model: ctx.model,
				messages: ctx.messages,
				...callBody,
			}),
		});
		diagnostic.headersAt = performance.now();
		diagnostic.status = response.status;
	} catch (error) {
		const category = abortedProviderCategory(requestAbort);
		if (category) {
			throw new ProviderTerminalError(
				category,
				error instanceof Error ? error.message : String(error),
				499,
			);
		}
		throw error;
	}

	if (!response.ok) {
		if (classifyLlmFailure({ status: response.status }).category === "auth") {
			throw new ProviderTerminalError(
				"auth",
				`HTTP ${response.status}`,
				response.status,
			);
		}
		const err = new Error(await describeProviderFailure(response, diagnostic)) as Error & {
			statusCode: number;
		};
		err.statusCode = response.status;
		throw err;
	}

	let body: {
		id?: unknown;
		model?: unknown;
		choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
		};
	};
	try {
		body = (await response.json()) as typeof body;
		diagnostic.bodyAt = performance.now();
	} catch (parseErr) {
		if (abortedProviderCategory(requestAbort)) {
			throwTerminalAbort(parseErr, requestAbort);
		}
		const err = new Error(
			`Malformed response body: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
		) as Error & { statusCode: number };
		err.statusCode = 502;
		throw err;
	}
	// A 200 carrying no content is a failed call, not an empty answer. Defaulting it to "" made it
	// indistinguishable from a model that legitimately said nothing, so it counted as a success and
	// the caller's all-calls-failed guard could never fire. 502 because the fault is the response,
	// and the transport's other route already treats a missing field this way — see the
	// `choices[0].text` check above.
	const rawContent = body.choices?.[0]?.message?.content;
	if (typeof rawContent !== "string") {
		const err = new Error(
			"Chat completion response is missing choices[0].message.content",
		) as Error & { statusCode: number };
		err.statusCode = 502;
		throw err;
	}
	const content = rawContent;
	const model = typeof body.model === "string" && body.model.trim() ? body.model : undefined;
	const usage = readProviderUsage(body.usage);
	diagnostic.returnedModel = model;
	diagnostic.finishReason = body.choices?.[0]?.finish_reason;
	diagnostic.usage = normalizeProviderUsage(body.usage, ctx.messages, content);
	const requestId = readProviderRequestId(body.id, response.headers);
	const onProviderResponse = cfgExt.onProviderResponse;
	if (
		typeof onProviderResponse === "function" &&
		cfgExt.adapterSlot &&
		cfgExt.callLabel
	) {
		notifyProviderResponse(onProviderResponse as (response: ProviderResponseTrace) => void, {
			durationMs: performance.now() - diagnostic.started,
			adapterSlot: cfgExt.adapterSlot,
			callLabel: cfgExt.callLabel,
			provider,
			...(requestId ? { requestId } : {}),
			...(model ? { model } : {}),
			...(usage ? { usage } : {}),
		});
	}
	return {
		content,
		model: model ?? ctx.model,
		usage: normalizeProviderUsage(body.usage, ctx.messages, content),
	};
	});
}

export function createApiKeySelector(apiKeys: string): () => string {
	const keys = apiKeys
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key.length > 0);

	if (keys.length === 0) {
		throw new Error("sno-station-mem llm-client: apiKey must contain at least one non-empty key");
	}

	let nextIndex = 0;
	return () => {
		const key = keys[nextIndex];
		if (key === undefined) {
			throw new Error("sno-station-mem llm-client: failed to select apiKey");
		}
		nextIndex = (nextIndex + 1) % keys.length;
		return key;
	};
}

export async function callProvider(ctx: LlmixDispatchContext): Promise<LocalCallResult> {
	const cfgExt = ctx.config as DispatchContext["config"];
	const rawCompletion = cfgExt.rawCompletion;
	if (typeof rawCompletion === "object" && rawCompletion !== null) {
		const raw = rawCompletion as Record<string, unknown>;
		if (
			typeof raw.endpointUrl !== "string" ||
			typeof raw.prompt !== "string" ||
			typeof raw.timeoutMs !== "number"
		) {
			throw new Error("sno-station-mem llm-client: invalid raw profile completion config");
		}
		return {
			...(await callSnoProfileCompletion({
				...(cfgExt.promptTemplateHash ? { promptTemplateHash: cfgExt.promptTemplateHash } : {}),
				...(cfgExt.extractionSkillHash ? { extractionSkillHash: cfgExt.extractionSkillHash } : {}),
				endpointUrl: raw.endpointUrl,
				model: ctx.model,
				apiKey: ctx.apiKey,
				prompt: raw.prompt,
				timeoutMs: raw.timeoutMs,
				...(cfgExt.adapterSlot ? { adapterSlot: cfgExt.adapterSlot } : {}),
				...(cfgExt.callLabel ? { callLabel: cfgExt.callLabel } : {}),
				...(cfgExt.onProviderResponse
					? { onProviderResponse: cfgExt.onProviderResponse }
					: {}),
				...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
				...(typeof raw.maxTokens === "number" ? { maxTokens: raw.maxTokens } : {}),
				...(raw.singleTokenVerdict === true ? { singleTokenVerdict: true } : {}),
				...(hasAbortSignalShape(raw.signal) ? { signal: raw.signal } : {}),
			})),
			success: true,
		};
	}
	return {
		...(await snoStationMemDispatch(ctx)),
		success: true,
	};
}

/** Picks the provider-native environment key for a preset without a configured apiKey. */
function resolveEnvApiKey(
	provider: LlmProvider,
	userBaseUrlOverride: boolean,
): string | undefined {
	if (provider === "sno-gpu") {
		return userBaseUrlOverride
			? process.env.SNO_MEM_CLAW_LLM_API_KEY
			: (process.env.SNO_MEM_CLAW_LLM_API_KEY ?? process.env[FIXED_EXTRACTION_KEY_NAME]);
	}
	if (provider === "openrouter") return process.env.OPENROUTER_API_KEY;
	return undefined;
}

export function resolveProviderApiKey(
	config: LlmClientConfig,
	resolved: ResolvedLlmConfig,
	userBaseUrlOverride: boolean,
): string {
	if (config.apiKey?.trim()) return config.apiKey;
	if (
		resolved.provider === "openai" &&
		(!userBaseUrlOverride || isCcproxyOpenAiBaseUrl(config.baseURL?.trim()))
	) {
		return CCPROXY_PLACEHOLDER_API_KEY;
	}
	const envKey = resolveEnvApiKey(resolved.provider, userBaseUrlOverride);
	if (envKey?.trim()) return envKey;
	const hint =
		resolved.provider === "sno-gpu" && userBaseUrlOverride
			? "set extraction.llm.apiKey or SNO_MEM_CLAW_LLM_API_KEY for overridden Sno AI endpoints"
			: `set extraction.llm.apiKey or the provider environment key for preset ${config.preset}`;
	throw new Error(`sno-station-mem llm-client: missing API key; ${hint}`);
}
