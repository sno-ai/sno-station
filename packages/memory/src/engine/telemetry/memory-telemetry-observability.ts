/** @file memory-telemetry-sno-observe.ts
 * @purpose Forwards local memory telemetry summaries to sno-observe without making cloud state authoritative.
 * @boundary Reads local append-only telemetry rows and advances only the local sync watermark.
 */

import type { JsonObject } from "@snoai/sno-observe";
import type { SqliteDatabaseLike } from "../../store/sqlite-runtime";
import {
	isMemoryTelemetryEventType,
	type MemoryTelemetryEventType,
} from "./memory-telemetry-types";

export interface MemoryTelemetryObserveEmitInput {
	eventType: "memory.telemetry";
	payload: JsonObject;
}

export interface MemoryTelemetryObserveSink {
	tryEmit(input: MemoryTelemetryObserveEmitInput): boolean | Promise<boolean>;
}

export interface ForwardMemoryTelemetryToObserveOptions {
	sqlite: SqliteDatabaseLike;
	observe: MemoryTelemetryObserveSink;
	sink?: string;
	batchSize?: number;
	nowMs?: number;
}

export interface MemoryTelemetryObserveForwardResult {
	status: "idle" | "forwarded" | "failed";
	forwarded: number;
	lastEventId: number;
}

interface MemoryTelemetrySyncRow {
	id: number;
	event_type: string;
	fact_id: string | null;
	memory_kind: string | null;
	timestamp_ms: number;
	session_uuid: string | null;
	turn_id: string | null;
	agent_id: string;
	project_id: string | null;
	content_hash: string | null;
	retrieval_rank: number | null;
	retrieval_score: number | null;
	consolidation_epoch_id: string | null;
	metadata_json: string | null;
}

const DEFAULT_SINK = "sno-observe";
const MAX_BATCH_SIZE = 50;

export async function forwardMemoryTelemetryToObserve(
	options: ForwardMemoryTelemetryToObserveOptions,
): Promise<MemoryTelemetryObserveForwardResult> {
	const sink = normalizeSink(options.sink);
	const lastEventId = readWatermark(options.sqlite, sink);
	const rows = readRows(options.sqlite, lastEventId, normalizeBatchSize(options.batchSize));
	if (rows.length === 0) {
		return { status: "idle", forwarded: 0, lastEventId };
	}
	const firstRow = rows[0];
	const lastRow = rows[rows.length - 1];
	if (!firstRow || !lastRow) {
		return { status: "idle", forwarded: 0, lastEventId };
	}
	const nextEventId = lastRow.id;
	const payload = buildPayload(rows, firstRow.id, nextEventId);
	try {
		const accepted = await options.observe.tryEmit({
			eventType: "memory.telemetry",
			payload,
		});
		if (!accepted) {
			return { status: "failed", forwarded: 0, lastEventId };
		}
		writeWatermark(options.sqlite, sink, nextEventId, options.nowMs ?? Date.now());
		return { status: "forwarded", forwarded: rows.length, lastEventId: nextEventId };
	} catch {
		return { status: "failed", forwarded: 0, lastEventId };
	}
}

function readWatermark(sqlite: SqliteDatabaseLike, sink: string): number {
	const row = sqlite
		.prepare("SELECT last_event_id FROM nodix_memory_telemetry_sync_state WHERE sink = ?")
		.get(sink) as { last_event_id: number } | undefined;
	return typeof row?.last_event_id === "number" ? row.last_event_id : 0;
}

function readRows(
	sqlite: SqliteDatabaseLike,
	lastEventId: number,
	batchSize: number,
): MemoryTelemetrySyncRow[] {
	return sqlite
		.prepare(
			`SELECT id, event_type, fact_id, memory_kind, timestamp_ms, session_uuid, turn_id,
			        agent_id, project_id, content_hash, retrieval_rank, retrieval_score,
			        consolidation_epoch_id, metadata_json
			 FROM nodix_memory_events
			 WHERE id > ?
			 ORDER BY id ASC
			 LIMIT ?`,
		)
		.all(lastEventId, batchSize) as MemoryTelemetrySyncRow[];
}

function buildPayload(
	rows: readonly MemoryTelemetrySyncRow[],
	firstEventId: number,
	lastEventId: number,
): JsonObject {
	const eventTypes: JsonObject = {};
	const events = rows.map((row) => {
		const eventType = parseEventType(row.event_type);
		eventTypes[eventType] = typeof eventTypes[eventType] === "number" ? eventTypes[eventType] + 1 : 1;
		return sanitizeEvent(row, eventType);
	});
	return {
		sync_kind: "nodix_memory_events",
		first_event_id: firstEventId,
		last_event_id: lastEventId,
		event_count: events.length,
		event_types: eventTypes,
		events,
	};
}

function sanitizeEvent(
	row: MemoryTelemetrySyncRow,
	eventType: MemoryTelemetryEventType,
): JsonObject {
	const event: JsonObject = {
		event_id: row.id,
		event_type: eventType,
		timestamp_ms: row.timestamp_ms,
		agent_id: row.agent_id,
	};
	addString(event, "fact_id", row.fact_id);
	addString(event, "memory_kind", row.memory_kind);
	addString(event, "session_uuid", row.session_uuid);
	addString(event, "turn_id", row.turn_id);
	addString(event, "project_id", row.project_id);
	addString(event, "content_hash", row.content_hash);
	addNumber(event, "retrieval_rank", row.retrieval_rank);
	addNumber(event, "retrieval_score", row.retrieval_score);
	addString(event, "consolidation_epoch_id", row.consolidation_epoch_id);
	addString(event, "status", readStatus(row.metadata_json));
	return event;
}

function readStatus(metadataJson: string | null): string | null {
	if (!metadataJson) return null;
	try {
		const parsed = JSON.parse(metadataJson) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const status = (parsed as Record<string, unknown>).status;
		return typeof status === "string" && status.trim().length > 0 ? status.trim() : null;
	} catch {
		return null;
	}
}

function writeWatermark(
	sqlite: SqliteDatabaseLike,
	sink: string,
	lastEventId: number,
	updatedAtMs: number,
): void {
	sqlite
		.prepare(
			`INSERT INTO nodix_memory_telemetry_sync_state (sink, last_event_id, updated_at_ms)
			 VALUES (?, ?, ?)
			 ON CONFLICT(sink) DO UPDATE SET
			   last_event_id = excluded.last_event_id,
			   updated_at_ms = excluded.updated_at_ms
			 WHERE excluded.last_event_id > nodix_memory_telemetry_sync_state.last_event_id`,
		)
		.run(sink, lastEventId, updatedAtMs);
}

function parseEventType(value: string): MemoryTelemetryEventType {
	if (isMemoryTelemetryEventType(value)) return value;
	throw new Error(`unknown memory telemetry event type: ${value}`);
}

function normalizeSink(value: string | undefined): string {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	return DEFAULT_SINK;
}

function normalizeBatchSize(value: number | undefined): number {
	if (!Number.isFinite(value)) return MAX_BATCH_SIZE;
	return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(Number(value))));
}

function addString(target: JsonObject, key: string, value: string | null): void {
	if (typeof value === "string" && value.trim().length > 0) {
		target[key] = value.trim();
	}
}

function addNumber(target: JsonObject, key: string, value: number | null): void {
	if (typeof value === "number" && Number.isFinite(value)) {
		target[key] = value;
	}
}
