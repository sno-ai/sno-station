import { isCuid2 } from "@snoai/common-core";
import { SnoObserveError } from "./errors.js";
import { fetchJson, normalizeBaseUrl } from "./http.js";
import { updateValidIdentity } from "./identity.js";
import { type RegisterOptions, registerMachine } from "./machine-registration.js";
import type { PathEnv } from "./paths.js";
import type { Identity } from "./types.js";

const BASE_URL_ENV = "SNO_OBSERVE_BASE_URL";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_POLL_INTERVAL_MS = 30000;
const MAX_TRANSIENT_POLL_ERRORS = 3;

export interface ClaimCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresIn: number;
	interval: number;
}

export interface ClaimOptions {
	baseUrl?: string;
	env?: PathEnv;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	pollIntervalMs?: number;
	onCode?: (code: ClaimCode) => void;
}

export interface ClaimResult {
	claimed: true;
	userAccountId: string;
	userCuid: string;
	machineUuid: string;
}

interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
}

interface DeviceTokenResponse {
	user_account_id: string;
	status?: "claimed";
}

interface ErrorResponse {
	error?: string;
	interval?: number;
	message?: string;
}

interface JsonResponse<T> {
	status: number;
	value: T | null;
	body: string;
	headers: Headers;
}

interface PollInput {
	baseUrl: string;
	deviceCode: string;
	fetchImpl: typeof fetch;
	pollIntervalMs: number;
	signal?: AbortSignal;
	startedAt: number;
	timeoutMs: number;
}

interface PollState {
	delayMs: number;
	networkDelayMs: number;
	transientErrors: number;
}

export async function claimMachine(
	identity: Identity,
	options: ClaimOptions = {},
): Promise<ClaimResult> {
	const env = options.env ?? process.env;
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? env[BASE_URL_ENV] ?? "https://www.sno.ai");
	const fetchImpl = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const startedAt = Date.now();
	throwIfAborted(options.signal);

	const registerOptions: RegisterOptions = {
		baseUrl,
		env,
		...(options.fetch === undefined ? {} : { fetch: fetchImpl }),
	};
	await registerMachine(identity, registerOptions);
	throwIfAborted(options.signal);

	const code = await requestDeviceCode(identity, baseUrl, fetchImpl, options.signal);
	options.onCode?.(code);

	const pollInput: PollInput = {
		baseUrl,
		deviceCode: code.deviceCode,
		fetchImpl,
		pollIntervalMs: options.pollIntervalMs ?? code.interval * 1000,
		startedAt,
		timeoutMs,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	};
	const userAccountId = await pollForClaim(pollInput);

	const updatedIdentity = updateValidIdentity(
		(current) =>
			current.user_cuid === identity.user_cuid && current.machine_uuid === identity.machine_uuid
				? { ...current, user_account_id: userAccountId }
				: current,
		env,
	);
	if (
		updatedIdentity === null ||
		updatedIdentity.user_cuid !== identity.user_cuid ||
		updatedIdentity.machine_uuid !== identity.machine_uuid ||
		updatedIdentity.user_account_id !== userAccountId
	) {
		throw new SnoObserveError(
			"claim_identity_changed",
			"local identity changed before claim could be saved",
		);
	}

	return {
		claimed: true,
		userAccountId,
		userCuid: identity.user_cuid,
		machineUuid: identity.machine_uuid,
	};
}

async function requestDeviceCode(
	identity: Identity,
	baseUrl: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<ClaimCode> {
	const response = await fetchJson<DeviceCodeResponse | ErrorResponse>(
		`${baseUrl}/api/v1/device/code`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				user_cuid: identity.user_cuid,
				machine_uuid: identity.machine_uuid,
			}),
			...(signal === undefined ? {} : { signal }),
		},
		fetchImpl,
	).catch((error: unknown) => normalizeAbortError(error, signal));
	if (response.status !== 200 || !isDeviceCodeResponse(response.value)) {
		throw claimError("device code request", response.status, response.value, response.body);
	}
	return {
		deviceCode: response.value.device_code,
		userCode: response.value.user_code,
		verificationUri: response.value.verification_uri,
		...(typeof response.value.verification_uri_complete === "string"
			? { verificationUriComplete: response.value.verification_uri_complete }
			: {}),
		expiresIn: response.value.expires_in,
		interval: response.value.interval ?? DEFAULT_POLL_INTERVAL_MS / 1000,
	};
}

async function pollForClaim(input: PollInput): Promise<string> {
	const state: PollState = {
		delayMs: normalizeDelay(input.pollIntervalMs),
		networkDelayMs: normalizeDelay(input.pollIntervalMs),
		transientErrors: 0,
	};
	for (;;) {
		assertClaimCanContinue(input);
		const response = await requestDeviceToken(input, state);
		if (response === null) {
			continue;
		}
		if (response.status === 200 && isDeviceTokenResponse(response.value)) {
			return response.value.user_account_id;
		}
		const errorCode = parseErrorCode(response.value);
		if (response.status === 400 && errorCode === "authorization_pending") {
			await sleepWithinTimeout(state.delayMs, input.startedAt, input.timeoutMs, input.signal);
			continue;
		}
		if (response.status === 400 && errorCode === "slow_down") {
			state.delayMs = parseServerIntervalMs(response.value) ?? normalizeDelay(state.delayMs + 5000);
			await sleepWithinTimeout(state.delayMs, input.startedAt, input.timeoutMs, input.signal);
			continue;
		}
		throw claimError("device token request", response.status, response.value, response.body);
	}
}

async function requestDeviceToken(
	input: PollInput,
	state: PollState,
): Promise<JsonResponse<DeviceTokenResponse | ErrorResponse> | null> {
	try {
		const response = await fetchJson<DeviceTokenResponse | ErrorResponse>(
			`${input.baseUrl}/api/v1/device/token`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					device_code: input.deviceCode,
					grant_type: DEVICE_CODE_GRANT_TYPE,
				}),
				...(input.signal === undefined ? {} : { signal: input.signal }),
			},
			input.fetchImpl,
		);
		state.transientErrors = 0;
		state.networkDelayMs = state.delayMs;
		return response;
	} catch (error) {
		await handleTransientPollError(error, input, state);
		return null;
	}
}

async function handleTransientPollError(
	error: unknown,
	input: PollInput,
	state: PollState,
): Promise<void> {
	if (isAbortError(error) || input.signal?.aborted) {
		throw abortClaimError();
	}
	if (error instanceof SnoObserveError) {
		throw error;
	}
	state.transientErrors += 1;
	if (state.transientErrors > MAX_TRANSIENT_POLL_ERRORS) {
		throw new SnoObserveError(
			"claim_poll_network_error",
			`device token request failed after ${MAX_TRANSIENT_POLL_ERRORS} retries: ${errorMessage(
				error,
			)}`,
		);
	}
	await sleepWithinTimeout(state.networkDelayMs, input.startedAt, input.timeoutMs, input.signal);
	state.networkDelayMs = normalizeDelay(state.networkDelayMs * 2);
}

function isDeviceCodeResponse(value: unknown): value is DeviceCodeResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as DeviceCodeResponse;
	return (
		typeof candidate.device_code === "string" &&
		candidate.device_code.length > 0 &&
		typeof candidate.user_code === "string" &&
		candidate.user_code.length > 0 &&
		typeof candidate.verification_uri === "string" &&
		isHttpsUrl(candidate.verification_uri) &&
		(candidate.verification_uri_complete === undefined ||
			(typeof candidate.verification_uri_complete === "string" &&
				isHttpsUrl(candidate.verification_uri_complete))) &&
		typeof candidate.expires_in === "number" &&
		Number.isFinite(candidate.expires_in) &&
		candidate.expires_in > 0 &&
		(candidate.interval === undefined ||
			(typeof candidate.interval === "number" &&
				Number.isFinite(candidate.interval) &&
				candidate.interval >= 1))
	);
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

function isDeviceTokenResponse(value: unknown): value is DeviceTokenResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as DeviceTokenResponse;
	return typeof candidate.user_account_id === "string" && isCuid2(candidate.user_account_id);
}

function claimError(action: string, status: number, value: unknown, body: string): SnoObserveError {
	const serverError = parseServerError(value);
	const code = serverError?.error ?? "claim_failed";
	const detail = serverError?.message ?? serverError?.error ?? body.trim();
	const suffix = detail.length === 0 ? "" : `: ${detail}`;
	return new SnoObserveError(code, `${action} failed with HTTP ${status}${suffix}`);
}

function parseServerError(value: unknown): ErrorResponse | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const candidate = value as ErrorResponse;
	return {
		...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
		...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
	};
}

function parseErrorCode(value: unknown): string | null {
	return parseServerError(value)?.error ?? null;
}

function parseServerIntervalMs(value: unknown): number | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const interval = (value as ErrorResponse).interval;
	return typeof interval === "number" && Number.isFinite(interval) && interval > 0
		? normalizeDelay(interval * 1000)
		: null;
}

function normalizeDelay(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return DEFAULT_POLL_INTERVAL_MS;
	}
	return Math.min(MAX_POLL_INTERVAL_MS, Math.max(1000, Math.floor(value)));
}

function assertClaimCanContinue(input: PollInput): void {
	throwIfAborted(input.signal);
	if (Date.now() - input.startedAt >= input.timeoutMs) {
		throw new SnoObserveError("claim_timeout", "device authorization timed out");
	}
}

async function sleepWithinTimeout(
	delayMs: number,
	startedAt: number,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	const remainingMs = timeoutMs - (Date.now() - startedAt);
	if (remainingMs <= 0) {
		throw new SnoObserveError("claim_timeout", "device authorization timed out");
	}
	const sleepMs = Math.min(delayMs, remainingMs);
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortClaimError());
		};
		const timer = setTimeout(finish, sleepMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw abortClaimError();
	}
}

function normalizeAbortError(error: unknown, signal?: AbortSignal): never {
	if (isAbortError(error) || signal?.aborted) {
		throw abortClaimError();
	}
	throw error;
}

function abortClaimError(): SnoObserveError {
	return new SnoObserveError("claim_aborted", "device authorization aborted");
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
