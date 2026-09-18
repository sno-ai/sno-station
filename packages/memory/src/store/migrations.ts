/** @file migrations.ts
 * @purpose Public, idempotent migration entry point used by the self-upgrade
 *   smoke test. Walks the SQLCipher chokepoint, loads
 *   sqlite-vec + simple-tokenizer, then applies drizzle migrations.
 * @boundary Standalone — does not depend on the rest of the storage runtime
 *   beyond the chokepoint and migrations directory resolution.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
	installRemSchema,
	type RemDatabaseLike,
} from "../engine/rem/index.js";
import * as schema from "./schema";
import { applyEntityNameKeyMigration } from "./entity-name-key-migration";
import { migrateLegacyDatabaseNamespace } from "./legacy-database-namespace-migration";
import { resolveSimpleTokenizerPath } from "./simple-tokenizer-path";
import { loadSqliteVecExtension } from "./sqlite-vec-path";
import { initSqliteRuntimeSync, openSqliteDatabase } from "./sqlite-runtime";
import { migrateUnplacedCandidates } from "./unplaced-candidate-migration";

type RemMigrationDecision =
	| { decision: "allow"; reasonCode: null }
	| { decision: "refuse"; reasonCode: "post_migration_writes" };

interface RemMigrationBaseline {
	dataVersion: number;
	totalChanges: number;
	changed: boolean;
	databasePath?: string | undefined;
	databaseBytes?: Buffer | undefined;
	walBytes?: Buffer | undefined;
	shmBytes?: Buffer | undefined;
}

const remTwoFacetBaselines = new WeakMap<object, RemMigrationBaseline>();

const MIGRATIONS_DIR = resolveMigrationsDir();

/**
 * Apply drizzle migrations against the encrypted DB at `dbPath`. Idempotent —
 * drizzle's `__drizzle_migrations` table tracks applied migrations by hash, so
 * a second call is a no-op. The self-upgrade smoke test calls this against a
 * new ephemeral database; the plugin runtime opens its configured database
 * through `initDb()` instead.
 *
 * The DEK is resolved synchronously via `initSqliteRuntimeSync()` — passphrase
 * mode is not supported here. Caller is responsible for closing nothing; this
 * function opens its own connection and closes it on exit.
 */
export function runMigrations(dbPath: string): void {
	initSqliteRuntimeSync();
	mkdirSync(dirname(dbPath), { recursive: true });
	const sqlite = openSqliteDatabase(dbPath);
	try {
		loadSqliteVecExtension(sqlite.raw);
		const { extensionPath, dictPath } = resolveSimpleTokenizerPath();
		sqlite.db.loadExtension(extensionPath);
		sqlite.db.prepare("SELECT jieba_dict(?)").get(dictPath);
		sqlite.db.exec("PRAGMA journal_mode=WAL;");
		sqlite.db.exec("PRAGMA busy_timeout=5000;");
		sqlite.db.exec("PRAGMA foreign_keys=ON;");
		migrateLegacyDatabaseNamespace(sqlite.db);
		const db = drizzle(sqlite.raw, { schema });
		migrate(db, { migrationsFolder: MIGRATIONS_DIR });
		applyEntityNameKeyMigration(sqlite.db);
		migrateUnplacedCandidates(sqlite.db);
		installRemSchema(sqlite.db);
	} finally {
		try {
			sqlite.db.close();
		} catch {
			// best-effort
		}
	}
}

export function applyRemTwoFacetMigration(input: { database: RemDatabaseLike }): void {
	const facetTableMissing = !tableExists(input.database, "nodix_rem_memory_facets");
	const facetRecoveryMissing = !tableExists(input.database, "nodix_rem_facet_recovery");
	const chunkFacetMissing = !columnExists(input.database, "nodix_memory_chunks", "facet");
	const facetIndexMissing = !indexExists(input.database, "rem_memory_facets_by_facet");
	const chunkFacetIndexMissing = !indexExists(input.database, "nodix_idx_memory_chunks_memory_facet");
	const oldChunkIndexPresent = indexExists(input.database, "nodix_idx_memory_chunks_memory");
	const insertTriggerMissing = !triggerExists(input.database, "rem_memory_facets_after_insert");
	const updateTriggerMissing = !triggerExists(input.database, "rem_memory_facets_after_text_update");
	const changed =
		facetTableMissing ||
		facetRecoveryMissing ||
		chunkFacetMissing ||
		facetIndexMissing ||
		chunkFacetIndexMissing ||
		oldChunkIndexPresent ||
		insertTriggerMissing ||
		updateTriggerMissing;
	const databasePath = changed ? readDatabasePath(input.database) : undefined;
	const databaseBytes = databasePath === undefined ? undefined : readFileSync(databasePath);
	const walBytes = readOptionalFile(databasePath === undefined ? undefined : `${databasePath}-wal`);
	const shmBytes = readOptionalFile(databasePath === undefined ? undefined : `${databasePath}-shm`);
	if (changed) {
		input.database.transaction(() => {
			if (facetTableMissing) {
				input.database.exec(`
					CREATE TABLE nodix_rem_memory_facets (
				memory_id TEXT NOT NULL,
				facet TEXT NOT NULL CHECK (facet IN ('current', 'history')),
				text TEXT NOT NULL,
				updated_at_ms INTEGER NOT NULL,
				PRIMARY KEY (memory_id, facet),
				FOREIGN KEY (memory_id) REFERENCES nodix_memories(id) ON DELETE CASCADE
					);
					INSERT INTO nodix_rem_memory_facets(memory_id, facet, text, updated_at_ms)
						SELECT id, 'current', text, timestamp FROM nodix_memories;
				`);
			}
			if (facetIndexMissing) {
				input.database.exec(
					"CREATE INDEX rem_memory_facets_by_facet ON nodix_rem_memory_facets(facet, memory_id)",
				);
			}
			if (insertTriggerMissing) {
				input.database.exec(`
					CREATE TRIGGER rem_memory_facets_after_insert
					AFTER INSERT ON nodix_memories BEGIN
						INSERT INTO nodix_rem_memory_facets(memory_id, facet, text, updated_at_ms)
							VALUES (NEW.id, 'current', NEW.text, NEW.timestamp);
					END
				`);
			}
			if (updateTriggerMissing) {
				input.database.exec(`
					CREATE TRIGGER rem_memory_facets_after_text_update
					AFTER UPDATE OF text ON nodix_memories BEGIN
						INSERT INTO nodix_rem_memory_facets(memory_id, facet, text, updated_at_ms)
							VALUES (NEW.id, 'current', NEW.text, NEW.timestamp)
						ON CONFLICT(memory_id, facet) DO UPDATE SET
							text = excluded.text, updated_at_ms = excluded.updated_at_ms;
					END
				`);
			}
			if (chunkFacetMissing) {
				input.database.exec(
					"ALTER TABLE nodix_memory_chunks ADD COLUMN facet TEXT NOT NULL DEFAULT 'current' CHECK (facet IN ('current', 'history'))",
				);
			}
			if (oldChunkIndexPresent) input.database.exec("DROP INDEX nodix_idx_memory_chunks_memory");
			if (chunkFacetIndexMissing) {
				input.database.exec(
					"CREATE UNIQUE INDEX nodix_idx_memory_chunks_memory_facet ON nodix_memory_chunks(memory_id, facet, chunk_index)",
				);
			}
			if (facetRecoveryMissing) {
				input.database.exec(`
					CREATE TABLE nodix_rem_facet_recovery (
						recovery_handle TEXT PRIMARY KEY,
						prior_facets_json TEXT NOT NULL,
						prior_chunk_facets_json TEXT NOT NULL,
						expected_facets_json TEXT NOT NULL,
						expected_chunk_facets_json TEXT NOT NULL,
						FOREIGN KEY (recovery_handle)
							REFERENCES nodix_rem_recovery_history(recovery_handle)
					)
				`);
			}
		}).immediate();
	}
	remTwoFacetBaselines.set(input.database as object, {
		...readConnectionVersion(input.database),
		changed,
		databasePath,
		databaseBytes,
		walBytes,
		shmBytes,
	});
}

export function rollbackRemTwoFacetMigration(input: {
	database: RemDatabaseLike;
}): RemMigrationDecision {
	const baseline = remTwoFacetBaselines.get(input.database as object);
	if (baseline === undefined) return { decision: "refuse", reasonCode: "post_migration_writes" };
	const current = readConnectionVersion(input.database);
	if (current.dataVersion !== baseline.dataVersion || current.totalChanges !== baseline.totalChanges) {
		return { decision: "refuse", reasonCode: "post_migration_writes" };
	}
	if (baseline.changed) {
		if (baseline.databasePath === undefined || baseline.databaseBytes === undefined) {
			return { decision: "refuse", reasonCode: "post_migration_writes" };
		}
		const closable = input.database as RemDatabaseLike & { close?: () => void };
		closable.close?.();
		restoreFile(baseline.databasePath, baseline.databaseBytes);
		restoreOptionalFile(`${baseline.databasePath}-wal`, baseline.walBytes);
		restoreOptionalFile(`${baseline.databasePath}-shm`, baseline.shmBytes);
	}
	remTwoFacetBaselines.delete(input.database as object);
	return { decision: "allow", reasonCode: null };
}

function readDatabasePath(database: RemDatabaseLike): string | undefined {
	const rows = database.prepare("PRAGMA database_list").all() as Array<{
		name: string;
		file: string;
	}>;
	const main = rows.find(({ name }) => name === "main");
	return main?.file === undefined || main.file.length === 0 ? undefined : main.file;
}

function readOptionalFile(path: string | undefined): Buffer | undefined {
	return path !== undefined && existsSync(path) ? readFileSync(path) : undefined;
}

function restoreFile(path: string, bytes: Buffer): void {
	writeFileSync(path, bytes);
}

function restoreOptionalFile(path: string, bytes: Buffer | undefined): void {
	if (bytes === undefined) {
		if (existsSync(path)) unlinkSync(path);
		return;
	}
	writeFileSync(path, bytes);
}

function tableExists(database: RemDatabaseLike, tableName: string): boolean {
	return (
		database
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(tableName) !== undefined
	);
}

function columnExists(database: RemDatabaseLike, tableName: string, columnName: string): boolean {
	if (!tableExists(database, tableName)) return false;
	const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
		name: string;
	}>;
	return columns.some(({ name }) => name === columnName);
}

function indexExists(database: RemDatabaseLike, indexName: string): boolean {
	return schemaObjectExists(database, "index", indexName);
}

function triggerExists(database: RemDatabaseLike, triggerName: string): boolean {
	return schemaObjectExists(database, "trigger", triggerName);
}

function schemaObjectExists(
	database: RemDatabaseLike,
	type: "index" | "trigger",
	name: string,
): boolean {
	return (
		database
			.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?")
			.get(type, name) !== undefined
	);
}

function readConnectionVersion(database: RemDatabaseLike): {
	dataVersion: number;
	totalChanges: number;
} {
	const dataVersion = database.prepare("PRAGMA data_version").get() as { data_version: number };
	const totalChanges = database.prepare("SELECT total_changes() AS total_changes").get() as {
		total_changes: number;
	};
	return { dataVersion: dataVersion.data_version, totalChanges: totalChanges.total_changes };
}

function resolveMigrationsDir(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(moduleDir, "../../drizzle"), join(moduleDir, "../drizzle"), join(moduleDir, "../../../drizzle")];
	for (const dir of candidates) {
		if (existsSync(join(dir, "meta/_journal.json"))) return dir;
	}
	throw new Error(`drizzle migrations folder not found; checked: ${candidates.join(", ")}`);
}
