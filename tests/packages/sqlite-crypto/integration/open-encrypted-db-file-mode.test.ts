import { chmodSync, statSync } from "node:fs";
import { getDek, openEncryptedDb } from "@snoai/sqlite-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv, uniqueDbPath } from "../_helpers.ts";

let env: TestEnv;
beforeEach(() => { env = makeTestEnv("file-mode"); });
afterEach(() => { env.cleanup(); });

describe("openEncryptedDb file mode", () => {
	it("creates the database and its -wal/-shm files owner-only", () => {
		const dbPath = uniqueDbPath(env, "mode");
		const db = openEncryptedDb(dbPath, getDek(env.keyHex));
		try {
			db.exec("PRAGMA journal_mode=WAL"); // the memory store enables WAL right after open
			db.exec("CREATE TABLE t (id INTEGER)");
			db.exec("INSERT INTO t VALUES (1)");
			for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
				expect(statSync(file).mode & 0o777, file).toBe(0o600);
			}
		} finally { db.close(); }
	});

	it("tightens -wal/-shm files left world-readable by an earlier version", () => {
		const dbPath = uniqueDbPath(env, "upgrade");
		const first = openEncryptedDb(dbPath, getDek(env.keyHex));
		try {
			first.exec("PRAGMA journal_mode=WAL");
			first.exec("CREATE TABLE t (id INTEGER)");
			first.exec("INSERT INTO t VALUES (1)");
			for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) chmodSync(file, 0o644);
			const second = openEncryptedDb(dbPath, getDek(env.keyHex));
			try {
				for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
					expect(statSync(file).mode & 0o777, file).toBe(0o600);
				}
			} finally { second.close(); }
		} finally { first.close(); }
	});
});
