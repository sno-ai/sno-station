/** @file reflection-entry-utils.ts
 * @purpose Shared parsing and ownership helpers for reflection projection.
 * @boundary Side-effect-free helpers for metadata and numeric fallback handling.
 */

import type { ReflectionMappedKind } from "./mapped-memory-metadata-builder";

export function isReflectionMetadataType(type: unknown): boolean {
	return type === "memory-reflection-item" || type === "memory-reflection";
}

export function isOwnedByAgent(metadata: Record<string, unknown>, agentId: string): boolean {
	const owner = typeof metadata.agentId === "string" ? metadata.agentId.trim() : "";
	const itemKind = metadata.itemKind;

	if (itemKind === "derived") {
		if (!owner) return agentId === "main";
		return owner === agentId;
	}

	if (itemKind === undefined || itemKind === "invariant") {
		if (!owner) return agentId === "main";
		return owner === agentId || owner === "main";
	}

	return false;
}

export function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item).trim()).filter(Boolean);
}

export function metadataTimestamp(metadata: Record<string, unknown>, fallbackTs: number): number {
	const storedAt = Number(metadata.storedAt);
	if (Number.isFinite(storedAt) && storedAt > 0) return storedAt;
	return Number.isFinite(fallbackTs) ? fallbackTs : Date.now();
}

export function readPositiveNumber(value: unknown, fallback: number): number {
	const num = Number(value);
	if (!Number.isFinite(num) || num <= 0) return fallback;
	return num;
}

export function readClampedNumber(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number {
	const num = Number(value);
	const resolved = Number.isFinite(num) ? num : fallback;
	return Math.max(min, Math.min(max, resolved));
}

export function parseMappedKind(value: unknown): ReflectionMappedKind | null {
	if (
		value === "user-model" ||
		value === "agent-model" ||
		value === "lesson" ||
		value === "decision"
	) {
		return value;
	}
	return null;
}
