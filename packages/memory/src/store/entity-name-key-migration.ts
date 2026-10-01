/** @file entity-name-key-migration.ts
 * @purpose Re-keys entity names so several names can identify one entity.
 * @boundary Idempotent SQLite table rebuild only; no identity judgment.
 */

import { StorageError } from "../engine/shared/errors";
import type { SqliteDatabaseLike } from "./sqlite-runtime";

export interface EntityNameKeyMigrationResult {
	status: "migrated" | "noop";
}

function isEntityNameKeyMigrationResult(
	value: unknown,
): value is EntityNameKeyMigrationResult {
	if (typeof value !== "object" || value === null || !("status" in value)) return false;
	return value.status === "migrated" || value.status === "noop";
}

const CREATE_ENTITY_TABLE_SQL = `
CREATE TABLE nodix_memory_entities_cutover (
	project_id TEXT NOT NULL,
	entity_id TEXT NOT NULL,
	display_name TEXT NOT NULL,
	normalized_name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY(project_id, normalized_name)
) WITHOUT ROWID;
`;

const CREATE_ENTITY_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS nodix_idx_memory_entities_display_name
ON nodix_memory_entities(project_id, display_name);
CREATE INDEX IF NOT EXISTS nodix_idx_memory_entities_entity_id
ON nodix_memory_entities(project_id, entity_id);
`;

function migrationApplied(database: SqliteDatabaseLike): boolean {
	const columns = database.prepare("PRAGMA table_info(nodix_memory_entities)").all() as Array<{
		name: string;
		pk: number;
	}>;
	if (columns.length === 0) {
		throw new StorageError("entity name key migration requires nodix_memory_entities");
	}
	const primaryKey = columns
		.filter((column) => column.pk > 0)
		.sort((left, right) => left.pk - right.pk)
		.map((column) => column.name);
	return primaryKey[0] === "project_id" && primaryKey[1] === "normalized_name";
}

export function applyEntityNameKeyMigration(
	database: SqliteDatabaseLike,
): EntityNameKeyMigrationResult {
	if (migrationApplied(database)) {
		database.exec(CREATE_ENTITY_INDEXES_SQL);
		return { status: "noop" };
	}
	database.exec("PRAGMA foreign_keys = OFF");
	try {
		const migrate = database.transaction((): EntityNameKeyMigrationResult => {
			if (migrationApplied(database)) return { status: "noop" };
			database.exec(CREATE_ENTITY_TABLE_SQL);
			database.exec(`
				INSERT INTO nodix_memory_entities_cutover(
					project_id, entity_id, display_name, normalized_name, created_at
				)
				SELECT project_id, entity_id, display_name, normalized_name, created_at
				FROM nodix_memory_entities;
			`);
			database.exec("DROP TABLE nodix_memory_entities");
			database.exec(
				"ALTER TABLE nodix_memory_entities_cutover RENAME TO nodix_memory_entities",
			);
			database.exec(CREATE_ENTITY_INDEXES_SQL);
			return { status: "migrated" };
		});
		const result = migrate.immediate();
		if (!isEntityNameKeyMigrationResult(result)) {
			throw new StorageError("entity name key migration returned an invalid result");
		}
		return result;
	} finally {
		database.exec("PRAGMA foreign_keys = ON");
	}
}
