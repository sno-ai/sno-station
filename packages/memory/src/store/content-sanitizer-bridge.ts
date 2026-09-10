/** @file content-sanitizer-bridge.ts
 * @purpose Adapts sno-station-mem storage inputs to the shared content sanitizer package.
 * @boundary Thin storage adapter only; sanitizer policy lives in @snoai/content-sanitizer.
 */

import {
	redactForStorage,
	sanitizeContentIngress,
	sanitizeStructuredJsonForStorage,
	type SanitizerSource,
} from "@snoai/content-sanitizer";
import { redactSecrets } from "../engine/security/redact";
import type { StoreInput, UpdateChanges } from "./memory-store-shared";

const METADATA_FIELD_SANITIZE_FAILURE_MARKER = "[REDACTED_PRIVATE]";
const INTERNAL_IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;

function readInternalIdempotencyKey(metadata: unknown): string | undefined {
	let parsed = metadata;
	if (typeof metadata === "string") {
		try {
			parsed = JSON.parse(metadata) as unknown;
		} catch {
			return undefined;
		}
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const value = Reflect.get(parsed, "idempotency_key");
	return typeof value === "string" && INTERNAL_IDEMPOTENCY_KEY_PATTERN.test(value)
		? value
		: undefined;
}

function redactMetadataValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map(redactMetadataValue);
	if (typeof value !== "object" || value === null) return value;
	const redacted: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		redacted[key] = redactMetadataValue(Reflect.get(value, key));
	}
	return redacted;
}

function redactStructuredMetadata(sanitized: string, idempotencyKey: string | undefined): string {
	const parsed = JSON.parse(sanitized) as unknown;
	const redacted = redactMetadataValue(parsed);
	if (idempotencyKey && typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)) {
		Reflect.set(redacted, "idempotency_key", idempotencyKey);
	}
	return JSON.stringify(redacted);
}

export function sanitizeMemoryTextForStorage(
	text: string,
	source: SanitizerSource = "generic-text",
): string {
	const sanitized = sanitizeContentIngress({
		source,
		content: text,
	}).projections.plainText;
	return redactSecrets(sanitized);
}

export function sanitizeMemoryMetadataString(metadata: string | undefined): string | undefined {
	if (metadata === undefined) return undefined;
	if (metadata.trim().length === 0) return metadata;
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata) as unknown;
	} catch {
		const sanitized = redactForStorage(metadata, {
			source: "generic-text",
			contentType: "structured_json",
		}).text;
		return redactSecrets(sanitized);
	}
	const idempotencyKey = readInternalIdempotencyKey(parsed);
	try {
		const sanitized = sanitizeStructuredJsonForStorage(parsed, {
			source: "generic-text",
			contentType: "structured_json",
		}).text;
		return redactStructuredMetadata(sanitized, idempotencyKey);
	} catch {
		const sanitized = redactForStorage(metadata, {
			source: "generic-text",
			contentType: "structured_json",
		}).text;
		return redactSecrets(sanitized);
	}
}

function sanitizeMetadataField(key: string, value: unknown): unknown {
	const sanitized = sanitizeStructuredJsonForStorage(
		{ [key]: value },
		{
			source: "generic-text",
			contentType: "structured_json",
		},
	).value;
	if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
		return (sanitized as Record<string, unknown>)[key];
	}
	return METADATA_FIELD_SANITIZE_FAILURE_MARKER;
}

function sanitizeMemoryMetadataFields(metadata: object): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	for (const key of Object.keys(metadata)) {
		try {
			sanitized[key] = sanitizeMetadataField(key, Reflect.get(metadata, key));
		} catch {
			sanitized[key] = METADATA_FIELD_SANITIZE_FAILURE_MARKER;
		}
	}
	return sanitized;
}

export function sanitizeMemoryMetadataObject<T extends object>(metadata: T): T {
	try {
		const sanitized = sanitizeStructuredJsonForStorage(metadata, {
			source: "generic-text",
			contentType: "structured_json",
		}).value;
		if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
			return sanitized as T;
		}
	} catch {
		try {
			return sanitizeMemoryMetadataFields(metadata) as T;
		} catch {
			return {} as T;
		}
	}
	try {
		return sanitizeMemoryMetadataFields(metadata) as T;
	} catch {
		return {} as T;
	}
}

export function sanitizeStoreInput(entry: StoreInput): StoreInput {
	return {
		...entry,
		text: sanitizeMemoryTextForStorage(entry.text),
		metadata: sanitizeMemoryMetadataString(entry.metadata),
	};
}

export function sanitizeUpdateChanges(changes: UpdateChanges): UpdateChanges {
	return {
		...changes,
		...(changes.text !== undefined ? { text: sanitizeMemoryTextForStorage(changes.text) } : {}),
		...(changes.metadata !== undefined
			? { metadata: sanitizeMemoryMetadataString(changes.metadata) ?? changes.metadata }
			: {}),
	};
}
