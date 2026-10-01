import type { JsonObject, JsonValue } from "./types";

export function parseJson(text: string): unknown {
	if (text.trim() === "") {
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export function parseJsonMaybe(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

export function getArrayField(value: unknown, key: string): unknown[] {
	if (!isRecord(value) || !Array.isArray(value[key])) {
		return [];
	}
	return value[key];
}

export function getObjectField(
	value: unknown,
	key: string,
): Record<string, JsonValue> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const field = value[key];
	if (isRecord(field)) {
		return field;
	}
	if (typeof field === "string") {
		const parsed = parseJsonMaybe(field);
		return isRecord(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function getStringField(
	value: unknown,
	key: string,
): string | undefined {
	if (!isRecord(value) || typeof value[key] !== "string") {
		return undefined;
	}
	return value[key];
}

export function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
