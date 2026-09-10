import { FIXED_EXTERNAL_VALUE_62, PERSISTED_CANDIDATE_HASH_V1 } from "../model/signed-registry-constants";
/** @file unplaced-candidate-migration.ts
 * @purpose One-time data move: relocate every non-active memory row into
 *   `nodix_unplaced_memory_candidates`. Runs after the drizzle DDL migration and is
 *   idempotent, so an interrupted move simply completes on the next boot.
 * @boundary Reads and writes only those two tables through the caller's handle.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@snoai/utils/logger";
import { stableHash } from "../engine/shared/utils";
import type { SqliteDatabaseLike } from "./sqlite-runtime";

const log = createLogger("unplaced-candidate-migration");

interface LegacyRow {
	id: string;
	projectId: string;
	category: string;
	text: string;
	rawCandidateJson: string | null;
	dispositionReason: string | null;
	dispositionedAtMs: number | null;
	sessionKey: string | null;
}

/**
 * Legacy rows are keyed on their own row id, not on the live writer's basis.
 * Two legacy rows can carry byte-identical payloads and reasons and still be
 * distinct occurrences, and many of them have no session key to tell apart — so
 * the only identity that provably cannot collapse two of them is the id they
 * already have. The cost is that a migrated failure and a later identical live
 * failure both persist; that is a duplicate, and duplicates are the safe
 * direction.
 */
function legacyDedupeHash(legacyRowId: string): string {
	return stableHash(JSON.stringify([PERSISTED_CANDIDATE_HASH_V1, legacyRowId]));
}

/**
 * Relocate non-active rows. The no-loss property is structural rather than
 * asserted: a row is deleted only after its own insert has succeeded inside the
 * same transaction, so it can never be removed without having been copied, and
 * any failure rolls the whole move back. A row missing the fields a replay needs
 * aborts the move rather than being moved lossily or deleted.
 */
export function migrateUnplacedCandidates(sqlite: SqliteDatabaseLike): number {
	const rows = sqlite
		.prepare(
			"SELECT id, project_id AS projectId, category, text, raw_candidate_json AS rawCandidateJson, disposition_reason AS dispositionReason, dispositioned_at_ms AS dispositionedAtMs, json_extract(metadata, '$.source_session') AS sessionKey FROM nodix_memories WHERE lane <> 'active'",
		)
		.all() as LegacyRow[];
	if (rows.length === 0) return 0;

	const incomplete = rows.filter(
		(row) =>
			!row.rawCandidateJson ||
			!row.dispositionReason ||
			row.dispositionedAtMs === null ||
			!Number.isFinite(row.dispositionedAtMs),
	);
	if (incomplete.length > 0) {
		throw new Error(
			`unplaced-candidate migration aborted: ${incomplete.length} non-active row(s) lack the fields a replay needs; ids: ${incomplete
				.slice(0, 5)
				.map((row) => row.id)
				.join(", ")}`,
		);
	}

	const insert = sqlite.prepare(
		"INSERT OR IGNORE INTO nodix_unplaced_memory_candidates (id, project_id, category, text, raw_candidate_json, disposition_reason, dispositioned_at_ms, session_key, dedupe_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const exists = sqlite.prepare(
		"SELECT 1 AS present FROM nodix_unplaced_memory_candidates WHERE project_id = ? AND dedupe_hash = ? LIMIT 1",
	);
	// Chunks cascade on the foreign key, but a cascade fires the child table's
	// delete trigger only with recursive_triggers on, and that trigger is what
	// keeps the chunk full-text index consistent. Delete them explicitly, the way
	// the rest of the storage layer does.
	const removeChunks = sqlite.prepare("DELETE FROM nodix_memory_chunks WHERE memory_id = ?");
	const remove = sqlite.prepare("DELETE FROM nodix_memories WHERE id = ?");

	const move = sqlite.transaction(() => {
		let moved = 0;
		for (const row of rows) {
			// Narrowed by the `incomplete` guard above.
			const reason = String(row.dispositionReason);
			const raw = String(row.rawCandidateJson);
			const hash = legacyDedupeHash(row.id);
			insert.run(
				randomUUID(),
				row.projectId,
				row.category,
				row.text,
				raw,
				reason,
				Number(row.dispositionedAtMs),
				row.sessionKey,
				hash,
			);
			// Delete only once this failure is provably preserved — either by the
			// insert above or by an earlier interrupted run of this same move.
			if (!exists.get(row.projectId, hash)) {
				throw new Error(
					`unplaced-candidate migration aborted: ${row.id} was not preserved before delete`,
				);
			}
			removeChunks.run(row.id);
			remove.run(row.id);
			moved += 1;
		}
		return moved;
	});

	const moved = move() as number;
	log.warn("relocated non-active memory rows into the unplaced-candidate table", { moved }, {
		event_name: FIXED_EXTERNAL_VALUE_62,
		file: "packages/sno-station-mem/src/store/unplaced-candidate-migration.ts",
		function: "migrateUnplacedCandidates",
		site_id: "unplaced-candidate-migration.migrateUnplacedCandidates.c87865ef90",
	});
	return moved;
}
