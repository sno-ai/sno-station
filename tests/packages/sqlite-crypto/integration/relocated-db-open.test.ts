/**
 * A store that is moved must still open. Its identity is the id it carries
 * inside itself, not where the file happens to sit — keying the manifest on the
 * absolute path meant a user who reorganised a directory, restored a backup, or
 * mounted the data elsewhere got "not registered in the manifest; refusing" for
 * a database whose contents were perfectly intact.
 *
 * The one case that must still fail is a DUPLICATE: the original still exists,
 * so two files claim one database and opening either would silently serve the
 * other's rows.
 */

import { mkdirSync, renameSync, copyFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
	DbIdMismatch,
	getDek,
	openEncryptedDb,
	openEncryptedDbReadonly,
} from "@snoai/sno-station-core-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv, uniqueDbPath } from "../_helpers.ts";

let env: TestEnv;

beforeEach(() => {
	env = makeTestEnv("relocate");
});

afterEach(() => {
	env.cleanup();
});

function seed(path: string, dek: Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	const db = openEncryptedDb(path, dek);
	db.exec("CREATE TABLE t (v TEXT)");
	db.prepare("INSERT INTO t (v) VALUES (?)").run("kept");
	db.close();
}

function readBack(path: string, dek: Buffer, readonly: boolean): string {
	const db = readonly
		? openEncryptedDbReadonly(path, dek)
		: openEncryptedDb(path, dek);
	try {
		return (db.prepare("SELECT v FROM t").get() as { v: string }).v;
	} finally {
		db.close();
	}
}

/** Move the database and every sidecar SQLite may have left beside it. */
function moveDb(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	for (const suffix of ["", "-wal", "-shm"]) {
		if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix);
	}
}

describe("a relocated database still opens", () => {
	it("opens read-write after the file is moved, and records the new location", async () => {
		const dek = await getDek();
		const from = uniqueDbPath(env, "move-rw");
		const to = uniqueDbPath(env, "move-rw-elsewhere");
		seed(from, dek);

		moveDb(from, to);

		expect(readBack(to, dek, false)).toBe("kept");
		// The move was recorded, so a later read-only open works too — and that
		// one cannot write the manifest itself.
		expect(readBack(to, dek, true)).toBe("kept");
	});

	it("opens read-only after the file is moved, without needing a writable open first", async () => {
		const dek = await getDek();
		const from = uniqueDbPath(env, "move-ro");
		const to = uniqueDbPath(env, "move-ro-elsewhere");
		seed(from, dek);

		moveDb(from, to);

		expect(readBack(to, dek, true)).toBe("kept");
	});

	it("still refuses a duplicate: the original is left in place", async () => {
		const dek = await getDek();
		const original = uniqueDbPath(env, "dup-original");
		const copy = uniqueDbPath(env, "dup-copy");
		seed(original, dek);
		mkdirSync(dirname(copy), { recursive: true });
		copyFileSync(original, copy);

		expect(() => openEncryptedDb(copy, dek)).toThrow(DbIdMismatch);
		expect(() => openEncryptedDbReadonly(copy, dek)).toThrow(DbIdMismatch);
		// The original is untouched by the refusal.
		expect(readBack(original, dek, false)).toBe("kept");
	});
});
