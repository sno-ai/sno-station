/** @file memory-snapshot.ts
 * @purpose Reads aggregate memory-store metadata for memory.snapshot events.
 * @boundary Read-only SQLite inspection for observability.
 */

import { existsSync } from "node:fs";
import type { PluginConfig } from "../shared/types";
import { openSqliteDatabaseReadonly, type SqliteDatabaseLike } from "../../store/sqlite-runtime";

export type SnapshotReason = "startup" | "session_end";

export type MemorySnapshotPayload = {
	session_uuid: string;
	snapshot_reason: SnapshotReason;
	total_entries: number;
	total_bytes: number;
	oldest_entry_ts_ms?: number;
	newest_entry_ts_ms?: number;
};

type SnapshotRow = {
	total_entries: number;
	total_bytes: number;
	oldest_entry_ts_ms: number | null;
	newest_entry_ts_ms: number | null;
};

function emptySnapshotPayload(snapshotUuid: string, reason: SnapshotReason): MemorySnapshotPayload {
	return {
		session_uuid: snapshotUuid,
		snapshot_reason: reason,
		total_entries: 0,
		total_bytes: 0,
	};
}

function hasMemoriesTable(db: SqliteDatabaseLike): boolean {
	const row = db
		.prepare(
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memories'",
		)
		.get() as { present?: number } | undefined;
	return row?.present === 1;
}

export async function readMemorySnapshotPayload(
	dbPath: string,
	_config: PluginConfig,
	snapshotUuid: string,
	reason: SnapshotReason,
	liveDb?: SqliteDatabaseLike,
): Promise<MemorySnapshotPayload> {
	if (!existsSync(dbPath)) return emptySnapshotPayload(snapshotUuid, reason);

	// Reuse the store's live connection when the caller has one (startup and
	// session_end snapshots run while the store is open) — a fresh readonly open
	// pays manifest + canary verification per snapshot for no benefit. The
	// readonly fallback remains for out-of-process callers.
	const handle = liveDb ? undefined : openSqliteDatabaseReadonly(dbPath);
	const db = liveDb ?? (handle ? handle.db : undefined);
	if (!db) return emptySnapshotPayload(snapshotUuid, reason);
	let row: SnapshotRow;
	try {
		if (!hasMemoriesTable(db)) {
			return emptySnapshotPayload(snapshotUuid, reason);
		}
		row = db
			.prepare(
				"SELECT COUNT(*) AS total_entries, COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS total_bytes, MIN(timestamp) AS oldest_entry_ts_ms, MAX(timestamp) AS newest_entry_ts_ms FROM nodix_memories",
			)
			.get() as SnapshotRow;
	} finally {
		if (handle) handle.db.close();
	}
	const payload: MemorySnapshotPayload = {
		session_uuid: snapshotUuid,
		snapshot_reason: reason,
		total_entries: row.total_entries,
		total_bytes: row.total_bytes,
	};
	if (row.total_entries > 0) {
		payload.oldest_entry_ts_ms = row.oldest_entry_ts_ms ?? 0;
		payload.newest_entry_ts_ms = row.newest_entry_ts_ms ?? 0;
	}
	return payload;
}
