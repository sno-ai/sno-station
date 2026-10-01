/** @file memory-metadata-normalizers.ts
 * @purpose Normalizes raw metadata values into insight metadata primitives.
 * @boundary Primitive coercion and default layer/category derivation only.
 */

import type { MemoryLayer, MemorySource, MemoryState } from "./memory-metadata-types";
import { type MemoryCategory, type MemoryTier, normalizeCategory } from "../shared/types";

export type FactKeySource = {
	kind: MemoryCategory;
	section_name?: unknown;
	anti_pattern_signature?: unknown;
	active_task_kind?: unknown;
	active_task_id?: unknown;
};

export function validateMemoryCategory(raw: string): MemoryCategory | undefined {
	return normalizeCategory(raw) ?? undefined;
}

export function clamp01(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(1, Math.max(0, n));
}

export function clampCount(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n < 0) return fallback;
	return Math.floor(n);
}

export function normalizeTier(value: unknown): MemoryTier {
	switch (value) {
		case "core":
		case "working":
		case "peripheral":
			return value;
		default:
			return "working";
	}
}

export function normalizeState(value: unknown): MemoryState {
	switch (value) {
		case "pending":
		case "confirmed":
		case "archived":
			return value;
		default:
			return "confirmed";
	}
}

export function normalizeSource(value: unknown): MemorySource {
	switch (value) {
		case "manual":
		case "ambient-learning":
		case "agent_end":
		case "reflection":
		case "session-summary":
		case "legacy":
			return value;
		default:
			return "legacy";
	}
}

export function normalizeLayer(value: unknown): MemoryLayer {
	switch (value) {
		case "durable":
		case "working":
		case "reflection":
		case "archive":
			return value;
		default:
			return "working";
	}
}

export function deriveDefaultLayer(
	source: MemorySource,
	memoryCategory: MemoryCategory,
	state: MemoryState,
): MemoryLayer {
	if (source === "reflection" || source === "session-summary") return "reflection";
	if (state === "archived") return "archive";
	if (memoryCategory === "summary") return "reflection";
	if (
		memoryCategory === "profile" ||
		memoryCategory === "persona" ||
		memoryCategory === "episodic" ||
		memoryCategory === "lesson"
	) {
		return "durable";
	}
	return "working";
}

export function defaultOverview(text: string): string {
	return `- ${text}`;
}

export function normalizeText(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function normalizeOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeTimestamp(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

export function normalizeOptionalTimestamp(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return Math.floor(n);
}

export function deriveFactKey(metadata: FactKeySource): string | undefined {
	if (metadata.kind === "profile" || metadata.kind === "persona") {
		const sectionName = normalizeOptionalString(metadata.section_name);
		if (
			metadata.kind === "profile" &&
			sectionName === "active_tasks" &&
			metadata.active_task_kind === "task"
		) {
			const taskId = normalizeOptionalString(metadata.active_task_id);
			return taskId ? `profile:active_tasks:${taskId}` : undefined;
		}
		return sectionName ? `${metadata.kind}:${sectionName}` : undefined;
	}
	if (metadata.kind === "lesson") {
		const signature = normalizeOptionalString(metadata.anti_pattern_signature);
		return signature ? `lesson:${signature}` : undefined;
	}
	return undefined;
}
