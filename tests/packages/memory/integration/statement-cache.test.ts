/** Real encrypted SQLite. No mocking. Missing deps = FAIL. */

/**
 * Premise tests for the chokepoint prepared-statement cache (DB-optimization
 * Step 4). The cache in `wrapEncryptedDatabase` returns the SAME statement
 * object for a repeated SQL string, so two premises must hold on the real
 * encrypted runtime:
 *   1. Schema invalidation — a statement prepared before a DDL change keeps
 *      working afterwards and its plan reflects the new schema (SQLite
 *      re-prepares internally on SQLITE_SCHEMA).
 *   2. Two-caller isolation — interleaved get/all/run through the shared
 *      statement object stay correct and independent (no mode-mutating method
 *      is reachable through `SqliteStatementLike`, by interface construction).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteDatabase, type SqliteRuntimeHandle } from "../../../../packages/sno-station-mem/src/store/sqlite-runtime.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

describe("chokepoint prepared-statement cache", () => {
	let dbPath: string;
	let cleanup: () => void;
	let handle: SqliteRuntimeHandle;

	beforeEach(() => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		handle = openSqliteDatabase(dbPath);
	});

	afterEach(() => {
		try {
			handle.db.close();
		} catch {
			// closed by the test body
		}
		cleanup();
	});

	it("cached statements survive a schema change and pick up new indexes", () => {
		const db = handle.db;
		db.exec(
			"CREATE TABLE cache_probe (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, score REAL NOT NULL)",
		);
		const insert = db.prepare("INSERT INTO cache_probe (id, bucket, score) VALUES (?, ?, ?)");
		for (let i = 0; i < 200; i++) {
			insert.run(`row-${i}`, `bucket-${i % 10}`, i / 200);
		}

		const selectSql = "SELECT id FROM cache_probe WHERE bucket = ? ORDER BY score DESC";
		const before = db.prepare(selectSql).all("bucket-3");
		expect(before).toHaveLength(20);
		const planBefore = (
			db.prepare(`EXPLAIN QUERY PLAN ${selectSql}`).all("bucket-3") as Array<{ detail: string }>
		)
			.map((row) => row.detail)
			.join(" | ");
		expect(planBefore).toContain("SCAN");

		// DDL on the same connection — the cached statement must transparently
		// re-prepare (SQLITE_SCHEMA) and use the new index on its next execution.
		db.exec("CREATE INDEX idx_cache_probe_bucket ON cache_probe(bucket, score DESC)");

		const cachedAgain = db.prepare(selectSql);
		const after = cachedAgain.all("bucket-3");
		expect(after).toHaveLength(20);
		expect(after).toEqual(before);
		const planAfter = (
			db.prepare(`EXPLAIN QUERY PLAN ${selectSql}`).all("bucket-3") as Array<{ detail: string }>
		)
			.map((row) => row.detail)
			.join(" | ");
		expect(planAfter).toContain("idx_cache_probe_bucket");
	});

	it("two callers sharing one SQL string interleave get/all/run independently", () => {
		const db = handle.db;
		db.exec("CREATE TABLE cache_iso (id TEXT PRIMARY KEY, v INTEGER NOT NULL)");
		const write = db.prepare("INSERT INTO cache_iso (id, v) VALUES (?, ?)");
		write.run("a", 1);
		write.run("b", 2);

		const sql = "SELECT id, v FROM cache_iso WHERE v >= ? ORDER BY id";
		// Caller 1 and caller 2 obtain the statement separately (same cache slot).
		const callerOne = db.prepare(sql);
		const callerTwo = db.prepare(sql);

		const one = callerOne.all(1) as Array<{ id: string; v: number }>;
		const twoFirst = callerTwo.get(2) as { id: string; v: number } | undefined;
		const oneAgain = callerOne.all(2) as Array<{ id: string; v: number }>;

		expect(one.map((r) => r.id)).toEqual(["a", "b"]);
		expect(twoFirst?.id).toBe("b");
		expect(oneAgain.map((r) => r.id)).toEqual(["b"]);

		// A run() through the shared insert statement between reads must not
		// disturb either reader's subsequent results.
		write.run("c", 3);
		expect((callerTwo.all(1) as Array<{ id: string }>).map((r) => r.id)).toEqual(["a", "b", "c"]);
	});
});
