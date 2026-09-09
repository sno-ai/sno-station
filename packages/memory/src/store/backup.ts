/** @file backup.ts
 * @purpose Exports, imports, and validates persisted memory data for backup workflows.
 * @boundary Memory store serialization, schema compatibility, and CLI operations.
 * @see store.ts, memory-management-cli.ts, schema.ts.
 */

import { mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { createLogger } from "@snoai/utils/logger";
import { BACKUP_RETENTION_COUNT } from "../../config/index";
import { loadSqliteVecExtension } from "./sqlite-vec-path";
import { openSqliteDatabase } from "./sqlite-runtime";

const log = createLogger("mem-claw:backup");

const BACKUP_PREFIX = "mem-claw-";
const BACKUP_SUFFIX = ".sqlite";
const BACKUP_FILE_REGEX =
	/^mem-claw-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-p\d+-[a-z0-9]+\.sqlite$/;

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

/** Filters old backups before it affects SQLite backup scheduling decisions. */
function pruneOldBackups(stateDir: string, keep: number): void {
	const backups = readdirSync(stateDir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.startsWith(BACKUP_PREFIX) &&
				entry.name.endsWith(BACKUP_SUFFIX),
		)
		.map((entry) => entry.name)
		.sort();

	const toRemove = backups.slice(0, Math.max(0, backups.length - keep));
	for (const name of toRemove) {
		// This persistence step establishes state that later reads and cleanup paths depend on.
		rmSync(path.join(stateDir, name), { force: true });
	}
	if (toRemove.length > 0) {
		log.debug("pruned old backups", { removed: toRemove.length, kept: keep }, {
			event_name: "mem_claw.backup.pruned.old.backups",
			file: "apps/mem-claw/src/storage/backup.ts",
			function: "pruneOldBackups",
			site_id: "backup.pruneOldBackups.1dca69b51b",
		});
	}
}

/** Implements run backup as the local SQLite backup scheduling operation. */
export function runBackup(dbPath: string, stateDir: string): string {
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
	// real backup by pruneOldBackups's retention count (codex adversarial
	// review 2026-07-13).
	const tempBackupPath = `${safeBackupPath}.tmp`;
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

	pruneOldBackups(resolvedStateDir, BACKUP_RETENTION_COUNT);
	log.info("backup created", { backupPath: safeBackupPath }, {
		event_name: "mem_claw.backup.backup.created",
		file: "apps/mem-claw/src/storage/backup.ts",
		function: "runBackup",
		site_id: "backup.runBackup.ca114973f1",
	});
	return safeBackupPath;
}
