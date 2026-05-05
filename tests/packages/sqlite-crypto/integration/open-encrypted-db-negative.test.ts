/**
 * Tasks 2.5 + 2.6 — wrong DEK / tampered file / cipher selection / cross-DB
 * path mixup. Negative paths must throw typed errors and never return rows.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	CanaryMismatch,
	DbIdMismatch,
	type Dek,
	getDek,
	IntegrityCheckFailed,
	openEncryptedDb,
	openEncryptedDbReadonly,
	WrongKeyError,
} from "@snoai/nodix-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv, uniqueDbPath } from "../_helpers.ts";

let env: TestEnv;

beforeEach(() => {
	env = makeTestEnv("neg");
});

afterEach(() => {
	env.cleanup();
});

function flipOneByte(path: string, offset = 4096): void {
	const buf = readFileSync(path);
	if (offset >= buf.length) {
		// fall back to a byte deep into the data area
		offset = Math.floor(buf.length / 2);
	}
	const cur = buf[offset];
	if (cur === undefined)
		throw new Error(`offset ${offset} out of bounds in ${path}`);
	buf[offset] = cur ^ 0xff;
	writeFileSync(path, buf);
}

describe("openEncryptedDb — wrong DEK", () => {
	it("rejects with WrongKeyError or CanaryMismatch on a different DEK", async () => {
		const dek = await getDek();
		const dbPath = uniqueDbPath(env, "wrong");
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = openEncryptedDb(dbPath, dek);
		db.exec("CREATE TABLE t (v TEXT)");
		db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
		db.close();

		const wrongDek = randomBytes(32) as Dek;
		expect(() => openEncryptedDb(dbPath, wrongDek)).toThrow(/WrongKey|Canary/);
		try {
			openEncryptedDb(dbPath, wrongDek);
		} catch (e) {
			expect(
				e instanceof WrongKeyError ||
					e instanceof CanaryMismatch ||
					e instanceof IntegrityCheckFailed,
			).toBe(true);
		}
	});
});

describe("openEncryptedDb — tampered file", () => {
	it("throws IntegrityCheckFailed on byte flip in the encrypted page area", async () => {
		const dek = await getDek();
		const dbPath = uniqueDbPath(env, "tamper");
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = openEncryptedDb(dbPath, dek);
		db.exec("CREATE TABLE t (v TEXT)");
		const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
		for (let i = 0; i < 100; i++) ins.run(`val-${i}`);
		db.close();

		flipOneByte(dbPath, 4500);
		expect(() => openEncryptedDb(dbPath, dek)).toThrow();
		try {
			openEncryptedDb(dbPath, dek);
		} catch (e) {
			expect(
				e instanceof IntegrityCheckFailed || e instanceof WrongKeyError,
			).toBe(true);
		}
	});
});

describe("openEncryptedDb — cipher selection enforcement", () => {
	it("PRAGMA cipher returns 'sqlcipher' (not the chacha20 default)", async () => {
		const dek = await getDek();
		const dbPath = uniqueDbPath(env, "cipher");
		mkdirSync(dirname(dbPath), { recursive: true });
		const db = openEncryptedDb(dbPath, dek);
		const cipher = db.pragma("cipher", { simple: true }) as string;
		expect(cipher).toBe("sqlcipher");
		db.close();
	});
});

describe("openEncryptedDb — path normalization", () => {
	it("stores normalized manifest paths and reopens equivalent paths", async () => {
		const dek = await getDek();
		const dbPath = uniqueDbPath(env, "normalized");
		const dbsDir = dirname(dbPath);
		const equivalentPath = join(
			dbsDir,
			"..",
			basename(dbsDir),
			basename(dbPath),
		);
		mkdirSync(dbsDir, { recursive: true });

		const db = openEncryptedDb(equivalentPath, dek);
		db.exec("CREATE TABLE t (v TEXT)");
		db.prepare("INSERT INTO t (v) VALUES ('ok')").run();
		db.close();

		const manifest = JSON.parse(readFileSync(env.manifestFile, "utf8")) as {
			dbs: Array<{ path: string }>;
		};
		expect(manifest.dbs).toHaveLength(1);
		expect(manifest.dbs[0]?.path).toBe(resolve(equivalentPath));

		const writable = openEncryptedDb(dbPath, dek);
		expect(writable.prepare("SELECT v FROM t").pluck().get()).toBe("ok");
		writable.close();

		const readonly = openEncryptedDbReadonly(equivalentPath, dek);
		expect(readonly.prepare("SELECT v FROM t").pluck().get()).toBe("ok");
		readonly.close();
	});
});

describe("openEncryptedDb — cross-DB path mixup (task 2.6)", () => {
	it("DB-A bytes copied onto DB-B's path → DbIdMismatch (single shared DEK)", async () => {
		const dek = await getDek();
		const pathA = uniqueDbPath(env, "A");
		const pathB = uniqueDbPath(env, "B");
		mkdirSync(dirname(pathA), { recursive: true });

		// Create A and B legitimately under the same DEK.
		const a = openEncryptedDb(pathA, dek);
		a.exec("CREATE TABLE t (v TEXT)");
		a.prepare("INSERT INTO t (v) VALUES ('A')").run();
		a.close();

		const b = openEncryptedDb(pathB, dek);
		b.exec("CREATE TABLE t (v TEXT)");
		b.prepare("INSERT INTO t (v) VALUES ('B')").run();
		b.close();

		// Force a path mixup: copy A's encrypted file onto B's path.
		copyFileSync(pathA, pathB);

		expect(() => openEncryptedDb(pathB, dek)).toThrow(
			/DbIdMismatch|Canary|WrongKey/,
		);
		try {
			openEncryptedDb(pathB, dek);
		} catch (e) {
			expect(
				e instanceof DbIdMismatch ||
					e instanceof CanaryMismatch ||
					e instanceof WrongKeyError,
			).toBe(true);
		}
	});
});

// silence-unused for closeSync/openSync helper imports retained for future tests
void openSync;
void closeSync;
