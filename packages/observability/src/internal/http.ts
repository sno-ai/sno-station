import { TransportError } from "./errors.js";

export interface EventPostResult {
	status: number;
	body: string;
	retryAfterMs: number | null;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Reject non-HTTPS base URLs (except localhost for tests/dev). Bearer tokens and
// event payloads MUST NOT be sent over plaintext HTTP.
export function normalizeBaseUrl(input: string): string {
	const trimmed = input.replace(/\/$/u, "");
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new TransportError(`invalid SNO_OBSERVE_BASE_URL: ${input}`);
	}
	if (parsed.protocol === "https:") {
		return trimmed;
	}
	if (parsed.protocol === "http:" && LOCAL_HOSTNAMES.has(parsed.hostname)) {
		return trimmed;
	}
	throw new TransportError(
		`SNO_OBSERVE_BASE_URL must use https:// (got ${parsed.protocol}//${parsed.hostname})`,
	);
}

export async function postEvent(
	baseUrl: string,
	body: string,
	bearer?: string,
	fetchImpl: typeof fetch = fetch,
): Promise<EventPostResult> {
	const headers: {
		"Content-Type": string;
		Authorization?: string;
	} = {
		"Content-Type": "application/json",
	};
	if (bearer !== undefined) {
		headers.Authorization = `Bearer ${bearer}`;
	}
	const response = await fetchImpl(`${baseUrl.replace(/\/$/u, "")}/api/v1/events`, {
		method: "POST",
		headers,
		body,
	});
	// Body-read failures after the response resolved (truncated stream, abort
	// during body, decoder error) MUST NOT propagate as transport errors —
	// the server already saw the request and consumed any bearer attached to
	// it. Treat the body as empty in that case so flush.ts routes by status.
	let responseBody = "";
	try {
		responseBody = await response.text();
	} catch {}
	return {
		status: response.status,
		body: responseBody,
		retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
	};
}

export async function fetchJson<T>(
	url: string,
	init: RequestInit,
	fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; value: T | null; body: string; headers: Headers }> {
	const response = await fetchImpl(url, init);
	const body = await response.text();
	if (body.length === 0) {
		return { status: response.status, value: null, body, headers: response.headers };
	}
	try {
		return {
			status: response.status,
			value: JSON.parse(body) as T,
			body,
			headers: response.headers,
		};
	} catch {
		throw new TransportError(`invalid JSON response from ${url}`);
	}
}

export function parseRetryAfter(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}
	const date = Date.parse(value);
	if (Number.isNaN(date)) {
		return null;
	}
	return Math.max(0, date - Date.now());
}
