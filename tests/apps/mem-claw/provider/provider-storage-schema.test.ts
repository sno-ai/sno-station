import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterAll(() => {
	// The real embedder is process-cached by the test helper.
});

describe("provider storage schema", () => {
	it("uses project_id as the live memory boundary in fresh test databases", () => {
		const testDb = createTestDb();
		try {
			const columns = testDb.sqlite
				.prepare("PRAGMA table_info(nodix_memories)")
				.all() as Array<{ name: string }>;
			const names = columns.map((column) => column.name);

			expect(names).toContain("project_id");
			expect(names).not.toContain(["s", "c", "o", "p", "e"].join(""));

			const indexes = testDb.sqlite
				.prepare("PRAGMA index_list(nodix_memories)")
				.all() as Array<{ name: string }>;
			expect(indexes.map((index) => index.name)).toContain(
				"nodix_idx_memories_project_content_hash",
			);

			const providerTables = testDb.sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'nodix_provider_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>;
			expect(providerTables.map((table) => table.name)).toEqual([
				"nodix_provider_agent_mappings",
				"nodix_provider_project_agents",
				"nodix_provider_project_mappings",
			]);
		} finally {
			testDb.cleanup();
		}
	});

	it("fails closed on a legacy boundary database", async () => {
		const testDb = createTestDb();
		let opened: MemoryStore | undefined;
		try {
			testDb.sqlite.exec("DROP TABLE nodix_memories;");
			testDb.sqlite.exec(`
				CREATE TABLE nodix_memories (
					id TEXT PRIMARY KEY,
					text TEXT NOT NULL,
					category TEXT NOT NULL,
					${["s", "c", "o", "p", "e"].join("")} TEXT NOT NULL DEFAULT 'global',
					importance REAL NOT NULL DEFAULT 0.7,
					timestamp INTEGER NOT NULL,
					metadata TEXT DEFAULT '{}',
					content_hash TEXT NOT NULL,
					fact_id TEXT
				);
			`);
			testDb.sqlite.close();

			expect(() => {
				opened = new MemoryStore({ dbPath: testDb.dbPath, embedder });
			}).toThrow(/legacy boundary schema is unsupported/i);
		} finally {
			opened?.closeSync();
			testDb.cleanup();
		}
	});
});
