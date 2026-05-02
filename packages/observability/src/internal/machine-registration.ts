import { createHash } from "node:crypto";
import { SnoObserveError } from "./errors.js";
import { fetchJson, normalizeBaseUrl } from "./http.js";
import type { PathEnv } from "./paths.js";
import type { Identity } from "./types.js";

const BASE_URL_ENV = "SNO_OBSERVE_BASE_URL";

export interface RegisterOptions {
	baseUrl?: string;
	env?: PathEnv;
	fetch?: typeof fetch;
}

export interface RegisterResult {
	registered: true;
	claimed: boolean;
	userCuid: string;
	machineUuid: string;
}

interface RegisterMachineResponse {
	user_cuid: string;
	machine_uuid: string;
	claimed: boolean;
}

interface ErrorResponse {
	error?: string;
	message?: string;
}

export async function registerMachine(
	identity: Identity,
	options: RegisterOptions = {},
): Promise<RegisterResult> {
	const env = options.env ?? process.env;
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? env[BASE_URL_ENV] ?? "https://www.sno.ai");
	const response = await fetchJson<RegisterMachineResponse | ErrorResponse>(
		`${baseUrl}/api/v1/identity/register-machine`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				user_cuid: identity.user_cuid,
				machine_uuid: identity.machine_uuid,
				machine_secret_hash: machineSecretHash(identity.machine_secret),
			}),
		},
		options.fetch ?? fetch,
	);
	if (response.status !== 200 || !isRegisterMachineResponse(response.value)) {
		throw registrationError(response.status, response.value, response.body);
	}
	return {
		registered: true,
		claimed: response.value.claimed,
		userCuid: response.value.user_cuid,
		machineUuid: response.value.machine_uuid,
	};
}

export function machineSecretHash(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

function isRegisterMachineResponse(value: unknown): value is RegisterMachineResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as RegisterMachineResponse;
	return (
		typeof candidate.user_cuid === "string" &&
		candidate.user_cuid.length > 0 &&
		typeof candidate.machine_uuid === "string" &&
		candidate.machine_uuid.length > 0 &&
		typeof candidate.claimed === "boolean"
	);
}

function registrationError(status: number, value: unknown, body: string): SnoObserveError {
	const serverError = parseServerError(value);
	const code = serverError?.error ?? "machine_registration_failed";
	const detail = serverError?.message ?? serverError?.error ?? body.trim();
	const suffix = detail.length === 0 ? "" : `: ${detail}`;
	return new SnoObserveError(code, `machine registration failed with HTTP ${status}${suffix}`);
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
