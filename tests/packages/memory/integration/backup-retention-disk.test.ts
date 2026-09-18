/**
 * Backups are full copies of the store, so how many are kept and how much disk they may take is a
 * user-safety question. A 1.7 GB store kept hourly for 24 hours cost 40 GB and left a VM 94% full.
 *   1. Retention keeps at most BACKUP_RETENTION_COUNT files.
 *   2. Short on disk: the oldest backups go before the copy is written, the newest old one stays.
 *   3. No room even then: the backup is skipped and the last good copy survives.
 *   4. A backup is due only when the newest file is at least BACKUP_INTERVAL_MS old.
 * The volume reading is injected (a test cannot fill a real disk); the store and files are real.
 */

import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BACKUP_INTERVAL_MS,
	BACKUP_MIN_FREE_DISK_RATIO,
	BACKUP_RETENTION_COUNT,
} from "../../../../packages/sno-station-mem/config/index.ts";
import {
	BackupSkippedLowDiskError,
	isBackupDue,
	runBackup,
	type DiskSpace,
} from "../../../../packages/sno-station-mem/src/store/backup.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const MB = 1024 * 1024;
const TOTAL_BYTES = 100 * MB;
const RESERVE_BYTES = TOTAL_BYTES * BACKUP_MIN_FREE_DISK_RATIO;

function seedOldBackups(dir: string, count: number, bytes: number): string[] {
	mkdirSync(dir, { recursive: true });
	const names = Array.from({ length: count }, (_, day) =>
		`sno-station-mem-2026-01-${String(day + 1).padStart(2, "0")}T00-00-00-000-p1-seed.sqlite`);
	for (const name of names) writeFileSync(join(dir, name), Buffer.alloc(bytes));
	return names;
}

/** A volume whose free space is `baseFreeBytes` minus whatever the backup directory holds. */
function volume(dir: string, baseFreeBytes: number): (target: string) => DiskSpace {
	return () => {
		const used = readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
		return { freeBytes: baseFreeBytes - used, totalBytes: TOTAL_BYTES };
	};
}

function storeBytes(dbPath: string): number {
	const wal = `${dbPath}-wal`;
	return statSync(dbPath).size + (existsSync(wal) ? statSync(wal).size : 0);
}

describe("backup retention and disk space", () => {
	it("keeps at most BACKUP_RETENTION_COUNT backups, newest first", () => {
		const testDb = createTestDb();
		const dir = join(testDb.dbPath, "..", "backups-retention");
		try {
			const seeded = seedOldBackups(dir, BACKUP_RETENTION_COUNT + 2, 16);
			const backupPath = runBackup(testDb.dbPath, dir, { readDiskSpace: volume(dir, TOTAL_BYTES) });

			expect(readdirSync(dir).sort()).toEqual([
				...seeded.slice(-(BACKUP_RETENTION_COUNT - 1)),
				backupPath.split("/").at(-1),
			]);
		} finally {
			testDb.cleanup();
		}
	});

	it("deletes the oldest backups before writing when the copy would cross the reserve", () => {
		const testDb = createTestDb();
		const dir = join(testDb.dbPath, "..", "backups-low-disk");
		try {
			const seeded = seedOldBackups(dir, 5, MB);
			// Room for the new copy plus exactly three of the five old backups.
			const baseFree = RESERVE_BYTES + storeBytes(testDb.dbPath) + 3 * MB + 1;
			const read = volume(dir, baseFree);
			// Every space reading notes whether the copy already existed while the two oldest were still there.
			let copiedBeforePrune = false;
			const backupPath = runBackup(testDb.dbPath, dir, { readDiskSpace: (target) => {
				const names = readdirSync(dir);
				if (names.some((name) => !seeded.includes(name)) && names.includes(seeded[1] ?? "")) copiedBeforePrune = true;
				return read(target);
			} });

			expect(copiedBeforePrune).toBe(false);
			expect(readdirSync(dir).sort()).toEqual([...seeded.slice(2), backupPath.split("/").at(-1)]);
		} finally {
			testDb.cleanup();
		}
	});

	it("skips the backup and keeps the newest old copy when nothing frees enough space", () => {
		const testDb = createTestDb();
		const dir = join(testDb.dbPath, "..", "backups-no-room");
		try {
			const seeded = seedOldBackups(dir, 3, MB);
			const baseFree = RESERVE_BYTES + storeBytes(testDb.dbPath) - 1;

			expect(() => runBackup(testDb.dbPath, dir, { readDiskSpace: volume(dir, baseFree) }))
				.toThrow(BackupSkippedLowDiskError);
			expect(readdirSync(dir)).toEqual([seeded.at(-1)]);
		} finally {
			testDb.cleanup();
		}
	});

	it("is due with no backup, not due right after one, and due again once the newest is old", () => {
		const testDb = createTestDb();
		const dir = join(testDb.dbPath, "..", "backups-due");
		try {
			expect(isBackupDue(dir, Date.now())).toBe(true);
			// An old backup alongside the new one: only the newest may decide.
			const [oldest] = seedOldBackups(dir, 1, 16);
			const longAgo = (Date.now() - 10 * BACKUP_INTERVAL_MS) / 1000;
			utimesSync(join(dir, oldest ?? ""), longAgo, longAgo);
			expect(isBackupDue(dir, Date.now())).toBe(true);
			const backupPath = runBackup(testDb.dbPath, dir, { readDiskSpace: volume(dir, TOTAL_BYTES) });
			expect(isBackupDue(dir, Date.now())).toBe(false);

			const old = (Date.now() - BACKUP_INTERVAL_MS - 1000) / 1000;
			utimesSync(backupPath, old, old);
			expect(isBackupDue(dir, Date.now())).toBe(true);
		} finally {
			testDb.cleanup();
		}
	});
});
