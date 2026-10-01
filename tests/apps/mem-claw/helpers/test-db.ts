/** Real LLM API required. No mocking. Missing keys = FAIL. */

/**
 * Real encrypted SQLite + sqlite-vec temp DB factory for mem-claw tests.
 *
 * Creates a fully initialized SQLite file at a unique /tmp path. Uses the
 * actual SQL from the migration files (not Drizzle's migrator) so that tests
 * work regardless of whether drizzle-kit has been run.
 *
 * cleanup() closes the DB connection and removes the file.
 */

import { stopTestMemory } from "./memory-sidecar-fixture.ts";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as sqliteVec from "sqlite-vec";
import {
	createEmbedder,
	type Embedder,
} from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import * as schema from "../../../../packages/memory/src/store/schema.ts";
import { resolveSimpleTokenizerPath } from "../../../../packages/memory/src/store/simple-tokenizer-path.ts";
import {
	_resetSqliteRuntimeForTest,
	initSqliteRuntime,
	openSqliteDatabase,
	type RawSqliteDatabase,
	type SqliteRuntimeHandle,
} from "../../../../packages/memory/src/store/sqlite-runtime.ts";
import {
	registerOwnedTemporaryRoot,
	releaseOwnedTemporaryRoot,
} from "./temporary-key-sentinel.ts";

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;
export type TestSqliteDatabase = RawSqliteDatabase & BetterSqlite3.Database;

const NODIX_MEMORIES_DDL = `
CREATE TABLE IF NOT EXISTS nodix_memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  project_id TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.7,
  timestamp INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}',
  content_hash TEXT NOT NULL,
  fact_id TEXT,
  derived_from TEXT,
  consolidation_epoch_id TEXT,
  confidence_source TEXT,
  lane TEXT NOT NULL DEFAULT 'active' CHECK (lane IN ('active', 'parked', 'quarantined')),
  raw_candidate_json TEXT,
  disposition_reason TEXT,
  dispositioned_at_ms INTEGER
);`;

const NODIX_MEMORIES_INDEXES_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS nodix_idx_memories_project_content_hash
ON nodix_memories (project_id, content_hash, category);
CREATE INDEX IF NOT EXISTS nodix_idx_memories_content_hash
ON nodix_memories (content_hash);
CREATE INDEX IF NOT EXISTS nodix_idx_memories_fact_id ON nodix_memories(fact_id);
CREATE INDEX IF NOT EXISTS nodix_idx_memories_lane_project
ON nodix_memories(lane, project_id);
CREATE INDEX IF NOT EXISTS nodix_idx_memories_reflection_items
ON nodix_memories(timestamp DESC)
WHERE json_valid(metadata) AND json_extract(metadata, '$.type') = 'memory-reflection-item';
CREATE INDEX IF NOT EXISTS nodix_idx_memories_idempotency_key
ON nodix_memories(project_id, json_extract(metadata, '$.idempotency_key'))
WHERE json_valid(metadata) AND json_extract(metadata, '$.idempotency_key') IS NOT NULL;`;

const PROVIDER_AUTHORITY_DDL = `
CREATE TABLE IF NOT EXISTS nodix_provider_project_mappings (
  user_id TEXT NOT NULL,
  external_system TEXT NOT NULL,
  external_project_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, external_system, external_project_key),
  UNIQUE (project_id)
);
CREATE TABLE IF NOT EXISTS nodix_provider_agent_mappings (
  user_id TEXT NOT NULL,
  external_system TEXT NOT NULL,
  external_agent_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, external_system, external_agent_key),
  UNIQUE (agent_id)
);
CREATE TABLE IF NOT EXISTS nodix_provider_project_agents (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id, agent_id)
);`;

const EXTRACTION_TIMESTAMPS_DDL = `
CREATE TABLE IF NOT EXISTS nodix_memory_extraction_timestamps (
  project_id TEXT NOT NULL,
  replay_key TEXT NOT NULL,
  resolved_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id, replay_key)
) WITHOUT ROWID;`;

const NODIX_MEMORIES_FACT_ID_TRIGGERS_DDL = `
CREATE TRIGGER IF NOT EXISTS nodix_memories_fact_id_insert_guard
BEFORE INSERT ON nodix_memories
WHEN NEW.fact_id IS NULL
BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;
CREATE TRIGGER IF NOT EXISTS nodix_memories_fact_id_update_guard
BEFORE UPDATE ON nodix_memories
WHEN NEW.fact_id IS NULL
BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;`;

const MEMORY_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS nodix_memory_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type    TEXT    NOT NULL,
  fact_id       TEXT,
  memory_kind   TEXT,
  timestamp_ms  INTEGER NOT NULL,
  session_uuid  TEXT,
  turn_id       TEXT,
  agent_id      TEXT    NOT NULL,
  project_id    TEXT,
  tenant_id     TEXT,

  source_event_id   INTEGER,
  derived_from      TEXT,

  consolidation_epoch_id  TEXT,

  content_hash    TEXT,
  receipt_hmac    TEXT,
  key_version     INTEGER,

  retrieval_rank    INTEGER,
  retrieval_score   REAL,

  query_tenant_id   TEXT,
  result_tenant_id  TEXT,

  metadata_json   TEXT,

  CHECK (event_type IN (
    'create',
    'update',
    'recall',
    'supersede',
    'delete',
    'inject',
    'epoch_boundary',
    'purge'
  )),
  CHECK (event_type = 'epoch_boundary' OR fact_id IS NOT NULL)
);`;

// Mirrors migration 0011: unqueried/covered indexes trimmed, retention-shaped
// partial index added, epoch/turn indexes converted to partials.
const MEMORY_EVENTS_INDEXES_DDL = `
CREATE INDEX nodix_idx_memory_events_fact      ON nodix_memory_events(fact_id);
CREATE INDEX nodix_idx_memory_events_epoch     ON nodix_memory_events(consolidation_epoch_id) WHERE consolidation_epoch_id IS NOT NULL;
CREATE INDEX nodix_idx_memory_events_project   ON nodix_memory_events(project_id, event_type, timestamp_ms);
CREATE INDEX nodix_idx_memory_events_turn      ON nodix_memory_events(turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX nodix_idx_memory_events_usage_retention ON nodix_memory_events(timestamp_ms) WHERE event_type IN ('recall', 'inject');`;

// Mirrors migration 0011: UPDATE stays fully blocked; DELETE is blocked for every
// lifecycle event type and allowed only for 'recall'/'inject' usage rows (retention).
const MEMORY_EVENTS_APPEND_ONLY_TRIGGERS_DDL = `
CREATE TRIGGER memory_events_no_update BEFORE UPDATE ON nodix_memory_events
BEGIN SELECT RAISE(ABORT, 'nodix_memory_events is append-only'); END;
CREATE TRIGGER memory_events_lifecycle_delete_guard BEFORE DELETE ON nodix_memory_events
WHEN OLD.event_type NOT IN ('recall', 'inject')
BEGIN SELECT RAISE(ABORT, 'nodix_memory_events lifecycle rows are append-only'); END;`;

const MEMORY_USAGE_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS nodix_memory_usage_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('recall', 'inject')),
  payload_json TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'flushing', 'quarantined')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_ms INTEGER
);
CREATE INDEX IF NOT EXISTS nodix_idx_memory_usage_outbox_status_next
ON nodix_memory_usage_outbox(status, next_attempt_ms);`;

const MEMORY_TELEMETRY_INCIDENTS_DDL = `
CREATE TABLE IF NOT EXISTS nodix_memory_telemetry_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nodix_idx_memory_telemetry_incidents_created
ON nodix_memory_telemetry_incidents(created_at_ms);`;

const MEMORY_TELEMETRY_SYNC_STATE_DDL = `
CREATE TABLE IF NOT EXISTS nodix_memory_telemetry_sync_state (
  sink TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);`;

const DRIZZLE_MIGRATION_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS __drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
);
INSERT INTO __drizzle_migrations (hash, created_at)
SELECT 'test-helper-current-schema', 1740000000013
WHERE NOT EXISTS (SELECT 1 FROM __drizzle_migrations);`;

// Round B-2: chunks-table DDL mirrors `apps/mem-claw/drizzle/0004_chunk_swap.sql`.
// The parent FTS schema (`nodix_memories_fts` + 3 triggers) is gone; chunks own
// the FTS surface now. `nodix_memory_chunk_vectors` is created here as a placeholder at
// dim 1024; `MemoryStore` runtime (`ensureChunkVecTable`) drops + recreates it
// at the configured `vectorDim` on first init.

const CLAW_CHUNKS_DDL = `
CREATE TABLE IF NOT EXISTS nodix_memory_chunks (
  chunk_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  dense_payload TEXT NOT NULL,
  summary TEXT,
  entities TEXT,
  tags TEXT,
  source TEXT,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('conversation', 'prose', 'code')),
  chunking_version TEXT NOT NULL,
  embedder_provider TEXT NOT NULL,
  embedder_model TEXT NOT NULL,
  embedder_dim INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES nodix_memories(id) ON DELETE CASCADE
);`;

const CLAW_CHUNKS_INDEXES_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS nodix_idx_memory_chunks_memory ON nodix_memory_chunks(memory_id, chunk_index);`;

const VEC_CLAW_CHUNKS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodix_memory_chunk_vectors USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[1024]
);`;

const CLAW_CHUNKS_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodix_memory_chunks_fts
USING fts5(
  dense_payload,
  content='nodix_memory_chunks',
  content_rowid='rowid',
  tokenize='simple 0'
);`;

const CHUNK_TRIGGER_AI = `
CREATE TRIGGER IF NOT EXISTS nodix_memory_chunks_ai
AFTER INSERT ON nodix_memory_chunks BEGIN
  INSERT INTO nodix_memory_chunks_fts(rowid, dense_payload)
  VALUES (new.rowid, new.dense_payload);
END;`;

const CHUNK_TRIGGER_AD = `
CREATE TRIGGER IF NOT EXISTS nodix_memory_chunks_ad
AFTER DELETE ON nodix_memory_chunks BEGIN
  INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rowid, dense_payload)
  VALUES ('delete', old.rowid, old.dense_payload);
END;`;

const CHUNK_TRIGGER_AU = `
CREATE TRIGGER IF NOT EXISTS nodix_memory_chunks_au
AFTER UPDATE ON nodix_memory_chunks BEGIN
  INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rowid, dense_payload)
  VALUES ('delete', old.rowid, old.dense_payload);
  INSERT INTO nodix_memory_chunks_fts(rowid, dense_payload)
  VALUES (new.rowid, new.dense_payload);
END;`;

export interface TestDb {
	db: DrizzleDB;
	sqlite: TestSqliteDatabase;
	runtime: SqliteRuntimeHandle;
	dbPath: string;
	/** The 64-hex key the database was created with; a settings file for this database carries it. */
	encryptionKey: string;
	cleanup: () => void;
}

interface EnvSnapshot {
	SNO_PROFILE_DIR?: string;
	HOME?: string;
	SNO_STATION_CORE_TESTING?: string;
}

const CRYPTO_TEST_ENV_KEYS = ["SNO_PROFILE_DIR", "HOME", "SNO_STATION_CORE_TESTING"] as const;

// The store manifest lives under the home directory's `.config/sno-station-core`; a test home keeps
// every temporary database out of the operator's manifest.
function installCryptoTestEnv(dbDir: string): EnvSnapshot {
	const prior: EnvSnapshot = Object.fromEntries(CRYPTO_TEST_ENV_KEYS.map(key => [key, process.env[key]]));
	process.env.SNO_PROFILE_DIR = dbDir;
	process.env.HOME = join(dbDir, "home");
	process.env.SNO_STATION_CORE_TESTING = "1";
	_resetSqliteRuntimeForTest();
	return prior;
}

function restoreCryptoTestEnv(prior: EnvSnapshot): void {
	for (const key of CRYPTO_TEST_ENV_KEYS) {
		const value = prior[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	_resetSqliteRuntimeForTest();
}

function cleanupTestDb(
	sqlite: TestSqliteDatabase | undefined,
	dbDir: string,
	cryptoEnv: EnvSnapshot,
): void {
	stopTestMemory(join(dbDir, "test.sqlite"));
	try {
		sqlite?.close();
	} catch {
		// ignore close errors in tests
	}
	let cleanupError: unknown;
	try {
		releaseOwnedTemporaryRoot(dbDir);
	} catch (error) {
		cleanupError = error;
	}
	restoreCryptoTestEnv(cryptoEnv);
	if (cleanupError) throw cleanupError;
}

const MIGRATIONS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/memory/drizzle",
);

export function createTestDb(): TestDb {
	const dbDir = mkdtempSync(join(tmpdir(), "mem-claw-test-"));
	registerOwnedTemporaryRoot(dbDir);
	const dbPath = join(dbDir, "test.sqlite");
	const cryptoEnv = installCryptoTestEnv(dbDir);
	const encryptionKey = randomBytes(32).toString("hex");

	let sqlite: TestSqliteDatabase | undefined;
	try {
		initSqliteRuntime(encryptionKey);
		const runtime = openSqliteDatabase(dbPath);
		sqlite = runtime.raw as TestSqliteDatabase;
		sqliteVec.load(sqlite);
		const simpleTokenizer = resolveSimpleTokenizerPath();
		sqlite.loadExtension(simpleTokenizer.extensionPath);
		sqlite.prepare("SELECT jieba_dict(?)").get(simpleTokenizer.dictPath);
		sqlite.exec("PRAGMA journal_mode=WAL;");
		sqlite.exec("PRAGMA foreign_keys=ON;");

		// The schema comes from the migrations the product itself runs, from 0000, and nothing is
		// hand-written here any more.
		//
		// It used to be the other way round: this file kept its own DDL, stamped a ledger row
		// claiming migration 0013 was applied, and let Drizzle add 0014 onward. Every table the
		// hand-written copy created with IF NOT EXISTS then silently won over the migration that
		// owned it, so a fixture could sit two years behind the product and still look healthy.
		// Measured 2026-08-29: `nodix_memories` had no `timezone` and `nodix_memory_chunk_vectors`
		// had no `project_id`, and 53 REM writer cases had been failing for two days in the suite
		// whose subject is the write path.
		const drizzleDb = drizzle(sqlite, { schema });
		migrate(drizzleDb, { migrationsFolder: MIGRATIONS_DIR });
		// Migration 0004 creates the vector table as a placeholder and says so in its own comment;
		// the real shape — the project_id partition key and the configured dimension — is settled at
		// startup by `ensureChunkVecTable` in `apps/mem-claw/src/storage/connection.ts`. A fixture is
		// a database the product is about to use, so it takes that step too. The table is empty here,
		// which is the condition under which the runtime also recreates it.
		sqlite.exec("DROP TABLE IF EXISTS nodix_memory_chunk_vectors");
		sqlite.exec(
			`CREATE VIRTUAL TABLE nodix_memory_chunk_vectors USING vec0(
				id TEXT PRIMARY KEY,
				project_id TEXT PARTITION KEY,
				embedding float[1024]
			)`,
		);

		// Run FTS5 integrity check on the chunks-FTS surface
		try {
			sqlite
				.prepare(
					"INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts) VALUES('integrity-check')",
				)
				.run();
		} catch {
			sqlite
				.prepare(
					"INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts) VALUES('rebuild')",
				)
				.run();
		}

		const db = drizzleDb;

		function cleanup(): void {
			cleanupTestDb(sqlite, dbDir, cryptoEnv);
		}

		return { db, sqlite, runtime, dbPath, encryptionKey, cleanup };
	} catch (error) {
		cleanupTestDb(sqlite, dbDir, cryptoEnv);
		throw error;
	}
}

/**
 * Real local-onnx embedder for tests. Per project test policy: real
 * embeddings, no mocks. Cached at module level so the multi-second ONNX
 * model load is paid once per process even though many tests call this.
 *
 * Do NOT dispose this embedder in per-test cleanup — the next test reuses it.
 */
let cachedEmbedderPromise: Promise<Embedder> | null = null;

export function createTestEmbedder(): Promise<Embedder> {
	if (cachedEmbedderPromise) return cachedEmbedderPromise;
	cachedEmbedderPromise = (async () => {
		const embedder = createEmbedder({ provider: "local-onnx" }, tmpdir());
		await embedder.warmup();
		return embedder;
	})();
	return cachedEmbedderPromise;
}

export interface TestEnv {
	db: DrizzleDB;
	dbPath: string;
	embedder: Embedder;
	cleanup: () => void;
}

/**
 * Convenience factory that combines `createTestDb()` with the cached
 * `createTestEmbedder()`. The cleanup function only closes the DB — the
 * shared embedder lives for the process.
 */
export async function createTestEnv(): Promise<TestEnv> {
	const { db, dbPath, cleanup } = createTestDb();
	const embedder = await createTestEmbedder();
	return { db, dbPath, embedder, cleanup };
}
