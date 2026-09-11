import { createHash } from "node:crypto";

/**
 * The one definition of a REM whole-row hash.
 *
 * A recovery record stores `expected_post_hash` before the write; the verified-write guard
 * recomputes it after the write and refuses the mutation when the two disagree. Those two
 * computations lived in different packages and drifted: this package hashed `SELECT *` while
 * `rem-sqlite-adapter` hashed a projected row, so adding the `timezone` column to the projection
 * made every text-version write refuse AFTER its transaction had already committed. One function,
 * imported by both sides, is what stops that happening again.
 *
 * `REM_ROW_HASH_FIELDS` IS the hash — reordering it, adding to it, or removing from it changes
 * every value this function produces. That is why it is versioned rather than edited in place.
 */
export const REM_ROW_HASH_FIELDS = [
	"id",
	"text",
	"category",
	"project_id",
	"importance",
	"timestamp",
	"timezone",
	"metadata",
	"content_hash",
	"fact_id",
	"derived_from",
	"consolidation_epoch_id",
	"confidence_source",
	"lane",
	"raw_candidate_json",
	"disposition_reason",
	"dispositioned_at_ms",
] as const;

/**
 * Stamped on every recovery record this build writes. Version 1 means "written before the field
 * list was pinned", and a version-1 hash cannot be reproduced — the two producers of that era
 * covered different columns. Readers must branch on the stored version rather than assume.
 */
export const REM_ROW_HASH_VERSION = 2;

/** Version 1 records predate the pinned field list and carry a hash nothing can recompute. */
export const REM_ROW_HASH_VERSION_LEGACY = 1;

export function hashRemMemoryRow(row: Record<string, unknown>): string {
	const projected: Record<string, unknown> = {};
	for (const field of REM_ROW_HASH_FIELDS) {
		projected[field] = row[field] ?? null;
	}
	return createHash("sha256").update(JSON.stringify(projected)).digest("hex");
}
