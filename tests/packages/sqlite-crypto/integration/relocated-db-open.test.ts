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

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	DbIdMismatch,
	type Dek,
	getDek,
	openEncryptedDb,
	openEncryptedDbReadonly,
	WrongKeyError,
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

function seed(path: string, dek: Dek): void {
	mkdirSync(dirname(path), { recursive: true });
	const db = openEncryptedDb(path, dek);
	db.exec("CREATE TABLE t (v TEXT)");
	db.prepare("INSERT INTO t (v) VALUES (?)").run("kept");
	db.close();
}

function readBack(path: string, dek: Dek, readonly: boolean): string {
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

	it("records a moved path during read-only access before rejecting later copies", async () => {
		const dek = await getDek();
		const from = uniqueDbPath(env, "move-ro");
		const to = uniqueDbPath(env, "move-ro-elsewhere");
		const secondCopy = uniqueDbPath(env, "move-ro-second-copy");
		seed(from, dek);

		moveDb(from, to);

		expect(readBack(to, dek, true)).toBe("kept");
		const manifest = JSON.parse(readFileSync(env.manifestFile, "utf8")) as {
			dbs: Array<{ path: string }>;
		};
		expect(manifest.dbs).toContainEqual(expect.objectContaining({ path: to }));

		mkdirSync(dirname(secondCopy), { recursive: true });
		copyFileSync(to, secondCopy);
		expect(() => readBack(secondCopy, dek, true)).toThrow(DbIdMismatch);
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

	it.each([
		["read-write", openEncryptedDb],
		["read-only", openEncryptedDbReadonly],
	] as const)(
		"fails closed during %s access when the registered database cannot be inspected",
		async (_mode, open) => {
			const dek = await getDek();
			const original = uniqueDbPath(env, "unreadable-original");
			const copy = uniqueDbPath(env, "unreadable-copy");
			seed(original, dek);
			mkdirSync(dirname(copy), { recursive: true });
			copyFileSync(original, copy);
			const registeredManifest = readFileSync(env.manifestFile, "utf8");

			chmodSync(original, 0o000);
			try {
				expect(() => open(copy, dek)).toThrow(WrongKeyError);
				expect(readFileSync(env.manifestFile, "utf8")).toBe(registeredManifest);
			} finally {
				chmodSync(original, 0o600);
			}

			expect(readBack(original, dek, false)).toBe("kept");
		},
	);

	it("ignores an empty stub left at the recorded path", async () => {
		const dek = await getDek();
		const original = uniqueDbPath(env, "stub-original");
		const moved = uniqueDbPath(env, "stub-moved");
		seed(original, dek);
		moveDb(original, moved);
		writeFileSync(original, "");

		expect(readBack(moved, dek, false)).toBe("kept");
		expect(readBack(moved, dek, true)).toBe("kept");
	});

	it("refuses a different database placed at an already-registered path", async () => {
		const dek = await getDek();
		const registered = uniqueDbPath(env, "registered");
		const foreign = uniqueDbPath(env, "foreign");
		seed(registered, dek);
		const registeredManifest = readFileSync(env.manifestFile, "utf8");

		rmSync(env.manifestFile);
		seed(foreign, dek);
		copyFileSync(foreign, registered);
		writeFileSync(env.manifestFile, registeredManifest);

		expect(() => openEncryptedDb(registered, dek)).toThrow(DbIdMismatch);
		expect(readFileSync(env.manifestFile, "utf8")).toBe(registeredManifest);
	});

	it("refuses a known database moved onto another database's registered path", async () => {
		const dek = await getDek();
		const databaseA = uniqueDbPath(env, "known-a");
		const databaseB = uniqueDbPath(env, "known-b");
		seed(databaseA, dek);
		seed(databaseB, dek);
		const registeredManifest = readFileSync(env.manifestFile, "utf8");

		moveDb(databaseA, databaseB);

		expect(() => openEncryptedDb(databaseB, dek)).toThrow(DbIdMismatch);
		expect(() => openEncryptedDbReadonly(databaseB, dek)).toThrow(DbIdMismatch);
		expect(readFileSync(env.manifestFile, "utf8")).toBe(registeredManifest);
	});
});
