import { SnoObserveError } from "./errors.js";
import { fetchJson, normalizeBaseUrl } from "./http.js";
import { updateIdentity } from "./identity.js";
import { type RegisterOptions, registerMachine } from "./machine-registration.js";
import type { PathEnv } from "./paths.js";
import type { Identity } from "./types.js";

const BASE_URL_ENV = "SNO_OBSERVE_BASE_URL";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_POLL_INTERVAL_MS = 30000;

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
	status: "claimed";
}

interface ErrorResponse {
	error?: string;
	message?: string;
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

	const registerOptions: RegisterOptions = {
		baseUrl,
		env,
		...(options.fetch === undefined ? {} : { fetch: fetchImpl }),
	};
	await registerMachine(identity, registerOptions);

	const code = await requestDeviceCode(identity, baseUrl, fetchImpl);
	options.onCode?.(code);

	const userAccountId = await pollForClaim({
		baseUrl,
		deviceCode: code.deviceCode,
		fetchImpl,
		pollIntervalMs: options.pollIntervalMs ?? code.interval * 1000,
		startedAt,
		timeoutMs,
	});

	updateIdentity(
		(current) =>
			current.user_cuid === identity.user_cuid && current.machine_uuid === identity.machine_uuid
				? { ...current, user_account_id: userAccountId }
				: current,
		env,
	);

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
		},
		fetchImpl,
	);
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

async function pollForClaim(input: {
	baseUrl: string;
	deviceCode: string;
	fetchImpl: typeof fetch;
	pollIntervalMs: number;
	startedAt: number;
	timeoutMs: number;
}): Promise<string> {
	let delayMs = normalizeDelay(input.pollIntervalMs);
	for (;;) {
		if (Date.now() - input.startedAt >= input.timeoutMs) {
			throw new SnoObserveError("claim_timeout", "device authorization timed out");
		}
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
			},
			input.fetchImpl,
		);
		if (response.status === 200 && isDeviceTokenResponse(response.value)) {
			return response.value.user_account_id;
		}
		const errorCode = parseErrorCode(response.value);
		if (response.status === 400 && errorCode === "authorization_pending") {
			await sleepWithinTimeout(delayMs, input.startedAt, input.timeoutMs);
			continue;
		}
		if (response.status === 400 && errorCode === "slow_down") {
			delayMs = normalizeDelay(delayMs + 5000);
			await sleepWithinTimeout(delayMs, input.startedAt, input.timeoutMs);
			continue;
		}
		throw claimError("device token request", response.status, response.value, response.body);
	}
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
		candidate.verification_uri.length > 0 &&
		(candidate.verification_uri_complete === undefined ||
			typeof candidate.verification_uri_complete === "string") &&
		typeof candidate.expires_in === "number" &&
		Number.isFinite(candidate.expires_in) &&
		(candidate.interval === undefined ||
			(typeof candidate.interval === "number" && Number.isFinite(candidate.interval)))
	);
}

function isDeviceTokenResponse(value: unknown): value is DeviceTokenResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as DeviceTokenResponse;
	return (
		candidate.status === "claimed" &&
		typeof candidate.user_account_id === "string" &&
		candidate.user_account_id.length > 0
	);
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

function normalizeDelay(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return DEFAULT_POLL_INTERVAL_MS;
	}
	return Math.min(MAX_POLL_INTERVAL_MS, Math.max(1000, Math.floor(value)));
}

async function sleepWithinTimeout(
	delayMs: number,
	startedAt: number,
	timeoutMs: number,
): Promise<void> {
	const remainingMs = timeoutMs - (Date.now() - startedAt);
	if (remainingMs <= 0) {
		throw new SnoObserveError("claim_timeout", "device authorization timed out");
	}
	await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
}
