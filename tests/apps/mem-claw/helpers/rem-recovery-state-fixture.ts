/** Real recovery history for restore-writer acceptance. */

import {
	hashRemMemoryRow,
	REM_ROW_HASH_VERSION,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import type { TestDb } from "./test-db.ts";

type RestoreWriter = "restoreLane" | "restoreTextVersion" | "restoreMark";

export function seedRemRecoveryState(
	fixture: TestDb,
	writer: string,
	rowId: string,
): void {
	if (!isRestoreWriter(writer)) return;
	const prior = readMemoryRow(fixture, rowId);
	const priorFacetState = readFacetState(fixture, rowId);
	if (writer === "restoreLane") {
		fixture.runtime.raw
			.prepare("UPDATE nodix_memories SET lane = 'parked' WHERE id = ?")
			.run(rowId);
	} else if (writer === "restoreTextVersion") {
		fixture.runtime.raw
			.prepare("UPDATE nodix_memories SET text = ? WHERE id = ?")
			.run("The post-mutation text awaiting recovery.", rowId);
	} else {
		fixture.runtime.raw
			.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
			.run(JSON.stringify({ rem_recovery_mark: true }), rowId);
	}
	const current = readMemoryRow(fixture, rowId);
	const currentFacetState = readFacetState(fixture, rowId);
	const operationKind = writer === "restoreLane" ? "lane" : writer === "restoreTextVersion" ? "text-version" : "mark";
	fixture.runtime.raw
		.prepare(
			`INSERT INTO nodix_rem_recovery_history(
				recovery_handle, row_id, operation_kind, prior_row_image, prior_content_hash,
				expected_post_hash, row_hash_version, reason, mutation_ts
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			`recovery-${rowId}`,
			rowId,
			operationKind,
			JSON.stringify(prior),
			String(prior.content_hash),
			// The one row-hash definition, the same one the writers use. Hashing the row here with a
			// local `JSON.stringify` is what let the two sides drift in production, and a fixture
			// that keeps its own copy would hide the next drift instead of catching it.
			hashRemMemoryRow(current),
			REM_ROW_HASH_VERSION,
			"Seed a real reversible writer state for acceptance.",
			"2026-08-08T08:00:30.000Z",
		);
	if (writer !== "restoreMark") return;
	fixture.runtime.raw.exec(`
		CREATE TABLE IF NOT EXISTS nodix_rem_facet_recovery (
			recovery_handle TEXT PRIMARY KEY,
			prior_facets_json TEXT NOT NULL,
			prior_chunk_facets_json TEXT NOT NULL,
			expected_facets_json TEXT NOT NULL,
			expected_chunk_facets_json TEXT NOT NULL
		);
	`);
	fixture.runtime.raw
		.prepare(
			`INSERT INTO nodix_rem_facet_recovery(
				recovery_handle, prior_facets_json, prior_chunk_facets_json,
				expected_facets_json, expected_chunk_facets_json
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.run(
			`recovery-${rowId}`,
			JSON.stringify(priorFacetState.facets),
			JSON.stringify(priorFacetState.chunkFacets),
			JSON.stringify(currentFacetState.facets),
			JSON.stringify(currentFacetState.chunkFacets),
		);
}

function isRestoreWriter(writer: string): writer is RestoreWriter {
	return writer === "restoreLane" || writer === "restoreTextVersion" || writer === "restoreMark";
}

function readMemoryRow(fixture: TestDb, rowId: string): Record<string, unknown> {
	const row = fixture.runtime.raw
		.prepare(
			`SELECT id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash,
				fact_id, derived_from, consolidation_epoch_id, confidence_source, lane, raw_candidate_json,
				disposition_reason, dispositioned_at_ms
			FROM nodix_memories WHERE id = ?`,
		)
		.get(rowId) as Record<string, unknown> | undefined;
	if (row === undefined) throw new Error(`missing recovery fixture row ${rowId}`);
	return row;
}

function readFacetState(
	fixture: TestDb,
	rowId: string,
): { facets: Array<Record<string, unknown>>; chunkFacets: Array<Record<string, unknown>> } {
	return {
		facets: fixture.runtime.raw
			.prepare(
				"SELECT facet, text, updated_at_ms FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet",
			)
			.all(rowId) as Array<Record<string, unknown>>,
		chunkFacets: fixture.runtime.raw
			.prepare("SELECT chunk_id, facet FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY chunk_id")
			.all(rowId) as Array<Record<string, unknown>>,
	};
}
