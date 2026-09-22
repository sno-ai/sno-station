import { beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { stableHash } from "../../../../packages/memory/src/engine/shared/utils.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

async function waitForChunkBackfill(
	db: ReturnType<typeof createTestDb>["db"],
	memoryId: string,
): Promise<number> {
	for (let i = 0; i < 40; i++) {
		const row = db.$client
			.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunks WHERE memory_id = ?")
			.get(memoryId) as { count: number };
		if (row.count > 0) return row.count;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`legacy chunks were not backfilled for ${memoryId}`);
}

describe("MemoryStore legacy chunk backfill", () => {
	it(
		"backfills parent-only memories after store initialization",
		{ timeout: 20_000 },
		async () => {
			const testDb = createTestDb();
			const legacyText =
				"Legacy parent memory contains quartzmarker upgrade evidence.";
			try {
				testDb.db.$client
					.prepare(
						"INSERT INTO nodix_memories(id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, 'UTC', ?, ?)",
					)
					.run(
						"legacy-parent-only-1",
						"legacy-parent-only-1",
						legacyText,
						"episodic",
						"legacy-scope",
						0.9,
						Date.now(),
						"{}",
						stableHash(legacyText),
					);
				const before = testDb.db.$client
					.prepare(
						"SELECT COUNT(*) AS count FROM nodix_memory_chunks WHERE memory_id = ?",
					)
					.get("legacy-parent-only-1") as { count: number };
				expect(before.count).toBe(0);

				const store = new MemoryStore({
					dbPath: testDb.dbPath,
					embedder: testEmbedder,
				});
				try {
					const backfilledChunkCount = await waitForChunkBackfill(
						testDb.db,
						"legacy-parent-only-1",
					);

					const results = await store.searchKeyword("quartzmarker", {
						projectIdFilter: ["legacy-scope"],
						limit: 5,
					});
					const first = results[0];
					expect(first).toBeDefined();
					if (!first) throw new Error("legacy memory was not retrieved");
					expect(first.entry.id).toBe("legacy-parent-only-1");

					const vecCount = testDb.db.$client
						.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunk_vectors")
						.get() as { count: number };
					expect(vecCount.count).toBe(backfilledChunkCount);
				} finally {
					await store.close();
				}
			} finally {
				testDb.cleanup();
			}
		},
	);
});
