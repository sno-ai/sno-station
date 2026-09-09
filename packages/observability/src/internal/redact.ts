import { existsSync, readFileSync } from "node:fs";
import { logger } from "./log.js";
import type { ConsentValue, JsonObject, JsonValue } from "./types.js";

const REDACTED_EMAIL = "<email>";
const REDACTED_PHONE = "<phone>";
const REDACTED_CARD = "<card>";
const REDACTED_KEY = "<api-key>";
const REDACTED_IP = "<ip>";
const REDACTED_CONTENT = "<content>";
const MAX_USER_RULE_LENGTH = 256;
const USER_RULE_CACHE_TTL_MS = 5_000;
const NESTED_QUANTIFIER_PATTERN =
	/\((?:\?:|\?=|\?!|\?<=|\?<!)?(?:[^()\\]|\\.)*(?:[+*]|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+(?:,\d*)?\})/u;

const sensitiveKeys = new Set([
	"prompt_text",
	"message",
	"content",
	"text",
	"body",
	"input",
	"output",
	"file_contents",
	"memory_text",
]);

export interface RedactionResult {
	value: JsonObject;
	redacted: boolean;
}

interface UserRuleCacheEntry {
	loadedAtMs: number;
	rules: RegExp[];
}

const userRuleCache = new Map<string, UserRuleCacheEntry>();

export function redactEventPayload(
	payload: JsonObject,
	consent: ConsentValue,
	userRulePath?: string,
): RedactionResult {
	const userRules = loadUserRules(userRulePath);
	const result = redactValue(payload, consent, userRules, false);
	if (typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) {
		return { value: {}, redacted: result.redacted };
	}
	return { value: result.value as JsonObject, redacted: result.redacted };
}

export function redactScope(scope: JsonObject, userRulePath?: string): RedactionResult {
	const userRules = loadUserRules(userRulePath);
	const result = redactValue(scope, "full", userRules, false);
	return { value: result.value as JsonObject, redacted: result.redacted };
}

function redactValue(
	value: JsonValue,
	consent: ConsentValue,
	userRules: RegExp[],
	forceContent: boolean,
): { value: JsonValue; redacted: boolean } {
	if (typeof value === "string") {
		if (forceContent || consent === "off") {
			return { value: REDACTED_CONTENT, redacted: value.length > 0 };
		}
		return redactString(value, userRules);
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((entry) => {
			const result = redactValue(entry, consent, userRules, forceContent);
			changed ||= result.redacted;
			return result.value;
		});
		return { value: next, redacted: changed };
	}
	if (value !== null && typeof value === "object") {
		let changed = false;
		const output: JsonObject = {};
		for (const [key, entry] of Object.entries(value)) {
			const shouldStripContent = consent !== "full" && sensitiveKeys.has(key);
			const result = redactValue(entry, consent, userRules, forceContent || shouldStripContent);
			changed ||= result.redacted;
			output[key] = result.value;
		}
		return { value: output, redacted: changed };
	}
	return { value, redacted: false };
}

function redactString(input: string, userRules: RegExp[]): { value: string; redacted: boolean } {
	let value = input;
	value = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, REDACTED_EMAIL);
	// IPs must run before the phone regex: dotted-quad strings like
	// "192.168.555.1234" can otherwise match the (3-3-4) phone pattern first
	// and become "<phone>" instead of "<ip>".
	value = value.replace(
		/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/gu,
		REDACTED_IP,
	);
	value = value.replace(/\b(?:[0-9a-f]{1,4}:){5,7}[0-9a-f]{1,4}\b/giu, REDACTED_IP);
	value = value.replace(
		/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/gu,
		REDACTED_PHONE,
	);
	value = value.replace(/\b(?:\d[ -]?){13,19}\b/gu, (candidate) =>
		passesLuhn(candidate) ? REDACTED_CARD : candidate,
	);
	value = value.replace(
		/\b(?:sk[_-](?:live[_-])?[A-Za-z0-9_-]{16,}|pk[_-](?:live[_-])?[A-Za-z0-9_-]{16,}|gh[ps]_[A-Za-z0-9_]{16,}|xox[bp]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/gu,
		REDACTED_KEY,
	);
	value = value.replace(
		/"private_key"\s*:\s*"-----BEGIN (?:RSA )?PRIVATE KEY-----[^"]+"/gu,
		REDACTED_KEY,
	);
	for (const rule of userRules) {
		value = value.replace(rule, REDACTED_CONTENT);
	}
	return { value, redacted: value !== input };
}

function loadUserRules(path?: string): RegExp[] {
	if (path === undefined) {
		return [];
	}
	const now = Date.now();
	const cached = userRuleCache.get(path);
	if (cached !== undefined && now - cached.loadedAtMs < USER_RULE_CACHE_TTL_MS) {
		return cached.rules;
	}
	if (!existsSync(path)) {
		userRuleCache.set(path, { loadedAtMs: now, rules: [] });
		return [];
	}
	const contents = readFileSync(path, "utf8");
	const rules: RegExp[] = [];
	for (const line of contents.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) {
			continue;
		}
		const unsafeReason = unsafeUserRuleReason(trimmed);
		if (unsafeReason !== undefined) {
			logger.warn("unsafe redaction rule ignored", {
				path,
				pattern_length: trimmed.length,
				reason: unsafeReason,
			}, {
				event_name: "sno.observe.internal.redact.loaduserrules",
				file: "packages/sno-observe/src/internal/redact.ts",
				function: "loadUserRules",
				site_id: "sno.observe.internal.redact.loaduserrules.1",
			});
			continue;
		}
		try {
			rules.push(new RegExp(trimmed, "gu"));
		} catch (error) {
			logger.warn("invalid redaction rule ignored", {
				path,
				pattern_length: trimmed.length,
				error,
			}, {
				event_name: "sno.observe.internal.redact.loaduserrules",
				file: "packages/sno-observe/src/internal/redact.ts",
				function: "loadUserRules",
				site_id: "sno.observe.internal.redact.loaduserrules.2",
			});
		}
	}
	userRuleCache.set(path, { loadedAtMs: now, rules });
	return rules;
}

function unsafeUserRuleReason(pattern: string): string | undefined {
	if (pattern.length > MAX_USER_RULE_LENGTH) {
		return "too_long";
	}
	if (NESTED_QUANTIFIER_PATTERN.test(pattern)) {
		return "nested_quantifier";
	}
	return undefined;
}

function passesLuhn(input: string): boolean {
	const digits = input.replace(/\D/gu, "");
	if (digits.length < 13 || digits.length > 19) {
		return false;
	}
	let sum = 0;
	let doubleDigit = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		const digit = Number(digits.charAt(index));
		let addend = digit;
		if (doubleDigit) {
			addend *= 2;
			if (addend > 9) {
				addend -= 9;
			}
		}
		sum += addend;
		doubleDigit = !doubleDigit;
	}
	return sum % 10 === 0;
}
