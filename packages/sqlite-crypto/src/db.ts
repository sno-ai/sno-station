import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import type SqliteDatabase from "better-sqlite3";
import { resolveConfigPaths } from "./config.js";
import {
	CanaryMismatch,
	DbIdMismatch,
	IntegrityCheckFailed,
	ManifestMissing,
	WrongKeyError,
} from "./errors.js";
import { crashAfter } from "./fault-injection.js";
import {
	appendEntry,
	emptyManifest,
	ensureMarker,
	findEntry,
	readManifestIfPresent,
	withEntryPath,
} from "./manifest.js";
import {
	CANARY_SENTINEL,
	CANARY_TABLE,
	type DbId,
	type Dek,
	type DekFingerprint,
	type ManifestEntry,
	type ManifestFile,
} from "./types.js";
import { dekFingerprint } from "./wrap.js";

// The encrypted driver's exports hide its declarations; its database API uses the SQLite types.
const Database = createRequire(import.meta.url)(
	"better-sqlite3-multiple-ciphers",
) as typeof SqliteDatabase;
type Db = SqliteDatabase.Database;

interface PreflightedDb {
	db: Db;
	canaryRow: { sentinel: string; db_id: string } | undefined;
}

const SQLITE_PLAINTEXT_HEADER = Buffer.from("SQLite format 3\0", "binary");

function normalizeDbPath(path: string): string {
	return resolvePath(path);
}

function isErrnoException(err: unknown): err is Error & { code?: string } {
	return err instanceof Error && "code" in err;
}

function isWrongKeySqliteError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return /file is not a database|file is encrypted|malformed/i.test(
		err.message,
	);
}

function assertNotPlaintextSqlite(path: string): void {
	let fd: number | undefined;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size < SQLITE_PLAINTEXT_HEADER.length) return;
		fd = openSync(path, "r");
		const header = Buffer.alloc(SQLITE_PLAINTEXT_HEADER.length);
		const bytes = readSync(fd, header, 0, header.length, 0);
		if (bytes === header.length && header.equals(SQLITE_PLAINTEXT_HEADER)) {
			throw new IntegrityCheckFailed(
				`PlaintextDbRejected: ${path} is a plaintext SQLite database; remove it before encrypted open`,
			);
		}
	} catch (err) {
		if (isErrnoException(err) && err.code === "ENOENT") return;
		throw err;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function applyPragmaRecipe(db: Db, dek: Dek): void {
	// 1. Select cipher (overrides the chacha20 default).
	db.pragma("cipher = 'sqlcipher'");
	// 2. Select SQLCipher v4 layout.
	db.pragma("cipher_compatibility = 4");
	// 3. Set the raw 256-bit key (skips SQLCipher's internal PBKDF2).
	db.pragma(`key = "x'${dek.toString("hex")}'"`);
	// 4. Smoke assertion — multi-ciphers default is `chacha20`. Reading any
	//    internal state with a wrong DEK fails with "file is not a database"
	//    once SQLCipher attempts to decrypt the header.
	//
	// NOTE: earlier versions also ran `PRAGMA cipher_integrity_check` here,
	// believing it swept every page. On SQLite3MultipleCiphers that pragma is a
	// SILENT NO-OP (returns an empty rowset instantly — the driver implements
	// the SQLCipher FORMAT, not SQLCipher-specific pragmas), so the intended
	// verification never ran anywhere. The working full sweep is
	// runIntegrityCheck() below; callers schedule it out-of-band (e.g. an hourly
	// maintenance pass) because it reads every page. Per-page HMACs are still
	// verified on EVERY page read by the codec itself, so a damaged page can
	// never be silently served regardless of sweep cadence.
	try {
		const cipher = db.pragma("cipher", { simple: true }) as string;
		if (cipher !== "sqlcipher") {
			throw new WrongKeyError(
				`WrongKeyError: PRAGMA cipher returned ${cipher}, expected sqlcipher`,
			);
		}
	} catch (err) {
		if (err instanceof WrongKeyError) throw err;
		if (isWrongKeySqliteError(err)) {
			throw new WrongKeyError(
				"WrongKeyError: failed to decrypt SQLCipher header (incorrect DEK or tampered file)",
				{ cause: err },
			);
		}
		throw err;
	}
}

/**
 * Full-database integrity sweep. `PRAGMA integrity_check` reads every page
 * through the encrypted codec, so each page's HMAC is verified as a side
 * effect — this is the working replacement for the intended (but no-op)
 * `cipher_integrity_check`. O(database size); run it from maintenance
 * schedules, never on the open path.
 *
 * Throws IntegrityCheckFailed unless the result is exactly `ok`.
 */
export function runIntegrityCheck(db: Db): void {
	let rows: Array<Record<string, unknown>>;
	try {
		rows = db.pragma("integrity_check") as Array<Record<string, unknown>>;
	} catch (err) {
		throw new IntegrityCheckFailed(
			`IntegrityCheckFailed: integrity_check could not run: ${(err as Error).message}`,
			{ cause: err },
		);
	}
	const messages = rows
		.map((r) => r["integrity_check"])
		.filter((v): v is string => typeof v === "string");
	if (messages.length !== 1 || messages[0] !== "ok") {
		throw new IntegrityCheckFailed(
			`IntegrityCheckFailed: integrity_check reported: ${messages.slice(0, 3).join("; ") || "no result"}`,
		);
	}
}

function probeCanaryRow(
	db: Db,
): { sentinel: string; db_id: string } | undefined {
	let tables: Array<{ name: string }>;
	try {
		tables = db
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
			.all(CANARY_TABLE) as Array<{ name: string }>;
	} catch (err) {
		if (isWrongKeySqliteError(err)) {
			throw new WrongKeyError(
				"WrongKeyError: failed to read sqlite_master (incorrect DEK or tampered file)",
				{ cause: err },
			);
		}
		throw err;
	}
	if (tables.length === 0) return undefined;
	try {
		const row = db
			.prepare(`SELECT sentinel, db_id FROM ${CANARY_TABLE} WHERE id = 1`)
			.get() as { sentinel: string; db_id: string } | undefined;
		return row ?? undefined;
	} catch (err) {
		throw new IntegrityCheckFailed(
			`IntegrityCheckFailed: canary read failed: ${(err as Error).message}`,
			{ cause: err },
		);
	}
}

function preflight(path: string, dek: Dek, readonly = false): PreflightedDb {
	let db: Db;
	try {
		assertNotPlaintextSqlite(path);
		mkdirSync(dirname(path), { recursive: true });
		db = new Database(
			path,
			readonly ? { readonly: true, fileMustExist: true } : {},
		);
	} catch (err) {
		// In readonly mode `fileMustExist` will throw on a missing file → surface
		// as CanaryMismatch (read-only consumer cannot create).
		if (readonly) {
			throw new WrongKeyError(
				`cannot open ${path} read-only: ${(err as Error).message}`,
			);
		}
		throw err;
	}
	try {
		applyPragmaRecipe(db, dek);
	} catch (err) {
		try {
			db.close();
		} catch {
			// ignore
		}
		throw err;
	}
	let canaryRow: { sentinel: string; db_id: string } | undefined;
	try {
		canaryRow = probeCanaryRow(db);
	} catch (err) {
		try {
			db.close();
		} catch {
			// ignore
		}
		throw err;
	}
	return { db, canaryRow };
}

function ensureFingerprintMatch(entry: ManifestEntry, dek: Dek): void {
	const fp = dekFingerprint(dek) as DekFingerprint;
	if (entry.dekFingerprint !== fp) {
		throw new WrongKeyError(
			`DEK fingerprint mismatch for ${entry.path} (expected ${entry.dekFingerprint})`,
		);
	}
}

function assertSentinel(
	row: { sentinel: string; db_id: string },
	dbPath: string,
): void {
	if (row.sentinel !== CANARY_SENTINEL) {
		throw new CanaryMismatch(
			`CanaryMismatch: sentinel mismatch for ${dbPath}; expected '${CANARY_SENTINEL}'`,
		);
	}
}

/**
 * Decide whether this file at this path IS the database the entry describes.
 *
 * The id inside the file already settled identity, so a differing path means
 * one of two things, and they are not the same event:
 *
 *  - the database MOVED — nothing remains at the recorded location, and this is
 *    an ordinary relocation the caller is entitled to;
 *  - the database was DUPLICATED — the recorded location still holds a file, so
 *    two files now claim one id and opening either one silently serves the
 *    other's contents.
 *
 * Only the second is an error, and the surviving file is the whole evidence.
 */
function readCanaryDbId(path: string, dek: Dek): string | undefined {
	let candidate: PreflightedDb | undefined;
	try {
		candidate = preflight(path, dek, true);
		return candidate.canaryRow?.db_id;
	} finally {
		try {
			candidate?.db.close();
		} catch {
			// ignore
		}
	}
}

function assertNotDuplicate(entry: ManifestEntry, dbPath: string, dek: Dek): void {
	if (entry.path === dbPath) return;
	if (existsSync(entry.path) && readCanaryDbId(entry.path, dek) === entry.dbId) {
		throw new DbIdMismatch(
			`DbIdMismatch: db ${entry.dbId} is registered at ${entry.path}, which still exists; ${dbPath} is a second copy claiming the same database`,
		);
	}
}

function assertDestinationNotRegistered(
	manifest: ManifestFile,
	entry: ManifestEntry,
	dbPath: string,
): void {
	if (
		manifest.dbs.some(
			(candidate) => candidate.path === dbPath && candidate.dbId !== entry.dbId,
		)
	) {
		throw new DbIdMismatch(
			`DbIdMismatch: ${dbPath} is registered to a different database id`,
		);
	}
}

function syncAtomicWriteManifest(next: ManifestFile): void {
	const { manifestFile, configDir } = resolveConfigPaths();
	const tmp = `${manifestFile}.tmp-${process.pid}-${Date.now().toString(36)}`;
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	// fsync the tmp file before rename so the directory entry installed by
	// rename can never point at unflushed pages on a power loss.
	const tmpFd = openSync(tmp, "w", 0o644);
	try {
		const payload = Buffer.from(JSON.stringify(next), "utf8");
		let written = 0;
		while (written < payload.length) {
			const n = writeSync(
				tmpFd,
				payload,
				written,
				payload.length - written,
				written,
			);
			if (n <= 0) {
				throw new Error(
					`writeSync returned ${n} for ${tmp} after ${written}/${payload.length} bytes`,
				);
			}
			written += n;
		}
		fsyncSync(tmpFd);
	} finally {
		closeSync(tmpFd);
	}
	crashAfter("during-manifest-rename");
	renameSync(tmp, manifestFile);
	const dirFd = openSync(configDir, 0);
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

function registerFreshDbSync(
	path: string,
	dek: Dek,
	manifest: ManifestFile,
	pre: PreflightedDb,
): DbId {
	const dbPath = normalizeDbPath(path);
	const dbId = randomBytes(8).toString("hex") as DbId;
	const fp = dekFingerprint(dek) as DekFingerprint;
	crashAfter("before-marker");
	ensureMarker();
	pre.db.exec("BEGIN");
	pre.db.exec(
		`CREATE TABLE IF NOT EXISTS ${CANARY_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), sentinel TEXT NOT NULL, db_id TEXT NOT NULL)`,
	);
	pre.db
		.prepare(
			`INSERT OR REPLACE INTO ${CANARY_TABLE} (id, sentinel, db_id) VALUES (1, ?, ?)`,
		)
		.run(CANARY_SENTINEL, dbId);
	const next = appendEntry(manifest, {
		path: dbPath,
		dbId,
		dekFingerprint: fp,
	});
	try {
		pre.db.exec("COMMIT");
	} catch (err) {
		try {
			pre.db.exec("ROLLBACK");
		} catch {
			// ignore
		}
		throw err;
	}
	crashAfter("after-commit-before-manifest");
	syncAtomicWriteManifest(next);
	const row = pre.db
		.prepare(`SELECT sentinel, db_id FROM ${CANARY_TABLE} WHERE id = 1`)
		.get() as { sentinel: string; db_id: string } | undefined;
	if (!row || row.sentinel !== CANARY_SENTINEL || row.db_id !== dbId) {
		throw new CanaryMismatch(
			`canary verify failed after fresh-DB registration for ${dbPath}`,
		);
	}
	return dbId;
}

/**
 * Recovery-only: open the DB with the DEK and return the canary row (or
 * undefined if the canary table is absent) WITHOUT consulting the manifest.
 * Internal use by `sno-station-core lock --rebuild-manifest`. The returned db handle is
 * already closed.
 */
export function _readCanaryForRecovery(
	path: string,
	dek: Dek,
): { sentinel: string; db_id: string } | undefined {
	const pre = preflight(path, dek, true);
	try {
		return pre.canaryRow;
	} finally {
		try {
			pre.db.close();
		} catch {
			// ignore
		}
	}
}

export function openEncryptedDb(path: string, dek: Dek): Db {
	const dbPath = normalizeDbPath(path);
	const manifest = readManifestIfPresent() ?? emptyManifest();
	const pre = preflight(dbPath, dek, false);
	try {
		const canaryRow = pre.canaryRow;
		if (!canaryRow) {
			// No canary: either a brand-new file, or a registered database whose
			// canary table is gone. Re-registering the second would mint a second id
			// for one database, so the recorded location is checked before trusting
			// "new" — that check is diagnostic, not identity.
			if (manifest.dbs.some((d) => d.path === dbPath)) {
				throw new CanaryMismatch(
					`manifest lists ${dbPath} but no canary row found; recovery: sno-station-core lock --rebuild-manifest`,
				);
			}
			registerFreshDbSync(dbPath, dek, manifest, pre);
			return pre.db;
		}
		assertSentinel(canaryRow, dbPath);
		const entry = findEntry(manifest, canaryRow.db_id);
		if (!entry) {
			if (manifest.dbs.some((candidate) => candidate.path === dbPath)) {
				throw new DbIdMismatch(
					`DbIdMismatch: ${dbPath} is registered to a different database id`,
				);
			}
			// Known database, unknown to this manifest — adopt it.
			ensureMarker();
			syncAtomicWriteManifest(
				appendEntry(manifest, {
					path: dbPath,
					dbId: canaryRow.db_id as DbId,
					dekFingerprint: dekFingerprint(dek) as DekFingerprint,
				}),
			);
			return pre.db;
		}
		ensureFingerprintMatch(entry, dek);
		assertDestinationNotRegistered(manifest, entry, dbPath);
		assertNotDuplicate(entry, dbPath, dek);
		if (entry.path !== dbPath) {
			// It moved. Record where it lives now so the entry stays useful.
			syncAtomicWriteManifest(withEntryPath(manifest, entry.dbId, dbPath));
		}
		return pre.db;
	} catch (err) {
		try {
			pre.db.close();
		} catch {
			// ignore
		}
		throw err;
	}
}

export function openEncryptedDbReadonly(path: string, dek: Dek): Db {
	const dbPath = normalizeDbPath(path);
	const manifest = readManifestIfPresent();
	if (!manifest) {
		throw new ManifestMissing(
			`read-only open of ${dbPath} requires a manifest; none found`,
		);
	}
	// Open first: the database states its own id, and that is what the manifest
	// is searched by. A wrong DEK still fails here, before any lookup.
	const pre = preflight(dbPath, dek, true);
	try {
		const canaryRow = pre.canaryRow;
		if (!canaryRow) {
			throw new CanaryMismatch(
				`read-only open of ${dbPath}: no canary row present`,
			);
		}
		assertSentinel(canaryRow, dbPath);
		const entry = findEntry(manifest, canaryRow.db_id);
		if (!entry) {
			throw new ManifestMissing(
				`db ${canaryRow.db_id} at ${dbPath} is not registered in the manifest; refusing read-only open`,
			);
		}
		ensureFingerprintMatch(entry, dek);
		assertDestinationNotRegistered(manifest, entry, dbPath);
		assertNotDuplicate(entry, dbPath, dek);
		if (entry.path !== dbPath) {
			// The database handle stays read-only. The external manifest claims the
			// first observed location so a later copy is rejected as a duplicate.
			syncAtomicWriteManifest(withEntryPath(manifest, entry.dbId, dbPath));
		}
		return pre.db;
	} catch (err) {
		try {
			pre.db.close();
		} catch {
			// ignore
		}
		throw err;
	}
}
