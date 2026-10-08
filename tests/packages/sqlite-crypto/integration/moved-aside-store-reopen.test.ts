/**
 * A store that was moved aside must not block a fresh one at the same path.
 *
 * Real case: a store that could not be read was renamed (with its -wal and -shm files) to
 * `memory.sqlite.unreadable-<time>`, the manifest still listed the original path, and the
 * next start found no file (or a 0-byte one) at that path. The open then threw
 * CANARY_MISMATCH ("manifest lists <path> but no canary row found"), the sidecar answered every
 * request with 500, and remember failed. The preserved old store is another file with its own
 * id; the empty path is simply a new store, opened with the same key.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dekFingerprint, openEncryptedDb } from "@snoai/sqlite-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childNodeArgs, makeTestEnv, type TestEnv, uniqueDbPath } from "../_helpers.ts";

let env: TestEnv;

beforeEach(() => {
	env = makeTestEnv("moved-aside");
});

afterEach(() => {
	env.cleanup();
});

function seedAndMoveAside(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	const db = openEncryptedDb(path, env.dek);
	db.exec("CREATE TABLE t (v TEXT)");
	db.prepare("INSERT INTO t (v) VALUES (?)").run("old");
	db.close();
	const aside = `${path}.unreadable-2026-10-03T18-46-14Z`;
	renameSync(path, aside);
	return aside;
}

describe("a store moved aside, then a fresh one at the same path", () => {
	for (const emptyFile of [false, true]) {
		it(`opens with the existing key when the path ${emptyFile ? "holds a 0-byte file" : "has no file"}, and keeps the old store untouched`, () => {
			const path = uniqueDbPath(env, "memory");
			const aside = seedAndMoveAside(path);
			const asideBefore = readFileSync(aside);
			if (emptyFile) writeFileSync(path, "");

			const fresh = openEncryptedDb(path, env.dek);
			fresh.exec("CREATE TABLE t (v TEXT)");
			fresh.prepare("INSERT INTO t (v) VALUES (?)").run("new");
			fresh.close();

			const reopened = openEncryptedDb(path, env.dek);
			expect((reopened.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("new");
			reopened.close();

			expect(existsSync(aside)).toBe(true);
			expect(readFileSync(aside).equals(asideBefore)).toBe(true);
		});
	}

	it("survives a crash between the new store's commit and the manifest write", () => {
		// The manifest lists a store that is gone from this path. A new store is registered here and the process
		// dies after the new canary is committed but before the manifest is written.
		const path = `${env.snoStationCoreConfigDir}/dbs/killer.db`;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			env.manifestFile,
			JSON.stringify({
				schemaVersion: 1,
				createdAt: new Date().toISOString(),
				dbs: [{ path, dbId: "aaaaaaaaaaaaaaaa", dekFingerprint: dekFingerprint(env.dek) }],
			}),
		);
		const killer = new URL("./fixtures/manifest-write-killer.mjs", import.meta.url).pathname;
		const run = spawnSync(process.execPath, [...childNodeArgs(killer), env.keyHex], {
			env: { ...process.env, SNO_STATION_CORE_CRASH_AFTER: "after-commit-before-manifest", SNO_STATION_CORE_DB_PATH: path },
			timeout: 30_000,
			encoding: "utf8",
		});
		expect(run.status !== 0 || run.signal !== null).toBe(true);

		// The next open must work: the committed new canary is adopted, not refused as another database's.
		expect(() => openEncryptedDb(path, env.dek).close()).not.toThrow();
	});

	it("still refuses a registered store whose canary was removed in place", () => {
		// The path was not moved: the same file lost its canary table. That is damage, not a new store.
		const path = uniqueDbPath(env, "damaged");
		mkdirSync(dirname(path), { recursive: true });
		const db = openEncryptedDb(path, env.dek);
		db.exec("CREATE TABLE t (v TEXT)");
		const canaryTable = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%canary%' AND type = 'table'").get() as { name: string } | undefined)?.name;
		expect(canaryTable).toBeDefined();
		db.exec(`DROP TABLE "${canaryTable}"`);
		db.close();
		expect(() => openEncryptedDb(path, env.dek)).toThrow(/canary/i);
	});
});
