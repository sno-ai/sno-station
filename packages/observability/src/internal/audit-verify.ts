import { fetchJson, normalizeBaseUrl } from "./http.js";
import type { AuditVerifyResult } from "./types.js";

const BASE_URL_ENV = "SNO_OBSERVE_BASE_URL";

interface ErrorResponse {
	error?: string;
	message?: string;
}

export async function verifyAuditEvent(
	eventId: string,
	options: { baseUrl?: string; machineSecret: string; fetch?: typeof fetch },
): Promise<AuditVerifyResult> {
	const baseUrl = normalizeBaseUrl(
		options.baseUrl ?? process.env[BASE_URL_ENV] ?? "https://sno.ai",
	);
	const response = await fetchJson<AuditVerifyResult | ErrorResponse>(
		`${baseUrl}/api/v1/audit/verify?event_id=${encodeURIComponent(eventId)}`,
		{
			method: "GET",
			headers: { Authorization: `Bearer ${options.machineSecret}` },
		},
		options.fetch ?? fetch,
	);
	if (response.status === 404) {
		throw new Error("event not found or not owned");
	}
	if (response.status !== 200 || response.value === null) {
		throw new Error(auditErrorMessage(response.status, response.value, response.body));
	}
	return response.value as AuditVerifyResult;
}

function auditErrorMessage(status: number, value: unknown, body: string): string {
	const error = parseErrorResponse(value);
	const detail = error?.message ?? error?.error ?? body.trim();
	const suffix = detail.length === 0 ? "" : `: ${detail}`;
	return `audit verify failed with HTTP ${status}${suffix}`;
}

function parseErrorResponse(value: unknown): ErrorResponse | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const candidate = value as ErrorResponse;
	return {
		...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
		...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
	};
}
