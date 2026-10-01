import { numberEnv } from "./config";
import { requestJson } from "./http";
import { getArrayField, getStringField, isRecord } from "./json";
import { NonRetryableEvidenceError, type TestConfig } from "./types";
import {
	isCuid2,
	isLowercaseCanonicalUUIDv7,
} from "../../../../../packages/common-core/src/index";

export type ObserveConsentLevel = "off" | "metadata-only" | "full";

export async function readObserveActivity(
	config: TestConfig,
	machineSecret: string,
	since: string,
) {
	const pages: unknown[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	const maxPages = numberEnv("SNO_AGENT_E2E_ACTIVITY_MAX_PAGES", 10);

	for (let page = 0; page < maxPages; page += 1) {
		const response = await requestActivityPage(
			config,
			machineSecret,
			since,
			cursor,
		);
		pages.push(response.body);
		const nextCursor = getActivityNextCursor(response.body);
		if (!nextCursor || seenCursors.has(nextCursor)) {
			break;
		}
		if (page === maxPages - 1) {
			throw new NonRetryableEvidenceError(
				`Sno activity evidence exceeded SNO_AGENT_E2E_ACTIVITY_MAX_PAGES=${maxPages}; negative assertions would be truncated.`,
			);
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}

	return { body: pages.length === 1 ? pages[0] : { pages } };
}

export async function verifyAuditEvent(
	config: TestConfig,
	machineSecret: string,
	eventId: string,
) {
	const url = new URL(`${config.observeBaseUrl}/api/v1/audit/verify`);
	url.searchParams.set("event_id", eventId);
	return requestJson(url.toString(), {
		headers: { Authorization: `Bearer ${machineSecret}` },
		timeoutMs: 30_000,
	});
}

export async function readObserveConsent(
	config: TestConfig,
	machineSecret: string,
	machineUuid: string,
) {
	const url = new URL(`${config.observeBaseUrl}/api/v1/consent`);
	url.searchParams.set("lane", "memory");
	url.searchParams.set("machine_uuid", machineUuid);
	const response = await requestJson(url.toString(), {
		headers: { Authorization: `Bearer ${machineSecret}` },
		timeoutMs: 30_000,
	});
	if (response.statusCode < 200 || response.statusCode >= 300) {
		// This external service response cannot decide whether the plugin passes.
		console.warn(
			`Sno consent read advisory: ${url.toString()} HTTP ${response.statusCode}: ${response.text.slice(0, 300)}`,
		);
		return {
			body: response.body,
			level: undefined,
			statusCode: response.statusCode,
		};
	}
	const level = getConsentLevel(response.body);
	if (!level) {
		// This external service response cannot decide whether the plugin passes.
		console.warn(
			`Sno consent read advisory: ${url.toString()} HTTP ${response.statusCode}: ${response.text.slice(0, 300)}`,
		);
		return {
			body: response.body,
			level: undefined,
			statusCode: response.statusCode,
		};
	}
	return { body: response.body, level, statusCode: response.statusCode };
}

export async function setObserveConsent(
	config: TestConfig,
	machineSecret: string,
	input: {
		level: ObserveConsentLevel;
		machineUuid: string;
		reason: string;
	},
) {
	const url = `${config.observeBaseUrl}/api/v1/consent`;
	const response = await requestJson(url, {
		body: {
			lane: "memory",
			level: input.level,
			machine_uuid: input.machineUuid,
			reason: input.reason,
		},
		headers: {
			Authorization: `Bearer ${machineSecret}`,
			"Content-Type": "application/json",
		},
		method: "POST",
		timeoutMs: 30_000,
	});
	if (response.statusCode < 200 || response.statusCode >= 300) {
		// This external service response cannot decide whether the plugin passes.
		console.warn(
			`Sno consent write advisory: ${url} HTTP ${response.statusCode}: ${response.text.slice(0, 300)}`,
		);
		return response;
	}
	const level = getConsentLevel(response.body);
	if (level !== input.level || !hasNonNegativeIntegerField(response.body, "written")) {
		// This external service response cannot decide whether the plugin passes.
		console.warn(
			`Sno consent write advisory: ${url} HTTP ${response.statusCode}: ${response.text.slice(0, 300)}`,
		);
		return response;
	}
	return response;
}

function getConsentLevel(value: unknown): ObserveConsentLevel | undefined {
	const level = getStringField(value, "level");
	return isObserveConsentLevel(level) ? level : undefined;
}

function isObserveConsentLevel(
	value: string | undefined,
): value is ObserveConsentLevel {
	return value === "off" || value === "metadata-only" || value === "full";
}

async function requestActivityPage(
	config: TestConfig,
	machineSecret: string,
	since: string,
	cursor: string | undefined,
) {
	const url = new URL(`${config.observeBaseUrl}/api/v1/activity`);
	url.searchParams.set("limit", "500");
	url.searchParams.set("since", since);
	if (cursor) {
		url.searchParams.set("cursor", cursor);
	}
	const response = await requestJson(url.toString(), {
		headers: { Authorization: `Bearer ${machineSecret}` },
		timeoutMs: 30_000,
	});
	if (response.statusCode === 429) {
		throw new NonRetryableEvidenceError(
			`Sno activity rate limited with HTTP 429: ${response.text}`,
		);
	}
	if (response.statusCode < 200 || response.statusCode >= 300) {
		const message = `Sno activity failed with HTTP ${response.statusCode}: ${response.text}`;
		if (response.statusCode >= 400 && response.statusCode < 500) {
			throw new NonRetryableEvidenceError(message);
		}
		// This external service response cannot decide whether the plugin passes.
		console.warn(
			`Sno activity read advisory: ${url.toString()} HTTP ${response.statusCode}: ${response.text.slice(0, 300)}`,
		);
		return response;
	}
	assertActivityPageBody(response.body, response.text);
	return response;
}

function getActivityNextCursor(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return getStringField(value, "next_cursor");
}

function assertActivityPageBody(value: unknown, text: string): void {
	if (!isRecord(value) || !Array.isArray(value.events)) {
		throw new NonRetryableEvidenceError(
			`Sno activity returned unexpected contract shape: ${text}`,
		);
	}
	const nextCursor = value.next_cursor;
	if (nextCursor !== undefined && typeof nextCursor !== "string") {
		throw new NonRetryableEvidenceError(
			`Sno activity returned invalid next_cursor: ${text}`,
		);
	}
	for (const event of getArrayField(value, "events")) {
		if (!isRecord(event) || !isActivityEventShape(event)) {
			throw new NonRetryableEvidenceError(
				`Sno activity returned invalid event row: ${text}`,
			);
		}
	}
}

function isActivityEventShape(value: Record<string, unknown>): boolean {
	return (
		typeof value.event_id === "string" &&
		isLowercaseCanonicalUUIDv7(value.event_id) &&
		isDigitsUint64(value.ts_server_ms) &&
		typeof value.event_type === "string" &&
		isActivityLane(value.lane) &&
		isObserveConsentLevel(
			typeof value.consent_level === "string"
				? value.consent_level
				: undefined,
		) &&
		typeof value.redacted === "boolean" &&
		isActivityScopeShape(value.scope) &&
		(isRecord(value.payload) || value.payload === "[GDPR_SCRUBBED]")
	);
}

function isActivityScopeShape(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.user_id === "string" &&
		isCuid2(value.user_id) &&
		typeof value.machine_id === "string" &&
		isLowercaseCanonicalUUIDv7(value.machine_id) &&
		typeof value.agent_id === "string" &&
		(value.user_account_id === null ||
			(typeof value.user_account_id === "string" && isCuid2(value.user_account_id))) &&
		(value.project_id === null ||
			(typeof value.project_id === "string" && value.project_id.length > 0)) &&
		(value.session_uuid === null ||
			(typeof value.session_uuid === "string" &&
				isLowercaseCanonicalUUIDv7(value.session_uuid)))
	);
}

function isActivityLane(value: unknown): boolean {
	return (
		value === "memory" ||
		value === "llm" ||
		value === "skill" ||
		value === "security"
	);
}

function hasNonNegativeIntegerField(value: unknown, key: string): boolean {
	return (
		isRecord(value) &&
		typeof value[key] === "number" &&
		Number.isInteger(value[key]) &&
		value[key] >= 0
	);
}

function isDigitsUint64(value: unknown): boolean {
	if (typeof value !== "string" || value.length === 0) {
		return false;
	}
	for (const char of value) {
		if (char < "0" || char > "9") {
			return false;
		}
	}
	if (value.length > 1 && value.startsWith("0")) {
		return false;
	}
	return BigInt(value) <= 18_446_744_073_709_551_615n;
}
