/** @file memory-timezone-migration.test.ts
 * @purpose Proves an existing memory database gains a durable timezone pair during upgrade.
 * @boundary Real Drizzle migrator over a pre-timezone SQLite schema with persisted data.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { initSqliteRuntime, openSqliteDatabase } from "../../../../packages/memory/src/store/sqlite-runtime";
import { makeTestEnv } from "../../sqlite-crypto/_helpers";

const MIGRATIONS_DIR = fileURLToPath(
	new URL("../../../../packages/memory/drizzle", import.meta.url),
);

describe("memory timezone migration", () => {
	it("adds and backfills timezone on an existing database exactly once", () => {
		const cryptoEnv = makeTestEnv("memory-timezone-migration");
		initSqliteRuntime(cryptoEnv.keyHex);
		const directory = mkdtempSync(join(tmpdir(), "memory-timezone-migration-"));
		const databasePath = join(directory, "memory.sqlite");
		const runtime = openSqliteDatabase(databasePath);
		try {
			runtime.db.exec(`
				CREATE TABLE nodix_memories (
					id TEXT PRIMARY KEY,
					text TEXT NOT NULL,
					category TEXT NOT NULL,
					project_id TEXT NOT NULL,
					importance REAL NOT NULL DEFAULT 0.7,
					timestamp INTEGER NOT NULL,
					metadata TEXT DEFAULT '{}',
					content_hash TEXT NOT NULL
				);
				INSERT INTO nodix_memories(
					id, text, category, project_id, timestamp, content_hash
				) VALUES (
					'legacy-row', 'Existing memory.', 'episodic', 'global', 1700000000000, 'legacy-hash'
				);
				-- A real database at migration 0027 also carries the REM write tables, created by
				-- 0018 and 0024. Migration 0029 alters both, so a fixture that names only
				-- nodix_memories would fail there for a reason that has nothing to do with the
				-- timezone upgrade this case is about.
				CREATE TABLE nodix_rem_recovery_history (
					recovery_handle TEXT PRIMARY KEY,
					row_id TEXT NOT NULL,
					operation_kind TEXT NOT NULL CHECK (operation_kind IN ('lane', 'text-version', 'mark')),
					prior_row_image TEXT NOT NULL,
					prior_content_hash TEXT NOT NULL,
					expected_post_hash TEXT NOT NULL,
					reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
					mutation_ts TEXT NOT NULL,
					restored_at TEXT
				);
				CREATE TABLE nodix_rem_write_attempts (
					attempt_id TEXT PRIMARY KEY,
					job_id TEXT NOT NULL,
					stage TEXT NOT NULL,
					row_id TEXT NOT NULL,
					writer TEXT NOT NULL,
					attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
					outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'succeeded', 'failed', 'refused', 'degraded')),
					reason_code TEXT,
					pre_write_content_sha256 TEXT NOT NULL,
					proposed_text_sha256 TEXT NOT NULL,
					evidence_id TEXT NOT NULL,
					configuration_sha256 TEXT NOT NULL,
					post_write_content_sha256 TEXT,
					opened_at TEXT NOT NULL,
					closed_at TEXT
				);
				CREATE TABLE __drizzle_migrations (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					hash TEXT NOT NULL,
					created_at NUMERIC
				);
				INSERT INTO __drizzle_migrations(hash, created_at)
				VALUES ('through-0027', 1740000000027);
			`);

			const database = drizzle(runtime.raw);
			migrate(database, { migrationsFolder: MIGRATIONS_DIR });

			expect(
				runtime.db
					.prepare("SELECT timestamp, timezone FROM nodix_memories WHERE id = 'legacy-row'")
					.get(),
			).toEqual({ timestamp: 1_700_000_000_000, timezone: "UTC" });
			expect(() =>
				runtime.db
					.prepare(`
						INSERT INTO nodix_memories(
							id, text, category, project_id, timestamp, content_hash
						) VALUES ('missing-zone', 'Missing zone.', 'episodic', 'global', 1700000000001, 'missing-zone-hash')
					`)
					.run(),
			).toThrow(/timezone is required/u);
			expect(() =>
				runtime.db
					.prepare(`
						INSERT INTO nodix_memories(
							id, text, category, project_id, timestamp, timezone, content_hash
						) VALUES ('blank-zone', 'Blank zone.', 'episodic', 'global', 1700000000002, '   ', 'blank-zone-hash')
					`)
					.run(),
			).toThrow(/timezone is required/u);
			expect(() =>
				runtime.db
					.prepare("UPDATE nodix_memories SET timezone = ' ' WHERE id = 'legacy-row'")
					.run(),
			).toThrow(/timezone is required/u);
			const firstMigrationCount = runtime.db
				.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
				.get();

			migrate(database, { migrationsFolder: MIGRATIONS_DIR });

			expect(
				runtime.db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get(),
			).toEqual(firstMigrationCount);
		} finally {
			runtime.db.close();
			rmSync(directory, { recursive: true, force: true });
			cryptoEnv.cleanup();
		}
	});
});
