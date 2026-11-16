/** @file migrations.ts
 * @purpose Public, idempotent migration entry point used by the self-upgrade
 *   smoke test. Walks the SQLCipher chokepoint, loads
 *   sqlite-vec + simple-tokenizer, then applies drizzle migrations.
 * @boundary Standalone — does not depend on the rest of the storage runtime
 *   beyond the chokepoint and migrations directory resolution.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readSettings } from "../contract/profile";
import * as schema from "./schema";
import { applyEntityNameKeyMigration } from "./entity-name-key-migration";
import { migrateLegacyDatabaseNamespace } from "./legacy-database-namespace-migration";
import { resolveSimpleTokenizerPath } from "./simple-tokenizer-path";
import { loadSqliteVecExtension } from "./sqlite-vec-path";
import { initSqliteRuntime, openSqliteDatabase } from "./sqlite-runtime";
import { migrateUnplacedCandidates } from "./unplaced-candidate-migration";

const MIGRATIONS_DIR = resolveMigrationsDir();

/**
 * Apply drizzle migrations against the encrypted DB at `dbPath`. Idempotent —
 * drizzle's `__drizzle_migrations` table tracks applied migrations by hash, so
 * a second call is a no-op. The self-upgrade smoke test calls this against a
 * new ephemeral database; the plugin runtime opens its configured database
 * through `initDb()` instead.
 *
 * The key comes from settings. Caller is responsible for closing nothing; this
 * function opens its own connection and closes it on exit.
 */
export function runMigrations(dbPath: string): void {
	initSqliteRuntime(readSettings().store.encryptionKey);
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
	} finally {
		try {
			sqlite.db.close();
		} catch {
			// best-effort
		}
	}
}

function resolveMigrationsDir(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(moduleDir, "../../drizzle"), join(moduleDir, "../drizzle"), join(moduleDir, "../../../drizzle")];
	for (const dir of candidates) {
		if (existsSync(join(dir, "meta/_journal.json"))) return dir;
	}
	throw new Error(`drizzle migrations folder not found; checked: ${candidates.join(", ")}`);
}
