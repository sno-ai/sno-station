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
	/**
	 * Fail-closed storage latch. Once tripped (integrity failure detected by the
	 * maintenance pass), EVERY statement execution on this handle — including
	 * statements prepared BEFORE the latch — and every exec/prepare throws a
	 * typed StorageFailedError without executing SQL. close() stays allowed.
	 */
	markFailed(reason: string): void;
	isFailed(): boolean;
	getFailureReason(): string | undefined;
	clearFailedAfterVerifiedRecovery(): void;
	runRecoveryOperation<T>(operation: (raw: RawSqliteDatabase) => T): T;
}

/** Thrown by every SQL entry point on a handle whose storage latch has tripped. */
export class StorageFailedError extends Error {
	constructor(reason: string) {
		super(`sqlite storage is latched failed: ${reason}`);
		this.name = "StorageFailedError";
	}
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

type Callable = (...args: unknown[]) => unknown;

function isCallable(value: unknown): value is Callable {
	return typeof value === "function";
}

function guardObjectMethods<T extends object>(target: T, assertNotFailed: () => void): T {
	return new Proxy(target, {
		get(rawTarget, property): unknown {
			const value: unknown = Reflect.get(rawTarget, property, rawTarget);
			if (!isCallable(value)) return value;
			return (...args: unknown[]): unknown => {
				assertNotFailed();
				return Reflect.apply(value, rawTarget, args);
			};
		},
	});
}

function guardTransaction(
	transaction: SqliteTransactionLike,
	assertNotFailed: () => void,
): SqliteTransactionLike {
	const invoke = (method: Callable, args: unknown[]): unknown => {
		assertNotFailed();
		return Reflect.apply(method, transaction, args);
	};
	const guarded = ((...args: unknown[]): unknown => invoke(transaction, args)) as SqliteTransactionLike;
	guarded.default = (...args: unknown[]): unknown => invoke(transaction.default, args);
	guarded.deferred = (...args: unknown[]): unknown => invoke(transaction.deferred, args);
	guarded.immediate = (...args: unknown[]): unknown => invoke(transaction.immediate, args);
	guarded.exclusive = (...args: unknown[]): unknown => invoke(transaction.exclusive, args);
	return guarded;
}

interface GuardedDatabase {
	raw: RawSqliteDatabase;
	db: SqliteDatabaseLike;
}

function wrapEncryptedDatabase(rawDb: ChokepointDb): GuardedDatabase {
	// Per-connection prepared-statement cache keyed by SQL string. Hot paths run a
	// fixed set of statements; re-preparing each call re-parses and re-plans. Safe to
	// share by construction: `SqliteStatementLike` exposes only get/all/run, so no
	// caller can flip statement-level modes (pluck/raw/safeIntegers are unreachable),
	// and SQLite re-prepares internally on schema change (SQLITE_SCHEMA). better-sqlite3
	// statements are bound to their connection, so the cache dies with `close()`.
	const statements = new LRUCache<string, SqliteStatementLike>({ max: 256 });
	// Shared fail-closed latch. The guard lives INSIDE each wrapped statement's
	// run/get/all, so statements prepared before the latch trips are covered too
	// (the telemetry event writer pre-prepares its statements at construction).
	let failedReason: string | undefined;
	const assertNotFailed = (): void => {
		if (failedReason !== undefined) throw new StorageFailedError(failedReason);
	};
	const guardedRaw = new Proxy(rawDb, {
		get(target, property): unknown {
			const value: unknown = Reflect.get(target, property, target);
			if (!isCallable(value)) return value;
			if (property === "close") return value.bind(target);
			return (...args: unknown[]): unknown => {
				assertNotFailed();
				const result = Reflect.apply(value, target, args);
				if (property === "prepare" && typeof result === "object" && result !== null) {
					return guardObjectMethods(result, assertNotFailed);
				}
				if (property === "transaction" && isCallable(result)) {
					return guardTransaction(result as SqliteTransactionLike, assertNotFailed);
				}
				return result;
			};
		},
	}) as ChokepointDb;
	const wrapStatement = (stmt: SqliteStatementLike): SqliteStatementLike => ({
		get(...params: unknown[]): unknown {
			assertNotFailed();
			return stmt.get(...params);
		},
		all(...params: unknown[]): unknown[] {
			assertNotFailed();
			return stmt.all(...params);
		},
		run(...params: unknown[]): unknown {
			assertNotFailed();
			return stmt.run(...params);
		},
	});
	const guardedDb: SqliteDatabaseLike = {
		prepare(sql: string): SqliteStatementLike {
			assertNotFailed();
			const cached = statements.get(sql);
			if (cached) return cached;
			const stmt = wrapStatement(rawDb.prepare(sql) as unknown as SqliteStatementLike);
			statements.set(sql, stmt);
			return stmt;
		},
		exec(sql: string): unknown {
			assertNotFailed();
			return rawDb.exec(sql);
		},
		close(): void {
			statements.clear();
			rawDb.close();
		},
		transaction(fn: (...args: never[]) => unknown): SqliteTransactionLike {
			assertNotFailed();
			return guardTransaction(rawDb.transaction(fn) as SqliteTransactionLike, assertNotFailed);
		},
		loadExtension(path: string): void {
			assertNotFailed();
			rawDb.loadExtension(path);
		},
		markFailed(reason: string): void {
			failedReason = reason;
		},
		isFailed(): boolean {
			return failedReason !== undefined;
		},
		getFailureReason(): string | undefined {
			return failedReason;
		},
		clearFailedAfterVerifiedRecovery(): void {
			failedReason = undefined;
		},
		runRecoveryOperation<T>(operation: (raw: RawSqliteDatabase) => T): T {
			if (failedReason === undefined) {
				throw new Error("recovery access requires a latched storage handle");
			}
			return operation(rawDb);
		},
	};
	return { raw: guardedRaw, db: guardedDb };
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
