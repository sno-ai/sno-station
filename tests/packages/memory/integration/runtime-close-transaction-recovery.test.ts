/** Real deployed SQLCipher driver through sqlite-runtime. No mocks or substitute storage. */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import {
	openSqliteDatabase,
	type SqliteDatabaseLike,
} from "../../../../packages/sno-station-mem/src/store/sqlite-runtime.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

type JournalMode = "DELETE" | "WAL";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("synchronous runtime close during an open transaction", () => {
	let cleanup: (() => void) | undefined;
	let store: MemoryStore | undefined;
	let reopened: SqliteDatabaseLike | undefined;

	afterEach(() => {
		try {
			reopened?.close();
		} catch {
			// The assertion path may already have closed the real connection.
		}
		try {
			store?.closeSync();
		} catch {
			// Preserve the test failure while still removing its isolated database.
		}
		cleanup?.();
		cleanup = undefined;
		store = undefined;
		reopened = undefined;
	});

	it.each<JournalMode>(["WAL", "DELETE"])(
		"rolls back open work and reopens cleanly in %s mode",
		(journalMode) => {
			const fixture = createTestDb();
			cleanup = fixture.cleanup;
			fixture.sqlite.close();
			store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
			store.sqlite.exec("CREATE TABLE runtime_close_probe (value TEXT PRIMARY KEY)");
			store.sqlite.exec(`PRAGMA journal_mode=${journalMode}`);
			const configuredMode = store.sqlite.prepare("PRAGMA journal_mode").get() as {
				journal_mode: string;
			};
			expect(configuredMode.journal_mode).toBe(journalMode.toLowerCase());

			store.sqlite.exec("BEGIN IMMEDIATE");
			store.sqlite.prepare("INSERT INTO runtime_close_probe (value) VALUES (?)").run("aborted");
			store.closeSync();
			store = undefined;

			reopened = openSqliteDatabase(fixture.dbPath).db;
			const rolledBack = reopened.prepare("SELECT COUNT(*) AS count FROM runtime_close_probe").get() as {
				count: number;
			};
			expect(rolledBack.count).toBe(0);
			expect(reopened.prepare("PRAGMA integrity_check").get()).toEqual({
				integrity_check: "ok",
			});
			reopened.prepare("INSERT INTO runtime_close_probe (value) VALUES (?)").run("committed");
			expect(
				reopened.prepare("SELECT value FROM runtime_close_probe").all(),
			).toEqual([{ value: "committed" }]);
		},
	);
});
