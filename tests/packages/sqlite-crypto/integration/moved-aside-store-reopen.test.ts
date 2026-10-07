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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openEncryptedDb } from "@snoai/sqlite-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv, uniqueDbPath } from "../_helpers.ts";

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
