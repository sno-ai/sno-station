import { TransportError } from "./errors.js";

export interface EventPostResult {
	status: number;
	body: string;
	retryAfterMs: number | null;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_EVENT_RESPONSE_BODY_BYTES = 64 * 1024;

// Reject non-HTTPS base URLs (except localhost for tests/dev). Machine bearer
// credentials and event payloads MUST NOT be sent over plaintext HTTP.
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
	signal?: AbortSignal,
): Promise<EventPostResult> {
	const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
	const headers: {
		"Content-Type": string;
		Authorization?: string;
	} = {
		"Content-Type": "application/json",
	};
	if (bearer !== undefined) {
		headers.Authorization = `Bearer ${bearer}`;
	}
	const response = await fetchImpl(`${normalizedBaseUrl}/api/v1/events`, {
		method: "POST",
		headers,
		body,
		signal: withRequestTimeout(signal),
		redirect: "error",
	});
	// Body-read failures after the response resolved (truncated stream, abort
	// during body, decoder error) MUST NOT propagate as transport errors —
	// the server already saw the request and consumed any bearer attached to
	// it. Treat the body as empty in that case so flush.ts routes by status.
	let responseBody = "";
	try {
		responseBody = await readBoundedEventResponse(response);
	} catch {}
	return {
		status: response.status,
		body: responseBody,
		retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
	};
}

async function readBoundedEventResponse(response: Response): Promise<string> {
	if (response.body === null) {
		return "";
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_EVENT_RESPONSE_BODY_BYTES) {
				await reader.cancel().catch(() => {});
				return "";
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

export async function fetchJson<T>(
	url: string,
	init: RequestInit,
	fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; value: T | null; body: string; headers: Headers }> {
	const initWithTimeout: RequestInit = {
		...init,
		signal: withRequestTimeout(init.signal ?? undefined),
		redirect: "error",
	};
	const response = await fetchImpl(url, initWithTimeout);
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

function withRequestTimeout(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export function parseRetryAfter(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return boundedRetryAfter(seconds * 1000);
	}
	const date = Date.parse(value);
	if (Number.isNaN(date)) {
		return null;
	}
	return boundedRetryAfter(date - Date.now());
}

function boundedRetryAfter(delayMs: number): number {
	return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delayMs));
}
