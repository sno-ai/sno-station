/**
 * Task 2.4 — round-trip 100k mixed rows through openEncryptedDb. Real DEK,
 * real better-sqlite3-multiple-ciphers, real disk file. Byte-equal assertion
 * across close-and-reopen.
 *
 * Implementation note: 100k rows kept under 60s by using a single transaction
 * + prepared statements. 120s vitest timeout still applies.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDek, openEncryptedDb } from "@snoai/sqlite-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv, uniqueDbPath } from "../_helpers.ts";

let env: TestEnv;

beforeEach(() => {
	env = makeTestEnv("roundtrip");
});

afterEach(() => {
	env.cleanup();
});

describe("openEncryptedDb — round-trip with mixed payloads", () => {
	it("100k mixed rows survive close-reopen byte-equal", async () => {
		const dek = getDek(env.keyHex);
		const dbPath = uniqueDbPath(env, "rt");
		mkdirSync(dirname(dbPath), { recursive: true });

		const N = 100_000;
		const rows: Array<[number, string, Buffer, string]> = [];
		for (let i = 0; i < N; i++) {
			const text = `row-${i}-emoji-😀-${"中文".repeat((i % 4) + 1)}`;
			const blob = Buffer.from(`blob-${i}`, "utf8");
			const json = JSON.stringify({ i, name: `n${i}`, k: i % 7 });
			rows.push([i, text, blob, json]);
		}

		// Write phase
		{
			const db = openEncryptedDb(dbPath, dek);
			db.exec(
				"CREATE TABLE t (id INTEGER PRIMARY KEY, text TEXT, blob BLOB, json TEXT)",
			);
			const ins = db.prepare(
				"INSERT INTO t (id, text, blob, json) VALUES (?, ?, ?, ?)",
			);
			const tx = db.transaction((items: typeof rows) => {
				for (const r of items) ins.run(r[0], r[1], r[2], r[3]);
			});
			tx(rows);
			db.close();
		}

		// Read phase
		const db2 = openEncryptedDb(dbPath, dek);
		const out = db2
			.prepare("SELECT id, text, blob, json FROM t ORDER BY id")
			.all() as Array<{ id: number; text: string; blob: Buffer; json: string }>;
		expect(out.length).toBe(N);
		for (let i = 0; i < N; i++) {
			const row = out[i];
			const expected = rows[i];
			if (!row || !expected) throw new Error(`row ${i} missing`);
			expect(row.id).toBe(expected[0]);
			expect(row.text).toBe(expected[1]);
			expect(Buffer.isBuffer(row.blob)).toBe(true);
			expect(row.blob.equals(expected[2])).toBe(true);
			expect(row.json).toBe(expected[3]);
		}
		db2.close();
	}, 120_000);
});
