import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBackup } from "../../../../packages/sno-station-mem/src/store/backup.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

describe("runBackup path safety", () => {
	it("creates backups inside the canonical state directory", () => {
		const testDb = createTestDb();
		const baseDir = join(testDb.dbPath, "..");
		const targetDir = join(baseDir, "backup-target");
		const symlinkDir = join(baseDir, "backup-link");

		try {
			mkdirSync(targetDir, { recursive: true });
			symlinkSync(targetDir, symlinkDir);

			const backupPath = runBackup(testDb.dbPath, symlinkDir);
			const nextBackupPath = runBackup(testDb.dbPath, symlinkDir);

			expect(backupPath.startsWith(targetDir)).toBe(true);
			expect(nextBackupPath.startsWith(targetDir)).toBe(true);
			expect(nextBackupPath).not.toBe(backupPath);
			expect(existsSync(backupPath)).toBe(true);
			expect(existsSync(nextBackupPath)).toBe(true);
		} finally {
			testDb.cleanup();
		}
	});

	it("safely backs up when the state directory name contains a single quote", () => {
		const testDb = createTestDb();
		const quotedDir = join(testDb.dbPath, "..", "backup'quote");

		try {
			mkdirSync(quotedDir, { recursive: true });

			const backupPath = runBackup(testDb.dbPath, quotedDir);

			expect(backupPath.startsWith(quotedDir)).toBe(true);
			expect(existsSync(backupPath)).toBe(true);
		} finally {
			testDb.cleanup();
		}
	});

	it("allows spaces in the backup state directory name", () => {
		const testDb = createTestDb();
		const spacedDir = join(testDb.dbPath, "..", "backup dir with spaces");

		try {
			mkdirSync(spacedDir, { recursive: true });

			const backupPath = runBackup(testDb.dbPath, spacedDir);

			expect(backupPath.startsWith(spacedDir)).toBe(true);
			expect(existsSync(backupPath)).toBe(true);
		} finally {
			testDb.cleanup();
		}
	});

	it("allows Windows-style backslashes in backup state directory names", () => {
		const testDb = createTestDb();
		const windowsishDir = join(testDb.dbPath, "..", "backup\\windows");

		try {
			mkdirSync(windowsishDir, { recursive: true });

			const backupPath = runBackup(testDb.dbPath, windowsishDir);
			const normalizedDir = windowsishDir.replaceAll("\\", "/");

			expect(backupPath.startsWith(normalizedDir)).toBe(true);
			expect(existsSync(backupPath)).toBe(true);
		} finally {
			testDb.cleanup();
		}
	});

	it("leaves no .tmp artifact after a successful backup", () => {
		const testDb = createTestDb();
		const targetDir = join(testDb.dbPath, "..", "backup-no-tmp");

		try {
			mkdirSync(targetDir, { recursive: true });
			const backupPath = runBackup(testDb.dbPath, targetDir);

			expect(existsSync(backupPath)).toBe(true);
			const stray = readdirSync(targetDir).filter((name) => name.endsWith(".tmp"));
			expect(stray).toEqual([]);
		} finally {
			testDb.cleanup();
		}
	});

	it("never counts a stray .tmp file (crash-interrupted VACUUM INTO) as a real backup", () => {
		// VACUUM INTO is not atomic — a process kill mid-write can leave a
		// partial file. runBackup writes to a `.tmp` path and renames on
		// success, so pruneOldBackups's suffix-filtered readdir must never see
		// (and therefore never evict a real backup in favor of) that leftover.
		const testDb = createTestDb();
		const targetDir = join(testDb.dbPath, "..", "backup-stray-tmp");

		try {
			mkdirSync(targetDir, { recursive: true });
			const strayTmpPath = join(targetDir, "mem-claw-crash-interrupted.sqlite.tmp");
			writeFileSync(strayTmpPath, "partial vacuum into output");

			const first = runBackup(testDb.dbPath, targetDir);
			const second = runBackup(testDb.dbPath, targetDir);

			expect(existsSync(strayTmpPath)).toBe(true);
			expect(existsSync(first)).toBe(true);
			expect(existsSync(second)).toBe(true);
		} finally {
			testDb.cleanup();
		}
	});
});
