import { fetchJson, normalizeBaseUrl } from "./http.js";
import type { AuditVerifyResult } from "./types.js";

const BASE_URL_ENV = "SNO_OBSERVE_BASE_URL";
const API_KEY_ENV = "SNO_API_KEY";

export async function verifyAuditEvent(
	eventId: string,
	options: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<AuditVerifyResult> {
	const baseUrl = normalizeBaseUrl(
		options.baseUrl ?? process.env[BASE_URL_ENV] ?? "https://www.sno.ai",
	);
	const headers: Record<string, string> = {};
	const apiKey = process.env[API_KEY_ENV]?.trim();
	if (apiKey !== undefined && apiKey.length > 0) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const response = await fetchJson<AuditVerifyResult>(
		`${baseUrl}/api/v1/audit/verify?event_id=${encodeURIComponent(eventId)}`,
		{ method: "GET", headers },
		options.fetch ?? fetch,
	);
	if (response.status === 404) {
		throw new Error("event not found or not owned");
	}
	if (response.status === 401) {
		throw new Error(`audit verify failed with HTTP ${response.status}`);
	}
	if (response.status !== 200 || response.value === null) {
		throw new Error(`audit verify returned HTTP ${response.status}`);
	}
	return response.value;
}
