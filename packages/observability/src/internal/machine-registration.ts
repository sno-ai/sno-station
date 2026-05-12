import { createHash } from "node:crypto";
import { isCuid2, isLowercaseCanonicalUUIDv7 } from "@snoai/common-core";
import { SnoObserveError } from "./errors.js";
import { fetchJson, normalizeBaseUrl } from "./http.js";
import { updateValidIdentity } from "./identity.js";
import type { PathEnv } from "./paths.js";
import type { Identity } from "./types.js";

const BASE_URL_ENV = "SNO_OBSERVE_BASE_URL";

export interface RegisterOptions {
	baseUrl?: string;
	env?: PathEnv;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

export interface RegisterResult {
	registered: true;
	claimed: boolean;
	userCuid: string;
	machineUuid: string;
	userAccountId?: string;
}

interface RegisterMachineResponse {
	user_cuid: string;
	machine_uuid: string;
	claimed: boolean;
	user_account_id?: string | null;
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
			...(options.signal === undefined ? {} : { signal: options.signal }),
		},
		options.fetch ?? fetch,
	);
	if (response.status !== 200 || !isRegisterMachineResponse(response.value)) {
		throw registrationError(response.status, response.value, response.body);
	}
	if (
		response.value.user_cuid !== identity.user_cuid ||
		response.value.machine_uuid !== identity.machine_uuid
	) {
		throw new SnoObserveError(
			"machine_registration_identity_mismatch",
			"machine registration returned a different identity",
		);
	}
	const userAccountId =
		typeof response.value.user_account_id === "string" ? response.value.user_account_id : undefined;
	if (userAccountId !== undefined) {
		persistServerAccount(identity, userAccountId, env);
	}
	return {
		registered: true,
		claimed: response.value.claimed === true,
		userCuid: response.value.user_cuid,
		machineUuid: response.value.machine_uuid,
		...(userAccountId === undefined ? {} : { userAccountId }),
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
		isCuid2(candidate.user_cuid) &&
		typeof candidate.machine_uuid === "string" &&
		isLowercaseCanonicalUUIDv7(candidate.machine_uuid) &&
		typeof candidate.claimed === "boolean" &&
		(candidate.user_account_id === undefined ||
			candidate.user_account_id === null ||
			(typeof candidate.user_account_id === "string" && isCuid2(candidate.user_account_id)))
	);
}

function persistServerAccount(identity: Identity, userAccountId: string, env: PathEnv): void {
	updateValidIdentity(
		(current) =>
			current.user_cuid === identity.user_cuid && current.machine_uuid === identity.machine_uuid
				? { ...current, user_account_id: userAccountId }
				: current,
		env,
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
