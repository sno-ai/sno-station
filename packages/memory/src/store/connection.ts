/** @file connection.ts
 * @purpose Creates and validates SQLite connections used by the memory store.
 * @boundary Filesystem safety, database pragmas, migrations, and runtime loading.
 * @see sqlite-runtime.ts, schema.ts, store.ts.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@snoai/utils/logger";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { StorageError } from "../engine/shared/errors";
import { applyEntityNameKeyMigration } from "./entity-name-key-migration";
import * as schema from "./schema";
import { assertMemoryKindsCutoverStartupGuard } from "./memory-kinds-cutover-migrator";
import { migrateLegacyDatabaseNamespace } from "./legacy-database-namespace-migration";
import { resolveSimpleTokenizerPath } from "./simple-tokenizer-path";
import { loadSqliteVecExtension } from "./sqlite-vec-path";
import {
	openSqliteDatabase,
	SqliteFileMissingError,
	type SqliteDatabaseLike,
	type SqliteRuntimeHandle,
} from "./sqlite-runtime";
import { assertTodoStoreCountParity } from "./todo-store";
import { migrateUnplacedCandidates } from "./unplaced-candidate-migration";

const log = createLogger("sno-station-mem:db");

type RuntimeDrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

export type DrizzleDB = RuntimeDrizzleDB & {
	$client: SqliteDatabaseLike;
	vectorDimension: number;
	/**
	 * The chokepoint wrapper over the same connection. Store code MUST use this
	 * (statement cache + fail-closed latch live here); `$client` is the raw
	 * driver handle drizzle was constructed over and bypasses both.
	 */
	chokepoint: SqliteDatabaseLike;
};

type SqliteDB = SqliteDatabaseLike;

type DrizzleDBWithoutVector = RuntimeDrizzleDB & {
	$client: SqliteDatabaseLike;
};

export { validateStoragePath } from "./path-validation";

/**
 * Opens the Node SQLite runtime and applies SQLite connection setup fallback behavior for missing data.
 */
// LH: The storage runtime is intentionally Node-native and SQLite-first so startup stays local, tiny, and inspectable.
// LH: The schema belongs to this plugin so migrations can track memory behavior without depending on host internals.
// LH: Synchronous database opening is a deliberate fail-fast boundary: corrupt paths and missing extensions surface during startup.
// LH: The sqlite-vec extension is part of the storage contract; semantic recall depends on vector SQL being available before writes.
// LH: FTS5 health is checked here because keyword recall should fail explicitly instead of silently returning empty evidence.
// LH: Keep raw SQL at this layer parameterized; only validated SQLite DDL tokens such as float[dim] may be interpolated.
// LH: The connection layer owns WAL and extension setup because store methods assume those invariants already hold.
// LH: Future remote stores should adapt this boundary rather than weakening the local ACID guarantees used by tools and hooks.
// LH: This file is the best place to audit database boot decisions because every runtime path eventually crosses it.
/**
 * Reads the locked embedding dimension from the existing `nodix_memory_chunk_vectors`
 * DDL. Returns `undefined` if the DB file does not exist or the table has not
 * been created yet; throws on a corrupt-state DDL.
 *
 * This lets out-of-band tooling (CLI preset switching, diagnostics) detect
 * dim mismatches *before* the gateway boots, without paying the cost of
 * spinning up a real `MemoryStore`. Keeping the regex here means CLI,
 * diagnostics, and store startup agree on one canonical parser.
 */
export function readChunkVecTableDimension(dbPath: string): number | undefined {
	if (!existsSync(dbPath)) return undefined;
	let sqlite: ReturnType<typeof openSqliteDatabase>;
	try {
		sqlite = openSqliteDatabase(dbPath, {
			readonly: true,
			fileMustExist: true,
		});
	} catch (error) {
		// DB removed between the existsSync guard above and the open: this
		// function's contract is "undefined when the DB doesn't exist", so the
		// race resolves the same way as the guard, not as a throw.
		if (error instanceof SqliteFileMissingError) return undefined;
		throw error;
	}
	try {
		const row = sqlite.db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memory_chunk_vectors' LIMIT 1",
			)
			.get() as { sql?: string | null } | null;
		if (!row?.sql) return undefined;
		return parseVecTableDimension(row.sql);
	} finally {
		try {
			sqlite.db.close();
		} catch {
			// best-effort close — caller decides what to do with primary error
		}
	}
}

export function parseVecTableDimension(sql: string): number {
	if (!/create\s+virtual\s+table/i.test(sql) || !/using\s+vec0/i.test(sql)) {
		throw new StorageError(`nodix_memory_chunk_vectors exists but is not a sqlite-vec virtual table: ${sql}`);
	}
	const match = sql.match(/embedding\s+float\[(\d+)\]/i);
	const token = match?.[1];
	if (!token) {
		throw new StorageError(`Could not parse embedding dimension from nodix_memory_chunk_vectors DDL: ${sql}`);
	}
	const dim = Number.parseInt(token, 10);
	if (!Number.isFinite(dim) || dim <= 0) {
		throw new StorageError(`Invalid persisted vector dimension '${token}' in nodix_memory_chunk_vectors DDL`);
	}
	return dim;
}

/** Phase D: project_id PARTITION KEY on nodix_memory_chunk_vectors. */
export function vecTableDdlHasPartitionKey(sql: string): boolean {
	return /partition\s+key/i.test(sql);
}

export interface VecTableState {
	dimension: number;
	rowCount: number;
	hasPartitionKey: boolean;
}

export function readChunkVecTableState(db: SqliteDatabaseLike): VecTableState | undefined {
	const row = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memory_chunk_vectors' LIMIT 1",
		)
		.get() as { sql?: string | null } | null;
	if (!row?.sql) return undefined;
	const countRow = db.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunk_vectors").get() as {
		count?: number | bigint;
	} | null;
	const rawCount = countRow?.count ?? 0;
	const rowCount = typeof rawCount === "bigint" ? Number(rawCount) : Number(rawCount);
	return {
		dimension: parseVecTableDimension(row.sql),
		rowCount: Number.isFinite(rowCount) ? rowCount : 0,
		hasPartitionKey: vecTableDdlHasPartitionKey(row.sql),
	};
}

/**
 * Creates `nodix_memory_chunk_vectors` with the configured embedding dim and the
 * `project_id` PARTITION KEY (Phase D) if it does not already exist. Round A
 * migration 0004 creates the table at a placeholder 1024-d. vec0 virtual
 * tables cannot be ALTERed, so any pre-existing table that doesn't match the
 * current shape — wrong dimension, or predates the partition key — is
 * dropped and recreated. Nothing is shipped until npm publish (see
 * apps/mem-claw/CLAUDE.md), so no installed database has vectors worth
 * migrating in place; a non-empty mismatch fails closed instead.
 */
function ensureChunkVecTable(db: SqliteDB, vectorDim: number): number {
	if (!Number.isInteger(vectorDim) || vectorDim <= 0) {
		throw new StorageError(`Invalid vectorDim ${vectorDim}; must be a positive integer`);
	}
	const existing = readChunkVecTableState(db);
	if (existing && (existing.dimension !== vectorDim || !existing.hasPartitionKey)) {
		if (existing.rowCount > 0) {
			throw new StorageError(
				`nodix_memory_chunk_vectors does not match the current schema (configured dim ${vectorDim}, found dim ${existing.dimension}, partition key ${existing.hasPartitionKey}); wipe or re-import vectors before continuing`,
			);
		}
		db.exec("DROP TABLE nodix_memory_chunk_vectors");
	}
	db.exec(
		`CREATE VIRTUAL TABLE IF NOT EXISTS nodix_memory_chunk_vectors USING vec0(
			id TEXT PRIMARY KEY,
			project_id TEXT PARTITION KEY,
			embedding float[${vectorDim}]
		)`,
	);
	const verified = readChunkVecTableState(db);
	if (!verified) {
		throw new StorageError(
			"nodix_memory_chunk_vectors table is missing after initialization; cannot verify vector dimension",
		);
	}
	if (verified.dimension !== vectorDim) {
		throw new StorageError(
			`Vector dimension mismatch between configuration (${vectorDim}) and database (${verified.dimension}); wipe or re-import vectors before switching dimensions`,
		);
	}
	if (!verified.hasPartitionKey) {
		throw new StorageError(
			"nodix_memory_chunk_vectors is missing the project_id partition key after initialization",
		);
	}
	return verified.dimension;
}

/** Implements rebuild fts as the local SQLite connection setup operation. */
function rebuildFts(db: SqliteDB): void {
	// This persistence step establishes state that later reads and cleanup paths depend on.
	db.exec("INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts) VALUES('rebuild')");
}

/** Validates fts healthy before it enters the SQLite connection setup boundary. */
function ensureFtsHealthy(db: SqliteDB): void {
	// Isolate the database setup operation that can fail because of runtime I/O or input shape.
	try {
		// This persistence step establishes state that later reads and cleanup paths depend on.
		db.exec("INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts) VALUES('integrity-check')");
	} catch {
		log.warn("FTS integrity check failed, rebuilding", undefined, {
			event_name: "mem_claw.connection.fts.integrity.check.failed.rebuilding",
			file: "apps/mem-claw/src/storage/connection.ts",
			function: "ensureFtsHealthy",
			site_id: "connection.ensureFtsHealthy.ad5a3ffcd6",
		});
		rebuildFts(db);
	}
}

/**
 * Per PRD `cjk-other-fix.md` §D.3.4. Loads the wangfenjin/simple SQLite
 * tokenizer extension and registers its jieba dictionary path. Called once
 * per connection, BEFORE migrations run, so 0006 can create the
 * `nodix_memory_chunks_fts` virtual table with `tokenize='simple 0'`.
 *
 * The trailing smoke test fails fast if the extension load silently no-op'd:
 * creating an FTS5 table with an unregistered tokenizer name surfaces the
 * exact "no such tokenizer" error from sqlite-vec, instead of letting the
 * gateway start and silently fall back to unicode61 on first ingest.
 */
function loadSimpleTokenizer(db: SqliteDatabaseLike): void {
	const { platform, extensionPath, dictPath } = resolveSimpleTokenizerPath();
	db.loadExtension(extensionPath);
	db.prepare("SELECT jieba_dict(?)").get(dictPath);
	// Smoke: create + drop a temp FTS5 table with simple tokenizer. Surfaces
	// "no such tokenizer" immediately if the extension load was a no-op.
	db.exec(
		"CREATE VIRTUAL TABLE temp.nodix_simple_tokenizer_smoke USING fts5(x, tokenize='simple 0'); DROP TABLE temp.nodix_simple_tokenizer_smoke;",
	);
	log.info("simple-tokenizer loaded", { platform, extensionPath }, {
		event_name: "mem_claw.connection.simple.tokenizer.loaded",
		file: "apps/mem-claw/src/storage/connection.ts",
		function: "loadSimpleTokenizer",
		site_id: "connection.loadSimpleTokenizer.778ee7da6c",
	});
}

export function loadStorageExtensions(sqlite: SqliteRuntimeHandle): void {
	loadSqliteVecExtension(sqlite.raw);
	loadSimpleTokenizer(sqlite.db);
}

/**
 * Per PRD `cjk-other-fix.md` §D.3.6. Startup invariant: the persisted DDL
 * for `nodix_memory_chunks_fts` must declare `tokenize='simple ...'`. Catches DBs
 * created against an older plugin build (still on `unicode61`) so a stale
 * DB plus a fresh plugin doesn't silently degrade CJK recall to char-level.
 *
 * Mirrors the regex pattern used by `parseVecTableDimension` for
 * `nodix_memory_chunk_vectors` — single SELECT against `sqlite_master`, regex match.
 */
function assertFts5TokenizerIsSimple(db: SqliteDatabaseLike): void {
	const row = db
		.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='nodix_memory_chunks_fts' LIMIT 1")
		.get() as { sql?: string | null } | null;
	if (!row?.sql) {
		throw new StorageError(
			"nodix_memory_chunks_fts not found after migrations; cannot verify FTS5 tokenizer.",
		);
	}
	if (!/\btokenize\s*=\s*['"]simple\b/i.test(row.sql)) {
		throw new StorageError(
			"nodix_memory_chunks_fts must use simple-tokenizer (tokenize='simple ...'); " +
				`got: ${row.sql}. Wipe the DB so migration 0006 can run.`,
		);
	}
}

/**
 * Round A invariant: detect legacy DBs that pre-date migration 0004
 * (chunk-table swap). If the parent vec/FTS objects still exist, the DB
 * was opened against a build that never ran the new migration — fail loud
 * so the dev wipes the file.
 */
function assertParentVecAndFtsRemoved(db: SqliteDatabaseLike): void {
	const parentVec = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'nodix_memory_vectors' LIMIT 1",
		)
		.get();
	const parentFts = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'nodix_memories_fts' LIMIT 1",
		)
		.get();
	if (parentVec || parentFts) {
		throw new StorageError(
			"Legacy parent vec/FTS objects detected after migration 0004; " +
				"this DB pre-dates the chunk-table swap. Wipe the dev DB and let migrations recreate it: " +
				"rm -f the configured plugin DB path (default `<state-dir>/mem-claw/mem-claw.sqlite`) and restart.",
		);
	}
}

export function assertNoLegacyBoundarySchema(db: SqliteDatabaseLike): void {
	const rows = db.prepare("PRAGMA table_info(nodix_memories)").all() as Array<{
		name?: string;
	}>;
	if (rows.length === 0) return;
	const columnNames = new Set(rows.map((row) => row.name).filter((name): name is string => !!name));
	const legacyBoundaryColumn = ["s", "c", "o", "p", "e"].join("");
	if (columnNames.has(legacyBoundaryColumn) && !columnNames.has("project_id")) {
		throw new StorageError("legacy boundary schema is unsupported for provider v1");
	}
}

function ensureMemoryKindIndexes(db: SqliteDatabaseLike): void {
	db.exec(
		"CREATE INDEX IF NOT EXISTS nodix_idx_memories_project_fact_key_active ON nodix_memories(project_id, json_extract(metadata, '$.fact_key')) WHERE json_valid(metadata) AND json_extract(metadata, '$.fact_key') IS NOT NULL AND json_extract(metadata, '$.invalidated_at') IS NULL;",
	);
}

const CONNECTION_DIR = dirname(fileURLToPath(import.meta.url));
// Source layout (src/storage/connection.ts) needs "../../drizzle"; the bundled
// build at <plugin>/lib/index.js needs "../drizzle". Probe both so the plugin
// works in dev (tsx watch on source) and prod (bundled deploy on the VM).
function resolveMigrationsDir(): string {
	const candidates = [join(CONNECTION_DIR, "../../drizzle"), join(CONNECTION_DIR, "../drizzle")];
	for (const dir of candidates) {
		if (existsSync(join(dir, "meta/_journal.json"))) return dir;
	}
	throw new Error(`drizzle migrations folder not found; checked: ${candidates.join(", ")}`);
}
const MIGRATIONS_DIR = resolveMigrationsDir();

/** Implements init db as the local SQLite connection setup operation. */
// LH: initDb returns only after schema, FTS, and vector prerequisites are usable, which keeps later store code simple.
// LH: Failing during init protects callers from partially initialized memory state and avoids hard-to-debug recall gaps.
// LH: WAL mode is enabled for one-writer/many-reader plugin behavior while preserving crash-safe local persistence.
// LH: Migrations are intentionally local to mem-claw so storage evolution remains reviewable beside the plugin source.
// LH: Do not move extension loading into async service start unless every caller can tolerate unavailable retrieval at boot.
// LH: Applied migrations must remain byte-stable because Drizzle records their hashes in each database ledger.
// LH: Runtime vec-table reconciliation lives after migrations so dynamic dimensions do not require rewriting 0001.
export function initDb(dbPath: string, vectorDim: number): DrizzleDB {
	log.info("initializing database", { dbPath, vectorDim }, {
		event_name: "mem_claw.connection.initializing.database",
		file: "apps/mem-claw/src/storage/connection.ts",
		function: "initDb",
		site_id: "connection.initDb.ee37a0a971",
	});
	mkdirSync(dirname(dbPath), { recursive: true });
	const sqlite = openSqliteDatabase(dbPath);
	// Isolate the database setup operation that can fail because of runtime I/O or input shape.
	try {
		loadStorageExtensions(sqlite);
		sqlite.db.exec("PRAGMA journal_mode=WAL;");
		// Wait up to 5s for another writer before failing with SQLITE_BUSY.
		sqlite.db.exec("PRAGMA busy_timeout=5000;");
		sqlite.db.exec("PRAGMA foreign_keys=ON;");
		// WAL-recommended durability level: commits skip the per-commit fsync; the WAL
		// keeps the DB consistent through application crashes (nothing committed is
		// lost) and OS crashes (file never corrupts; commits since the last checkpoint
		// may be lost — accepted RPO for a local store with hourly backups).
		sqlite.db.exec("PRAGMA synchronous=NORMAL;");
		// 64 MiB page cache. Pages are decrypted on read under SQLCipher, so cache
		// hits also skip repeat decryption — this budget is sized against the
		// documented 4 GiB gateway floor.
		sqlite.db.exec("PRAGMA cache_size=-65536;");
		sqlite.db.exec("PRAGMA temp_store=MEMORY;");
		// Cap the WAL file so a burst of large transactions cannot grow it unbounded.
		sqlite.db.exec("PRAGMA journal_size_limit=67108864;");
		migrateLegacyDatabaseNamespace(sqlite.db, vectorDim);
		assertNoLegacyBoundarySchema(sqlite.db);
		ensureRemMigrationCompatibilityColumns(sqlite.db);
		const db = drizzle(sqlite.raw, { schema }) as DrizzleDBWithoutVector;
		migrateCompat(db, {
			migrationsFolder: MIGRATIONS_DIR,
		});
		applyEntityNameKeyMigration(sqlite.db);
		assertTodoStoreCountParity(sqlite.db);
		migrateUnplacedCandidates(sqlite.db);
		assertParentVecAndFtsRemoved(sqlite.db);
		assertFts5TokenizerIsSimple(sqlite.db);
		ensureMemoryKindIndexes(sqlite.db);
		assertMemoryKindsCutoverStartupGuard(sqlite.db);
		// vec table reconciliation runs after Drizzle migrations so 0004 can stay
		// byte-stable while fresh DBs still use the configured runtime dimension.
		const vectorDimension = ensureChunkVecTable(sqlite.db, vectorDim);
		ensureFtsHealthy(sqlite.db);
		log.info("database ready", { dbPath }, {
			event_name: "mem_claw.connection.database.ready",
			file: "apps/mem-claw/src/storage/connection.ts",
			function: "initDb",
			site_id: "connection.initDb.e23d8ab40c",
		});
		// Centralize the persistence fallback value at the boundary of this helper.
		return Object.assign(db, { vectorDimension, chokepoint: sqlite.db });
	} catch (error) {
		// Isolate the database setup operation that can fail because of runtime I/O or input shape.
		try {
			sqlite.db.close();
		} catch {
			// Close what opened successfully, then surface the original failure.
		}
		// Surface this invalid database setup state as an explicit typed failure.
		throw error;
	}
}

/** Implements close db as the local SQLite connection setup operation. */
export function closeDb(db: DrizzleDB): void {
	db.$client.close();
}

/** Implements migrate compat as the local SQLite connection setup operation. */
function migrateCompat(db: RuntimeDrizzleDB, options: { migrationsFolder: string }): void {
	migrate(db, options);
}

function ensureRemMigrationCompatibilityColumns(database: SqliteDatabaseLike): void {
	ensureColumn(database, "nodix_rem_scan_pairs", "budget_invocation_id", "TEXT");
	ensureColumn(
		database,
		"nodix_rem_scan_pairs",
		"attempt_count",
		"INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)",
	);
	ensureColumn(
		database,
		"nodix_rem_scan_pairs",
		"progress_state",
		"TEXT NOT NULL DEFAULT 'pending' CHECK (progress_state IN ('pending', 'refused', 'closed', 'exhausted'))",
	);
	ensureColumn(database, "nodix_rem_scan_pairs", "refusal_reason", "TEXT");
	ensureColumn(database, "nodix_rem_scan_pairs", "inherited_from_generation_id", "TEXT");
}

function ensureColumn(
	database: SqliteDatabaseLike,
	tableName: "nodix_memory_chunks" | "nodix_rem_scan_pairs",
	columnName: string,
	declaration: string,
): void {
	const table = database
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(tableName);
	if (table === undefined) return;
	const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
		name: string;
	}>;
	if (columns.some(({ name }) => name === columnName)) return;
	database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${declaration}`);
}
