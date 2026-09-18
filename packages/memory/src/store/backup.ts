/** @file backup.ts
 * @purpose Exports, imports, and validates persisted memory data for backup workflows.
 * @boundary Memory store serialization, schema compatibility, and CLI operations.
 * @see store.ts, memory-management-cli.ts, schema.ts.
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import path from "node:path";
import { createLogger } from "@snoai/utils/logger";
import { BACKUP_INTERVAL_MS, BACKUP_MIN_FREE_DISK_RATIO, BACKUP_RETENTION_COUNT } from "../../config/index";
import { loadSqliteVecExtension } from "./sqlite-vec-path";
import { openSqliteDatabase } from "./sqlite-runtime";

const log = createLogger("sno-station-mem:backup");

const BACKUP_PREFIX = "sno-station-mem-";
const BACKUP_SUFFIX = ".sqlite";
const BACKUP_FILE_REGEX =
	/^sno-station-mem-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-p\d+-[a-z0-9]+\.sqlite$/;

/** Format `Date` as a unique UTC timestamp (colon-free for FS-safety). */
function formatBackupTimestamp(now: Date): string {
	const timestamp = now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
	return `${timestamp}-p${process.pid}-${process.hrtime.bigint().toString(36)}`;
}

/** Escapes a value for SQLite string-literal use in backup statements. */
function quoteSqliteStringLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Validates backup file placement before SQLite is allowed to write outside the state directory.
 */
function assertSafeBackupPath(stateDir: string, filePath: string): string {
	// Compute the normalized resolved state dir once so later persistence checks use one value.
	const resolvedStateDir = realpathSync(stateDir);
	// Compute the normalized resolved backup path once so later persistence checks use one value.
	const resolvedBackupPath = path.resolve(filePath);
	// Compute the normalized relative path once so later persistence checks use one value.
	const relativePath = path.relative(resolvedStateDir, resolvedBackupPath);

	if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		// Surface this invalid backup scheduling state as an explicit typed failure.
		throw new Error(`Backup path escapes configured state directory: ${filePath}`);
	}
	// Keep identity and boundary checks ahead of any privileged operation.
	if (!BACKUP_FILE_REGEX.test(path.basename(resolvedBackupPath))) {
		// Surface this invalid backup scheduling state as an explicit typed failure.
		throw new Error(`Unexpected backup filename: ${path.basename(resolvedBackupPath)}`);
	}

	// The resolved path is fed to VACUUM INTO as an escaped SQLite string literal
	// (quoteSqliteStringLiteral), so arbitrary path characters — spaces, backslashes,
	// quotes — are safe. Injection safety comes from that escaping plus the
	// containment and filename checks above, not from a character whitelist.
	return resolvedBackupPath;
}

/** Free and total bytes of the volume holding a directory. */
export interface DiskSpace {
	freeBytes: number;
	totalBytes: number;
}

export interface BackupOptions {
	/** Reads the volume's space; injectable because a test cannot fill a real disk. */
	readDiskSpace?: (dir: string) => DiskSpace;
}

/** Thrown when the volume cannot hold a backup even after old backups are removed. */
export class BackupSkippedLowDiskError extends Error {
	constructor(readonly neededBytes: number, readonly freeBytes: number, readonly reserveBytes: number) {
		super(`backup skipped: needs ${neededBytes} bytes above a ${reserveBytes}-byte reserve, ${freeBytes} free`);
		this.name = "BackupSkippedLowDiskError";
	}
}

function readVolumeSpace(dir: string): DiskSpace {
	const info = statfsSync(dir);
	return { freeBytes: info.bavail * info.bsize, totalBytes: info.blocks * info.bsize };
}

/** Backup file names in the directory, oldest first (names sort by their UTC timestamp). */
function listBackups(stateDir: string): string[] {
	return readdirSync(stateDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.startsWith(BACKUP_PREFIX) && entry.name.endsWith(BACKUP_SUFFIX))
		.map((entry) => entry.name)
		.sort();
}

function removeBackups(stateDir: string, names: string[], reason: string): void {
	for (const name of names) {
		rmSync(path.join(stateDir, name), { force: true });
	}
	if (names.length > 0) {
		log.debug("pruned old backups", { removed: names.length, reason }, {
			event_name: "sno_station_mem.backup.pruned.old.backups",
			file: "packages/sno-station-mem/src/store/backup.ts",
			function: "removeBackups",
			site_id: "backup.pruneOldBackups.1dca69b51b",
		});
	}
}

/**
 * Deletes the oldest backups until `neededBytes` fits above the volume's reserve. The newest backup
 * is never deleted here: a full disk must not cost the user their last good copy. Returns whether
 * the space now fits.
 */
function freeSpaceForBackup(stateDir: string, neededBytes: number, readDiskSpace: (dir: string) => DiskSpace): boolean {
	const backups = listBackups(stateDir);
	let space = readDiskSpace(stateDir);
	const reserve = space.totalBytes * BACKUP_MIN_FREE_DISK_RATIO;
	while (space.freeBytes - neededBytes < reserve && backups.length > 1) {
		const oldest = backups.shift();
		if (oldest === undefined) break;
		removeBackups(stateDir, [oldest], "low-disk");
		space = readDiskSpace(stateDir);
	}
	return space.freeBytes - neededBytes >= reserve;
}

/** Size a fresh copy of the store can reach: the main file plus its unmerged write-ahead log. */
function storeBytes(dbPath: string): number {
	const walPath = `${dbPath}-wal`;
	return statSync(dbPath).size + (existsSync(walPath) ? statSync(walPath).size : 0);
}

/**
 * Whether a backup is due: none exists yet, or the newest is at least BACKUP_INTERVAL_MS old.
 * Read from the files so a restart never takes an extra backup.
 */
export function isBackupDue(stateDir: string, now: number, intervalMs: number = BACKUP_INTERVAL_MS): boolean {
	if (!existsSync(stateDir)) return true;
	const newest = listBackups(stateDir).at(-1);
	if (newest === undefined) return true;
	return now - statSync(path.join(stateDir, newest)).mtimeMs >= intervalMs;
}

/** Implements run backup as the local SQLite backup scheduling operation. */
export function runBackup(dbPath: string, stateDir: string, options: BackupOptions = {}): string {
	// Compute the normalized normalized state dir once so later persistence checks use one value.
	const normalizedStateDir = stateDir.replaceAll("\\", path.sep);
	mkdirSync(normalizedStateDir, { recursive: true });

	// Compute the normalized resolved state dir once so later persistence checks use one value.
	const resolvedStateDir = realpathSync(normalizedStateDir);
	const fileName = `${BACKUP_PREFIX}${formatBackupTimestamp(new Date())}${BACKUP_SUFFIX}`;
	const backupPath = path.join(resolvedStateDir, fileName);
	// VACUUM INTO creates a consistent SQLite snapshot regardless of WAL mode.
	const safeBackupPath = assertSafeBackupPath(resolvedStateDir, backupPath);
	// VACUUM INTO is not atomic: a thrown error, or the process being killed
	// mid-write, can leave a partial/corrupt file at the destination. Write to
	// a `.tmp` path first and rename into place only on success, so a failed
	// attempt never matches BACKUP_FILE_REGEX and can never be mistaken for a
	// real backup by the retention count (host adversarial
	// review 2026-07-13).
	const tempBackupPath = `${safeBackupPath}.tmp`;
	const readDiskSpace = options.readDiskSpace ?? readVolumeSpace;
	const neededBytes = storeBytes(dbPath);
	// VACUUM INTO needs the whole copy's space before it writes, so make room first.
	if (!freeSpaceForBackup(resolvedStateDir, neededBytes, readDiskSpace)) {
		const space = readDiskSpace(resolvedStateDir);
		throw new BackupSkippedLowDiskError(neededBytes, space.freeBytes, space.totalBytes * BACKUP_MIN_FREE_DISK_RATIO);
	}
	const sqlite = openSqliteDatabase(dbPath, {
		readonly: true,
		fileMustExist: true,
	});
	loadSqliteVecExtension(sqlite.raw);
	try {
		sqlite.db.exec(`VACUUM INTO ${quoteSqliteStringLiteral(tempBackupPath)}`);
	} catch (error) {
		rmSync(tempBackupPath, { force: true });
		throw error;
	} finally {
		sqlite.db.close();
	}
	renameSync(tempBackupPath, safeBackupPath);

	const backups = listBackups(resolvedStateDir);
	removeBackups(resolvedStateDir, backups.slice(0, Math.max(0, backups.length - BACKUP_RETENTION_COUNT)), "retention");
	// Check again after writing: the copy can be larger than estimated, and other writers share the volume.
	freeSpaceForBackup(resolvedStateDir, 0, readDiskSpace);
	log.info("backup created", { backupPath: safeBackupPath }, {
		event_name: "sno_station_mem.backup.backup.created",
		file: "packages/sno-station-mem/src/store/backup.ts",
		function: "runBackup",
		site_id: "backup.runBackup.ca114973f1",
	});
	return safeBackupPath;
}
