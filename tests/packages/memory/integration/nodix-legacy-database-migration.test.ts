import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	closeDb,
	initDb,
	loadStorageExtensions,
	readChunkVecTableState,
} from "../../../../packages/memory/src/store/connection";
import { migrateLegacyDatabaseNamespace } from "../../../../packages/memory/src/store/legacy-database-namespace-migration";
import { runMigrations } from "../../../../packages/memory/src/store/migrations";
import {
	initSqliteRuntimeSync,
	openSqliteDatabase,
	type SqliteDatabaseLike,
} from "../../../../packages/memory/src/store/sqlite-runtime";

const VECTOR_DIMENSION = 3;

function vectorBytes(values: readonly number[]): Uint8Array {
	return new Uint8Array(new Float32Array(values).buffer);
}

function createLegacySchema(database: SqliteDatabaseLike): void {
	database.exec(`
		PRAGMA foreign_keys=ON;
		CREATE TABLE mem_claw_memories (
			id TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			category TEXT NOT NULL,
			project_id TEXT NOT NULL,
			importance REAL NOT NULL DEFAULT 0.7,
			timestamp INTEGER NOT NULL,
			metadata TEXT DEFAULT '{}',
			content_hash TEXT NOT NULL,
			fact_id TEXT,
			lane TEXT NOT NULL DEFAULT 'active'
		);
		CREATE TABLE mem_claw_chunks (
			chunk_id TEXT PRIMARY KEY,
			memory_id TEXT NOT NULL REFERENCES mem_claw_memories(id) ON DELETE CASCADE,
			chunk_index INTEGER NOT NULL,
			chunk_text TEXT NOT NULL,
			dense_payload TEXT NOT NULL,
			facet TEXT NOT NULL DEFAULT 'current'
		);
		CREATE UNIQUE INDEX mem_claw_chunks_mem_facet_idx
			ON mem_claw_chunks(memory_id, facet, chunk_index);
		CREATE INDEX idx_mem_claw_memories_content_hash ON mem_claw_memories(content_hash);
		CREATE VIRTUAL TABLE mem_claw_chunks_fts USING fts5(
			dense_payload,
			content='mem_claw_chunks',
			content_rowid='rowid',
			tokenize='simple 0'
		);
		CREATE VIRTUAL TABLE vec_mem_claw_chunks USING vec0(
			id TEXT PRIMARY KEY,
			project_id TEXT PARTITION KEY,
			embedding float[3]
		);
		CREATE TABLE memory_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_type TEXT NOT NULL,
			fact_id TEXT,
			timestamp_ms INTEGER NOT NULL,
			agent_id TEXT NOT NULL
		);
		CREATE INDEX idx_me_fact ON memory_events(fact_id);
		CREATE TABLE rem_relation_ledger (row_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL);
		CREATE TABLE rem_memory_facets (
			memory_id TEXT NOT NULL REFERENCES mem_claw_memories(id) ON DELETE CASCADE,
			facet TEXT NOT NULL,
			text TEXT NOT NULL,
			updated_at_ms INTEGER NOT NULL,
			PRIMARY KEY(memory_id, facet)
		);
		CREATE TRIGGER mem_claw_chunks_ai AFTER INSERT ON mem_claw_chunks BEGIN
			INSERT INTO mem_claw_chunks_fts(rowid, dense_payload)
			VALUES (new.rowid, new.dense_payload);
		END;
		CREATE TRIGGER mem_claw_chunks_ad AFTER DELETE ON mem_claw_chunks BEGIN
			INSERT INTO mem_claw_chunks_fts(mem_claw_chunks_fts, rowid, dense_payload)
			VALUES ('delete', old.rowid, old.dense_payload);
		END;
		CREATE TRIGGER mem_claw_chunks_au AFTER UPDATE ON mem_claw_chunks BEGIN
			INSERT INTO mem_claw_chunks_fts(mem_claw_chunks_fts, rowid, dense_payload)
			VALUES ('delete', old.rowid, old.dense_payload);
			INSERT INTO mem_claw_chunks_fts(rowid, dense_payload)
			VALUES (new.rowid, new.dense_payload);
		END;
		CREATE TRIGGER mem_claw_memories_fact_id_insert_guard
		BEFORE INSERT ON mem_claw_memories WHEN NEW.fact_id IS NULL
		BEGIN SELECT RAISE(ABORT, 'mem_claw_memories.fact_id is required'); END;
		CREATE TRIGGER mem_claw_memories_fact_id_update_guard
		BEFORE UPDATE ON mem_claw_memories WHEN NEW.fact_id IS NULL
		BEGIN SELECT RAISE(ABORT, 'mem_claw_memories.fact_id is required'); END;
		CREATE TRIGGER rem_memory_facets_after_insert AFTER INSERT ON mem_claw_memories BEGIN
			INSERT INTO rem_memory_facets(memory_id, facet, text, updated_at_ms)
			VALUES (NEW.id, 'current', NEW.text, NEW.timestamp);
		END;
	`);

	database
		.prepare(
			`INSERT INTO mem_claw_memories(
				id, text, category, project_id, timestamp, content_hash, fact_id
			) VALUES (?, ?, 'episodic', 'project-1', 1700000000000, 'hash-1', 'fact-1')`,
		)
		.run("memory-1", "Legacy agent memory remains searchable.");
	database
		.prepare(
			`INSERT INTO mem_claw_chunks(
				chunk_id, memory_id, chunk_index, chunk_text, dense_payload
			) VALUES ('chunk-1', 'memory-1', 0, ?, ?)`,
		)
		.run("Legacy agent memory remains searchable.", "Legacy agent memory remains searchable.");
	database
		.prepare("INSERT INTO vec_mem_claw_chunks(id, project_id, embedding) VALUES (?, ?, vec_f32(?))")
		.run("chunk-1", "project-1", vectorBytes([1, 0, 0]));
	database
		.prepare(
			"INSERT INTO memory_events(event_type, fact_id, timestamp_ms, agent_id) VALUES ('create', 'fact-1', 1700000000000, 'agent-1')",
		)
		.run();
	database
		.prepare("INSERT INTO rem_relation_ledger(row_id, content_hash) VALUES ('memory-1', 'hash-1')")
		.run();
}

function createPrePartitionLegacyDatabase(databasePath: string): void {
	const current = initDb(databasePath, VECTOR_DIMENSION);
	current.$client
		.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id
			) VALUES (?, ?, 'episodic', ?, 0.8, 1, 'UTC', '{}', ?, ?)`,
		)
		.run("memory-legacy", "Legacy vector remains searchable.", "project-legacy", "hash-legacy", "fact-legacy");
	current.$client
		.prepare(
			`INSERT INTO nodix_memory_chunks(
				chunk_id, memory_id, chunk_index, chunk_text, dense_payload, start_offset,
				end_offset, token_count, content_type, chunking_version, embedder_provider,
				embedder_model, embedder_dim, created_at, updated_at, facet
			) VALUES (?, ?, 0, ?, ?, 0, 33, 4, 'prose', 'legacy', 'test', 'test-3d', 3, 1, 1, 'current')`,
		)
		.run(
			"chunk-legacy",
			"memory-legacy",
			"Legacy vector remains searchable.",
			"Legacy vector remains searchable.",
		);
	closeDb(current);

	const handle = openSqliteDatabase(databasePath);
	try {
		loadStorageExtensions(handle);
		handle.db.exec(`
			ALTER TABLE nodix_memories RENAME TO mem_claw_memories;
			ALTER TABLE nodix_memory_chunks RENAME TO mem_claw_chunks;
			DROP TABLE nodix_memory_chunk_vectors;
			CREATE VIRTUAL TABLE vec_mem_claw_chunks USING vec0(
				id TEXT PRIMARY KEY,
				embedding float[3]
			);
		`);
		handle.db
			.prepare("INSERT INTO vec_mem_claw_chunks(id, embedding) VALUES (?, vec_f32(?))")
			.run("chunk-legacy", vectorBytes([1, 0, 0]));
	} finally {
		handle.db.close();
	}
}

describe("legacy database namespace migration", () => {
	let temporaryDirectory: string;
	let databasePath: string;

	beforeEach(() => {
		initSqliteRuntimeSync();
		temporaryDirectory = mkdtempSync(join(tmpdir(), "nodix-legacy-migration-"));
		databasePath = join(temporaryDirectory, "memory.sqlite");
	});

	afterEach(() => {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it("preserves legacy rows, rebuilds FTS, and keeps vectors searchable", () => {
		const handle = openSqliteDatabase(databasePath);
		try {
			loadStorageExtensions(handle);
			createLegacySchema(handle.db);

			expect(migrateLegacyDatabaseNamespace(handle.db)).toBe("migrated");
			expect(migrateLegacyDatabaseNamespace(handle.db)).toBe("current");

			const schema = JSON.stringify(
				handle.db
					.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
					.all(),
			).toLowerCase();
			expect(schema).not.toContain("mem_claw");
			expect(schema).not.toContain("vec_mem_claw");
			expect(handle.db.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get()).toEqual({
				count: 1,
			});
			expect(
				handle.db.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunks").get(),
			).toEqual({ count: 1 });
			expect(
				handle.db
					.prepare("SELECT rowid FROM nodix_memory_chunks_fts WHERE nodix_memory_chunks_fts MATCH ?")
					.all("searchable"),
			).toHaveLength(1);
			expect(
				handle.db
					.prepare(
						"SELECT id FROM nodix_memory_chunk_vectors WHERE embedding MATCH vec_f32(?) AND project_id = ? AND k = 1",
					)
					.all(vectorBytes([1, 0, 0]), "project-1"),
			).toEqual([{ id: "chunk-1" }]);
			expect(handle.db.prepare("SELECT COUNT(*) AS count FROM nodix_memory_events").get()).toEqual({
				count: 1,
			});
			expect(
				handle.db.prepare("SELECT COUNT(*) AS count FROM nodix_rem_relation_ledger").get(),
			).toEqual({ count: 1 });
			expect(handle.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(handle.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			handle.db.close();
		}
	});

	it("does nothing to an already-current database", () => {
		const database = initDb(databasePath, VECTOR_DIMENSION);
		try {
			expect(migrateLegacyDatabaseNamespace(database.$client)).toBe("current");
		} finally {
			closeDb(database);
		}
	});

	it("rejects a current database that still contains an unlisted legacy object", () => {
		const database = initDb(databasePath, VECTOR_DIMENSION);
		try {
			database.$client.exec("CREATE TABLE mem_claw_orphaned_rows (id TEXT PRIMARY KEY)");
			expect(() => migrateLegacyDatabaseNamespace(database.$client)).toThrow(
				/legacy database objects remain: mem_claw_orphaned_rows/,
			);
		} finally {
			closeDb(database);
		}
	});

	it("rolls back migration when an unlisted legacy object remains", () => {
		const handle = openSqliteDatabase(databasePath);
		try {
			loadStorageExtensions(handle);
			createLegacySchema(handle.db);
			handle.db.exec("CREATE TABLE mem_claw_orphaned_rows (id TEXT PRIMARY KEY)");

			expect(() => migrateLegacyDatabaseNamespace(handle.db)).toThrow(
				/legacy database objects remain: mem_claw_orphaned_rows/,
			);
			expect(
				handle.db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get("mem_claw_memories"),
			).toEqual({ name: "mem_claw_memories" });
			expect(
				handle.db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get("nodix_memories"),
			).toBeUndefined();
		} finally {
			handle.db.close();
		}
	});

	it("migrates pre-partition vectors with project ids derived from their memories", () => {
		createPrePartitionLegacyDatabase(databasePath);

		const migrated = initDb(databasePath, VECTOR_DIMENSION);
		try {
			expect(readChunkVecTableState(migrated.$client)).toEqual({
				dimension: VECTOR_DIMENSION,
				rowCount: 1,
				hasPartitionKey: true,
			});
			expect(
				migrated.$client
					.prepare(
						"SELECT id FROM nodix_memory_chunk_vectors WHERE embedding MATCH vec_f32(?) AND project_id = ? AND k = 1",
					)
					.all(vectorBytes([1, 0, 0]), "project-legacy"),
			).toEqual([{ id: "chunk-legacy" }]);
		} finally {
			closeDb(migrated);
		}
	});

	it("does not add fact-id guards before the fact-id migration runs", () => {
		const handle = openSqliteDatabase(databasePath);
		try {
			handle.db.exec(`
				CREATE TABLE mem_claw_memories (
					id TEXT PRIMARY KEY,
					text TEXT NOT NULL
				);
			`);

			expect(migrateLegacyDatabaseNamespace(handle.db)).toBe("migrated");
			expect(
				handle.db
					.prepare("SELECT name FROM pragma_table_info('nodix_memories') ORDER BY cid")
					.all(),
			).toEqual([{ name: "id" }, { name: "text" }]);
			expect(
				handle.db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
					.all(),
			).toEqual([]);
		} finally {
			handle.db.close();
		}
	});

	it("fails closed on a legacy namespace that still uses the old boundary column", () => {
		const handle = openSqliteDatabase(databasePath);
		try {
			handle.db.exec(`
				CREATE TABLE mem_claw_memories (
					id TEXT PRIMARY KEY,
					text TEXT NOT NULL,
					category TEXT NOT NULL,
					${["s", "c", "o", "p", "e"].join("")} TEXT NOT NULL DEFAULT 'global',
					importance REAL NOT NULL DEFAULT 0.7,
					timestamp INTEGER NOT NULL,
					metadata TEXT DEFAULT '{}',
					content_hash TEXT NOT NULL
				);
			`);
		} finally {
			handle.db.close();
		}

		expect(() => initDb(databasePath, VECTOR_DIMENSION)).toThrow(
			/legacy boundary schema is unsupported/i,
		);

		const unchanged = openSqliteDatabase(databasePath);
		try {
			expect(
				unchanged.db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get("mem_claw_memories"),
			).toEqual({ name: "mem_claw_memories" });
			expect(
				unchanged.db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get("nodix_memories"),
			).toBeUndefined();
		} finally {
			unchanged.db.close();
		}
	});

	it("leaves a legacy namespace unchanged when nonempty vectors use another dimension", () => {
		createPrePartitionLegacyDatabase(databasePath);

		expect(() => initDb(databasePath, VECTOR_DIMENSION + 1)).toThrow(
			/configured dim 4, found dim 3.*left unchanged/i,
		);

		const unchanged = openSqliteDatabase(databasePath);
		try {
			loadStorageExtensions(unchanged);
			expect(
				unchanged.db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get("mem_claw_memories"),
			).toEqual({ name: "mem_claw_memories" });
			expect(
				unchanged.db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get("vec_mem_claw_chunks"),
			).toEqual({ name: "vec_mem_claw_chunks" });
			expect(
				unchanged.db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
					.get("nodix_memories"),
			).toBeUndefined();
		} finally {
			unchanged.db.close();
		}
	});
});

const externalDatabasePath = process.env["NODIX_LEGACY_DB_PATH"];
const externalMigration = externalDatabasePath === undefined ? it.skip : it;

externalMigration("migrates the requested external legacy database", () => {
	if (externalDatabasePath === undefined) throw new Error("NODIX_LEGACY_DB_PATH is required");
	runMigrations(externalDatabasePath);
});
