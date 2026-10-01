import { expect } from "vitest";
import type { JsonObject } from "./types";

export function memoryRowId(row: JsonObject): string {
	const id = row.id;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`memory row is missing id: ${JSON.stringify(row)}`);
	}
	return id;
}

export function memoryRowText(row: JsonObject): string {
	const text = row.text;
	if (typeof text !== "string") {
		throw new Error(`memory row is missing text: ${JSON.stringify(row)}`);
	}
	return text;
}

export function memoryRowMetadata(row: JsonObject): Record<string, unknown> {
	const raw = row.metadata;
	if (typeof raw !== "string") {
		return {};
	}
	const parsed = JSON.parse(raw) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {};
	}
	return parsed as Record<string, unknown>;
}

export function expectSupersededMemoryRow(
	row: JsonObject,
	options: { supersededBy?: string } = {},
): void {
	const metadata = memoryRowMetadata(row);
	expect(typeof metadata.invalidated_at).toBe("number");
	expect(typeof metadata.superseded_by).toBe("string");
	if (options.supersededBy) {
		expect(metadata.superseded_by).toBe(options.supersededBy);
	}
}

export function expectActiveMemoryRow(row: JsonObject): void {
	const metadata = memoryRowMetadata(row);
	expect(metadata.invalidated_at).toBeUndefined();
	expect(metadata.superseded_by).toBeUndefined();
}

