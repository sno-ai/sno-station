/** @file sqlite-runtime.ts
 * @purpose Single chokepoint for opening encrypted SQLite databases used by
 *   the plugin. Routes all opens through `@snoai/sno-station-core-crypto`, which applies
 *   the SQLCipher PRAGMA recipe, manifest registration, and canary-row
 *   verification. There is no direct `better-sqlite3` access in this file —
 *   the import-restriction lint rule in `biome.json` enforces this for the
 *   whole `apps/sno-station-mem/src/**` tree.
 * @boundary Plugin storage runtime. All consumers (`connection.ts`,
 *   `store.ts`, `backup.ts`, `observability/memory-snapshot.ts`) depend on
 *   this abstraction.
 */

import { memoryWrite, memoryTransaction } from "../engine/operation-cancellation";
import { existsSync } from "node:fs";
import {
	type Dek,
	getDek,
	getDekSync,
	openEncryptedDb,
	openEncryptedDbReadonly,
} from "@snoai/sno-station-core-crypto";
import { LRUCache } from "lru-cache";

// The runtime returns a `Database` from better-sqlite3-multiple-ciphers via
// the sno-station-core-crypto package. We surface only the subset the plugin uses, so
// callers stay decoupled from the underlying driver.
type ChokepointDb = ReturnType<typeof openEncryptedDb>;

export type RawSqliteDatabase = ChokepointDb;

export interface SqliteStatementLike {
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	run(...params: unknown[]): unknown;
}

export interface SqliteTransactionLike {
	(...args: unknown[]): unknown;
	default(...args: unknown[]): unknown;
	deferred(...args: unknown[]): unknown;
	immediate(...args: unknown[]): unknown;
	exclusive(...args: unknown[]): unknown;
}

export interface SqliteDatabaseLike {
	prepare(sql: string): SqliteStatementLike;
	exec(sql: string): unknown;
	close(): void;
	transaction(fn: (...args: never[]) => unknown): SqliteTransactionLike;
	loadExtension(path: string): void;
	runRecoveryOperation<T>(operation: (raw: RawSqliteDatabase) => T): T;
}

export interface SqliteRuntimeHandle {
	kind: "sno-station-core-encrypted";
	raw: RawSqliteDatabase;
	db: SqliteDatabaseLike;
}

export interface SqliteOpenOptions {
	readonly?: boolean;
	fileMustExist?: boolean;
}

class RuntimeNotInitialized extends Error {
	constructor() {
		super(
			"sqlite-runtime not yet initialized — await initSqliteRuntime() before opening databases",
		);
		this.name = "RuntimeNotInitialized";
	}
}

export class SqliteFileMissingError extends Error {
	constructor(dbPath: string) {
		super(`sqlite database not found at ${dbPath} (fileMustExist)`);
		this.name = "SqliteFileMissingError";
	}
}

let resolvedDek: Dek | undefined;
let initPromise: Promise<void> | undefined;

/**
 * Resolve the DEK once at plugin boot. Idempotent — concurrent callers share
 * the same Promise. After this resolves, the sync factories
 * (`openSqliteDatabase`, `openSqliteDatabaseReadonly`) can be called.
 */
export async function initSqliteRuntime(): Promise<void> {
	if (resolvedDek) return;
	if (!initPromise) {
		initPromise = (async () => {
			resolvedDek = await getDek();
		})().catch((err: unknown) => {
			initPromise = undefined;
			throw err;
		});
	}
	await initPromise;
}

/**
 * Synchronous variant for entry points that cannot await (e.g. SnoStationMem's
 * `register()` contract). Throws when the DEK is in passphrase mode and
 * requires an interactive prompt — those flows must use `initSqliteRuntime()`
 * instead.
 */
export function initSqliteRuntimeSync(): void {
	if (resolvedDek) return;
	resolvedDek = getDekSync();
}

/** Test-only hook: drop the cached DEK so a subsequent test pass re-initializes. */
export function _resetSqliteRuntimeForTest(): void {
	resolvedDek = undefined;
	initPromise = undefined;
}

function wrapEncryptedDatabase(rawDb: ChokepointDb): { raw: RawSqliteDatabase; db: SqliteDatabaseLike } {
	const statements = new LRUCache<string, SqliteStatementLike>({ max: 256 });
	return { raw: rawDb, db: {
		prepare(sql: string): SqliteStatementLike {
			const cached = statements.get(sql);
			if (cached) return cached;
			const raw = rawDb.prepare(sql);
			const statement: SqliteStatementLike = {
				get: (...params) => raw.readonly ? raw.get(...params) : memoryWrite(() => raw.get(...params)),
				all: (...params) => raw.readonly ? raw.all(...params) : memoryWrite(() => raw.all(...params)),
				run: (...params) => raw.readonly ? raw.run(...params) : memoryWrite(() => raw.run(...params)),
			};
			statements.set(sql, statement);
			return statement;
		},
		exec: (sql) => memoryWrite(() => rawDb.exec(sql)),
		close(): void { statements.clear(); rawDb.close(); },
		transaction: (fn) => {
			const transaction = rawDb.transaction(fn) as SqliteTransactionLike;
			const run = (...args: unknown[]): unknown => memoryTransaction(() => transaction(...args));
			return Object.assign(run, {
				default: (...args: unknown[]) => memoryTransaction(() => transaction.default(...args)),
				deferred: (...args: unknown[]) => memoryTransaction(() => transaction.deferred(...args)),
				immediate: (...args: unknown[]) => memoryTransaction(() => transaction.immediate(...args)),
				exclusive: (...args: unknown[]) => memoryTransaction(() => transaction.exclusive(...args)),
			});
		},
		loadExtension: (path) => { rawDb.loadExtension(path); },
		runRecoveryOperation: (operation) => operation(rawDb),
	} };
}

/**
 * Opens an encrypted SQLite database for read-write access. Throws
 * `RuntimeNotInitialized` if `initSqliteRuntime()` has not yet resolved —
 * never opens a raw (unencrypted) handle as a fallback.
 */
export function openSqliteDatabase(
	dbPath: string,
	options: SqliteOpenOptions = {},
): SqliteRuntimeHandle {
	if (!resolvedDek) throw new RuntimeNotInitialized();
	// openEncryptedDb has no fileMustExist option and silently CREATES a fresh
	// empty encrypted DB for any missing path — which would mask a lost or
	// mistyped production database as sudden data loss. Enforce the declared
	// contract here so callers that opt in get a loud failure instead.
	if (options.fileMustExist && !existsSync(dbPath)) {
		throw new SqliteFileMissingError(dbPath);
	}
	if (options.readonly) {
		return openSqliteDatabaseReadonly(dbPath);
	}
	const raw = openEncryptedDb(dbPath, resolvedDek);
	const guarded = wrapEncryptedDatabase(raw);
	return {
		kind: "sno-station-core-encrypted",
		raw: guarded.raw,
		db: guarded.db,
	};
}

/**
 * Opens an encrypted SQLite database for read-only access. Requires that the
 * database was previously registered via the read-write factory (the manifest
 * entry must already exist). Throws `RuntimeNotInitialized` if init has not
 * yet completed.
 */
export function openSqliteDatabaseReadonly(dbPath: string): SqliteRuntimeHandle {
	if (!resolvedDek) throw new RuntimeNotInitialized();
	const raw = openEncryptedDbReadonly(dbPath, resolvedDek);
	const guarded = wrapEncryptedDatabase(raw);
	return {
		kind: "sno-station-core-encrypted",
		raw: guarded.raw,
		db: guarded.db,
	};
}

export { RuntimeNotInitialized };
