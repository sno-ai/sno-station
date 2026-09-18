/** @file state-category-migration.ts
 * @purpose Adds the state memory category to an existing atomic memory table.
 * @boundary Explicit SQLite table rebuild only; runtime startup does not call it.
 */

import { StorageError } from "../engine/shared/errors";
import {
	ATOMIC_MEMORY_ROW_CONSTRAINTS,
	CREATE_ATOMIC_MEMORY_CUTOVER_TABLE_SQL,
} from "./atomic-memory-cutover-sql";
import type { SqliteDatabaseLike } from "./sqlite-runtime";

interface SchemaObjectRow {
	sql: string;
}

export interface StateCategoryMigrationResult {
	status: "migrated" | "noop";
}

function isStateCategoryMigrationResult(value: unknown): value is StateCategoryMigrationResult {
	if (typeof value !== "object" || value === null || !("status" in value)) return false;
	return value.status === "migrated" || value.status === "noop";
}

const COPY_ATOMIC_MEMORY_ROWS_SQL = `
INSERT INTO nodix_memories_cutover (
	id, text, category, project_id, importance, timestamp, metadata, content_hash, fact_id,
	derived_from, consolidation_epoch_id, confidence_source, lane, raw_candidate_json,
	disposition_reason, dispositioned_at_ms, timezone, subject, attribute, valid_from, valid_until,
	maturity, source, extractor_version
)
SELECT
	id, text, category, project_id, importance, timestamp, metadata, content_hash, fact_id,
	derived_from, consolidation_epoch_id, confidence_source, lane, raw_candidate_json,
	disposition_reason, dispositioned_at_ms, timezone, subject, attribute, valid_from, valid_until,
	maturity, source, extractor_version
FROM nodix_memories;
`;

function readTableSql(database: SqliteDatabaseLike): string {
	const row = database
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get("nodix_memories") as { sql?: string | null } | undefined;
	if (!row?.sql) throw new StorageError("state category migration requires nodix_memories");
	return row.sql;
}

/** Every column the copy reads. A store missing one predates the atomic schema. */
const REQUIRED_COLUMNS = [
	"id",
	"text",
	"category",
	"project_id",
	"importance",
	"timestamp",
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
	"timezone",
	"subject",
	"attribute",
	"valid_from",
	"valid_until",
	"maturity",
	"source",
	"extractor_version",
] as const;

/**
 * Refuse a store older than the atomic schema by name, before anything is written.
 *
 * Measured 2026-09-05 over 40 real persona stores: 21 predate the atomic columns — the August
 * runs have no `timezone`, the 2026-09-02 run no `subject` — and without this check the copy
 * dies mid-migration on a raw `no such column: subject`, which says nothing about what to do.
 * Such a store is out of scope (PRD 150 §6); it has to be told so.
 */
function assertAtomicSchema(database: SqliteDatabaseLike): void {
	const columns = new Set(
		(database.prepare("PRAGMA table_info(nodix_memories)").all() as { name: string }[]).map(
			(column) => column.name,
		),
	);
	const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
	if (missing.length === 0) return;
	throw new StorageError(
		`state category migration requires the atomic memory schema; nodix_memories is missing: ${missing.join(", ")}. Run the atomic cutover on this store first.`,
	);
}

function assertRowsSatisfyConstraints(database: SqliteDatabaseLike): void {
	const violations: string[] = [];
	for (const { name, predicate } of ATOMIC_MEMORY_ROW_CONSTRAINTS) {
		const rows = database
			.prepare(`SELECT id FROM nodix_memories WHERE NOT (${predicate}) ORDER BY id LIMIT 5`)
			.all() as Array<{ id: string }>;
		if (rows.length === 0) continue;
		const { count } = database
			.prepare(`SELECT COUNT(*) AS count FROM nodix_memories WHERE NOT (${predicate})`)
			.get() as { count: number };
		violations.push(`${count} rows violate ${name} (first: ${rows.map(({ id }) => id).join(", ")})`);
	}
	if (violations.length === 0) return;
	throw new StorageError(
		`state category migration refuses this store: ${violations.join("; ")}. Such rows predate the atomic schema; this store is out of scope until they are repaired.`,
	);
}

function migrationApplied(database: SqliteDatabaseLike): boolean {
	const tableSql = readTableSql(database);
	return tableSql.includes("'state'") && tableSql.includes("category != 'state'");
}

function readSchemaObjects(database: SqliteDatabaseLike): SchemaObjectRow[] {
	return database
		.prepare(
			"SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name",
		)
		.all("nodix_memories") as SchemaObjectRow[];
}

export function applyStateCategoryMigration(
	database: SqliteDatabaseLike,
): StateCategoryMigrationResult {
	assertAtomicSchema(database);
	assertRowsSatisfyConstraints(database);
	database.exec("PRAGMA foreign_keys = OFF");
	try {
		const migrate = database.transaction((): StateCategoryMigrationResult => {
			if (migrationApplied(database)) return { status: "noop" };
			const schemaObjects = readSchemaObjects(database);
			database.exec(CREATE_ATOMIC_MEMORY_CUTOVER_TABLE_SQL);
			database.exec(COPY_ATOMIC_MEMORY_ROWS_SQL);
			database.exec("DROP TABLE nodix_memories");
			database.exec("ALTER TABLE nodix_memories_cutover RENAME TO nodix_memories");
			for (const schemaObject of schemaObjects) database.exec(schemaObject.sql);
			return { status: "migrated" };
		});
		const result = migrate.immediate();
		if (!isStateCategoryMigrationResult(result)) {
			throw new StorageError("state category migration returned an invalid result");
		}
		return result;
	} finally {
		database.exec("PRAGMA foreign_keys = ON");
	}
}
