/** @file memory-store-write-validation.ts
 * @purpose Validates and normalizes memory-kind metadata before direct store writes.
 * @boundary Storage write chokepoint only; extraction owns metadata semantics.
 */

import {
	buildInsightMetadata,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "../engine/extraction/memory-metadata-codec";
import { activeTaskShape } from "../engine/extraction/active-task-projection";
import { canonicalizeProfileSectionName } from "../engine/extraction/b-profile-section-canonicalizer";
import { StorageError } from "../engine/shared/errors";
import { canToolWrite, canTrustedWrite } from "../engine/shared/memory-kind-policy";
import {
	MEMORY_CATEGORIES,
	type MemoryCategory,
	type MemoryLane,
	normalizeCategory,
} from "../engine/shared/types";
import { countTokens } from "@snoai/chunking";
import { createLogger } from "@snoai/utils/logger";
import { DEFAULT_MAX_CONTEXT_TOKENS } from "../../config/index";
import type { Embedder } from "../engine/extraction/embedding-provider-client";
import { Temporal } from "@js-temporal/polyfill";

const log = createLogger("sno-station-mem:active-task-shape-alarm");

export interface StoreWriteValidationInput {
	text: string;
	category: unknown;
	metadata?: string | null;
	timestamp?: number;
	timezone?: string;
	trusted?: boolean;
	system?: boolean;
	offlineFamily?: boolean;
	enforceWriteAuthority?: boolean;
	lane?: MemoryLane;
}

export interface ValidatedStoreWrite {
	category: MemoryCategory;
	metadata: string;
	timezone: string;
}

export interface AtomicCardWriteValidationInput {
	category: "episodic" | "profile" | "state";
	subject: string | null;
	metadata?: Readonly<Record<string, unknown>>;
}

export function validateAtomicCardWrite(input: AtomicCardWriteValidationInput): void {
	if (input.category !== "state") return;
	if (
		input.subject === null ||
		!input.subject.startsWith("entity:") ||
		input.subject.length === "entity:".length
	) {
		throw new StorageError("state memory requires a non-empty entity subject");
	}
	if (Object.hasOwn(input.metadata ?? {}, "event_at")) {
		throw new StorageError("state memory must not carry event_at");
	}
}

function isFixedOffset(value: string): boolean {
	if (value.length !== 6 || (value[0] !== "+" && value[0] !== "-") || value[3] !== ":") {
		return false;
	}
	for (const index of [1, 2, 4, 5]) {
		const code = value.charCodeAt(index);
		if (code < 48 || code > 57) return false;
	}
	try {
		Temporal.PlainDateTime.from("2000-01-01T00:00").toZonedDateTime(value);
		return true;
	} catch {
		return false;
	}
}

function isIanaTimezone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

export function hostTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function validateMemoryTimezone(value: string | undefined, operation: string): string {
	const timezone = value ?? hostTimezone();
	if (timezone === "user" || isFixedOffset(timezone) || isIanaTimezone(timezone)) {
		return timezone;
	}
	throw new StorageError(`${operation}: invalid memory timezone`);
}

function formatCause(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function shapeAlarm(operation: string, reason: string): never {
	log.error("Active task shape validation failed", {
		operation, reason_code: reason.replace(/[^a-z0-9]+/gi, "_").toLowerCase(),
	}, {
		event_name: "sno_station_mem.memory-store-write-validation.active.task.shape.alarm",
		file: "packages/sno-station-mem/src/store/memory-store-write-validation.ts",
		function: "shapeAlarm",
		site_id: "memory-store-write-validation.shapeAlarm.3383666e9c",
	});
	throw new Error(`active-task shape alarm: ${reason}`);
}

function assertActiveTaskShape(
	metadata: ReturnType<typeof parseInsightMetadata>,
	input: StoreWriteValidationInput,
	operation: string,
): void {
	if (
		metadata.kind !== "profile" ||
		metadata.section_name !== "active_tasks" ||
		(input.lane ?? "active") !== "active"
	) {
		return;
	}
	if (metadata.active_task_kind === "projection") {
		// Read the same live bounds the builder used. Pinning this side to the
		// bundled JSON while a restored dictionary moved the builder's bound would
		// either reject writes the builder just made, or silently accept a stale
		// truncation of the only retrievable copy of a task.
		const { maxItems, titleMaxTokens } = activeTaskShape();
		const ids = metadata.active_task_ids;
		const titles = metadata.active_task_titles;
		if (!Array.isArray(ids) || !Array.isArray(titles) || ids.length !== titles.length) {
			shapeAlarm(operation, "projection ids and titles must be parallel arrays");
		}
		if (ids.length > maxItems) {
			shapeAlarm(operation, "projection exceeds the item limit");
		}
		if (new Set(ids).size !== ids.length) {
			shapeAlarm(operation, "projection contains duplicate task ids");
		}
		if (
			titles.some(
				(title) => typeof title !== "string" || countTokens(title) > titleMaxTokens,
			)
		) {
			shapeAlarm(operation, "projection title exceeds the token limit");
		}
		const expectedText =
			titles.length === 0
				? "Active tasks: none"
				: `Active tasks:\n${titles.map((title) => `- ${title}`).join("\n")}`;
		if (input.text !== expectedText || metadata.l2_content !== expectedText) {
			shapeAlarm(operation, "projection text must exactly match its titles");
		}
		return;
	}
	if (metadata.active_task_kind !== "task") {
		shapeAlarm(operation, "active-task domain rows must be a task or projection");
	}
	if (
		typeof metadata.active_task_id !== "string" ||
		metadata.fact_key !== `profile:active_tasks:${metadata.active_task_id}` ||
		metadata.active_task_origin === undefined ||
		metadata.active_task_status === undefined ||
		typeof metadata.active_task_created_at !== "number" ||
		typeof metadata.active_task_transitioned_at !== "number" ||
		!Array.isArray(metadata.active_task_lifecycle) ||
		typeof metadata.l2_content !== "string" ||
		metadata.l2_content.trim().length === 0
	) {
		shapeAlarm(operation, "task row is missing required identity or lifecycle metadata");
	}
	const lifecycle = metadata.active_task_lifecycle;
	const first = lifecycle[0];
	const last = lifecycle[lifecycle.length - 1];
	if (
		lifecycle.length < 1 ||
		lifecycle.length > 2 ||
		first?.from !== null ||
		first.to !== "active" ||
		first.at !== metadata.active_task_created_at ||
		last?.to !== metadata.active_task_status ||
		last.at !== metadata.active_task_transitioned_at
	) {
		shapeAlarm(operation, "task lifecycle timestamps or endpoints are inconsistent");
	}
	if (
		lifecycle.length === 2 &&
		(lifecycle[1]?.from !== "active" ||
			(lifecycle[1].to !== "completed" && lifecycle[1].to !== "removed"))
	) {
		shapeAlarm(operation, "task lifecycle transition is not allowed");
	}
	if (metadata.active_tasks !== undefined) {
		shapeAlarm(operation, "task rows cannot carry an omnibus active_tasks array");
	}
}

function assertLegalAxes(
	metadata: ReturnType<typeof parseInsightMetadata>,
	offlineFamily: boolean,
): void {
	if (metadata.state === "pending") {
		throw new Error("state=pending is not writable");
	}
	if (offlineFamily) return;
	const legal =
		(metadata.kind === "profile" &&
			metadata.state === "confirmed" &&
			metadata.tier === "core") ||
		(metadata.kind === "episodic" &&
			metadata.state === "confirmed" &&
			(metadata.tier === "working" || metadata.tier === "peripheral"));
	if (!legal) {
		throw new Error(
			`forbidden live axes category=${metadata.kind} state=${metadata.state} tier=${metadata.tier}`,
		);
	}
}

/**
 * The exact record counter, ready to use. The embedder's tokenizer loads with its model, and
 * the OpenClaw skin registers without waiting for that load, so a write can arrive first;
 * `warmup()` is memoized and instant once the model is up, so every write door awaits it here
 * rather than throwing on the first capture after boot.
 */
export async function recordTokenCounter(
	embedder: Pick<Embedder, "warmup" | "countTokens">,
): Promise<(text: string) => number> {
	await embedder.warmup();
	return (text) => embedder.countTokens(text);
}

/**
 * The record token ceiling, enforced at the store door. `countRecordTokens` is the
 * embedder's exact count (`Embedder.countTokens`), never a character estimate: the
 * embedder and the reranker both truncate silently past this size, so a longer record
 * would be indexed and ranked on its head only. Refusing is the honest outcome.
 */
export function assertRecordWithinTokenCeiling(
	text: string,
	countRecordTokens: (text: string) => number,
	operation: string,
): void {
	const tokens = countRecordTokens(text);
	if (tokens > DEFAULT_MAX_CONTEXT_TOKENS) {
		throw new StorageError(
			`${operation}: memory text is ${tokens} tokens; DEFAULT_MAX_CONTEXT_TOKENS is ${DEFAULT_MAX_CONTEXT_TOKENS}`,
		);
	}
}

export function validateStoreWriteMetadata(
	input: StoreWriteValidationInput,
	operation: string,
	countRecordTokens: (text: string) => number,
): ValidatedStoreWrite {
	assertRecordWithinTokenCeiling(input.text, countRecordTokens, operation);
	if (typeof input.category !== "string") {
		throw new StorageError(`${operation}: memory category must be a string`);
	}
	const category = normalizeCategory(input.category);
	if (!category) {
		throw new StorageError(
			`${operation}: memory category must be one of ${MEMORY_CATEGORIES.join(", ")}`,
		);
	}
	if (input.enforceWriteAuthority) {
		const allowed =
			input.offlineFamily === true ||
			(input.trusted === true && canTrustedWrite(category)) ||
			(input.system !== true && input.trusted !== true && canToolWrite(category));
		if (!allowed) {
			const boundary =
				category === "profile"
					? "a trusted store boundary"
					: "an offline-family store boundary with offline-family authority";
			throw new StorageError(
				`${operation}: write authority for memory category "${category}" requires ${boundary}`,
			);
		}
	}

	try {
		let metadata = input.metadata ?? undefined;
		if (category === "profile" && metadata) {
			try {
				const raw = JSON.parse(metadata) as unknown;
				if (
					raw &&
					typeof raw === "object" &&
					typeof (raw as { section_name?: unknown }).section_name === "string"
				) {
					metadata = JSON.stringify({
						...raw,
						section_name: canonicalizeProfileSectionName(
							(raw as { section_name: string }).section_name,
						),
					});
				}
			} catch {
				// parseInsightMetadata applies the existing invalid-metadata behavior below.
			}
		}
		const entry = {
			text: input.text,
			category,
			timestamp: input.timestamp,
			metadata,
		};
		const parsed = parseInsightMetadata(metadata, entry);
		let normalized = parsed;
		if (category === "profile") {
			if (typeof parsed.section_name !== "string") {
				throw new Error("profile metadata requires a string section_name");
			}
			normalized = buildInsightMetadata(entry, {
				section_name: canonicalizeProfileSectionName(parsed.section_name),
			});
		}
		if (normalized.kind !== category || normalized.memory_category !== category) {
			throw new Error(
				`row/category/kind mismatch (entry=${category}, kind=${normalized.kind}, memory_category=${normalized.memory_category})`,
			);
		}
		assertLegalAxes(normalized, input.offlineFamily === true);
		assertActiveTaskShape(normalized, input, operation);
		return {
			category,
			metadata: stringifyInsightMetadata(normalized),
			timezone: validateMemoryTimezone(input.timezone, operation),
		};
	} catch (error) {
		throw new StorageError(`${operation}: invalid memory metadata: ${formatCause(error)}`);
	}
}
