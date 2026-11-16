import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

describe("chunk vector search and startup cleanup", () => {
	let testDb: ReturnType<typeof createTestDb>;
	let store: MemoryStore;
	const embedder = createEmbedder({ provider: "local-onnx" }, tmpdir());

	beforeEach(() => {
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, vectorDim: 2, embedder });
	});

	afterEach(async () => {
		await store?.close();
		testDb?.cleanup();
	});

	function insertMemoryWithChunk(id: string, chunkId: string): void {
		store["sqlite"].prepare(
			"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id) VALUES (?, 'Use SQLite for local storage.', 'episodic', 'vector-search-project', 0.7, 1700000000000, 'UTC', '{}', ?, ?)",
		).run(id, id, id);
		store["sqlite"].prepare(
			"INSERT INTO nodix_memory_chunks (chunk_id, memory_id, chunk_index, chunk_text, dense_payload, start_offset, end_offset, token_count, content_type, chunking_version, embedder_provider, embedder_model, embedder_dim, created_at, updated_at) VALUES (?, ?, 0, 'Use SQLite for local storage.', 'Use SQLite for local storage.', 0, 29, 6, 'prose', 'test', 'local-onnx', 'test-vector', 2, 1700000000000, 1700000000000)",
		).run(chunkId, id);
		store["sqlite"].prepare(
			"INSERT INTO nodix_memory_chunk_vectors (id, project_id, embedding) VALUES (?, 'vector-search-project', vec_f32('[0,1]'))",
		).run(chunkId);
	}

	it("returns the qualifying row beyond 4096 nearer vectors filtered out after KNN", async () => {
		insertMemoryWithChunk("qualifying-memory", "qualifying-chunk");
		expect((await store.searchChunksSemantic(new Float32Array([1, 0]), {
			projectIdFilter: ["vector-search-project"], limit: 1, minScore: 0,
		})).map((row) => row.parentMemoryId)).toEqual(["qualifying-memory"]);

		// Insert after open so startup cleanup cannot remove the search fixture.
		const insert = store["sqlite"].prepare(
			"INSERT INTO nodix_memory_chunk_vectors (id, project_id, embedding) VALUES (?, 'vector-search-project', vec_f32('[1,0]'))",
		);
		store["sqlite"].transaction(() => {
			for (let index = 0; index < 4100; index++) insert.run(`orphan-neighbour-${index}`);
		})();

		const results = await store.searchChunksSemantic(new Float32Array([1, 0]), {
			projectIdFilter: ["vector-search-project"], limit: 1, minScore: 0,
		});
		expect(results.map((row) => ({ memoryId: row.parentMemoryId, chunkId: row.chunkId })))
			.toEqual([{ memoryId: "qualifying-memory", chunkId: "qualifying-chunk" }]);
	});

	it("removes a migrated non-active memory's chunk vector when the store opens", async () => {
		insertMemoryWithChunk("legacy-non-active-memory", "legacy-non-active-chunk");
		store["sqlite"].prepare(
			"UPDATE nodix_memories SET lane = 'quarantined', raw_candidate_json = '{\"text\":\"Use SQLite for local storage.\"}', disposition_reason = 'subject_not_user', dispositioned_at_ms = 1700000000000 WHERE id = 'legacy-non-active-memory'",
		).run();
		await store.close();
		store = new MemoryStore({ dbPath: testDb.dbPath, vectorDim: 2, embedder });

		expect(store["sqlite"].prepare(
			"SELECT COUNT(*) AS count FROM nodix_memories WHERE id = 'legacy-non-active-memory'",
		).get()).toEqual({ count: 0 });
		expect(store["sqlite"].prepare(
			"SELECT COUNT(*) AS count FROM nodix_memory_chunks WHERE chunk_id = 'legacy-non-active-chunk'",
		).get()).toEqual({ count: 0 });
		expect(store["sqlite"].prepare(
			"SELECT COUNT(*) AS count FROM nodix_unplaced_memory_candidates WHERE text = 'Use SQLite for local storage.' AND disposition_reason = 'subject_not_user'",
		).get()).toEqual({ count: 1 });
		expect(store["sqlite"].prepare(
			"SELECT COUNT(*) AS count FROM nodix_memory_chunk_vectors WHERE id = 'legacy-non-active-chunk'",
		).get()).toEqual({ count: 0 });
	});

	it("removes an orphan vector on reopen while retaining a normal chunk vector", async () => {
		insertMemoryWithChunk("normal-memory", "normal-chunk");
		store["sqlite"].prepare(
			"INSERT INTO nodix_memory_chunk_vectors (id, project_id, embedding) VALUES ('orphan-on-reopen', 'vector-search-project', vec_f32('[1,0]'))",
		).run();
		await store.close();
		store = new MemoryStore({ dbPath: testDb.dbPath, vectorDim: 2, embedder });

		expect(store["sqlite"].prepare(
			"SELECT COUNT(*) AS count FROM nodix_memory_chunk_vectors WHERE id = 'normal-chunk'",
		).get()).toEqual({ count: 1 });
		expect(store["sqlite"].prepare(
			"SELECT COUNT(*) AS count FROM nodix_memory_chunk_vectors WHERE id = 'orphan-on-reopen'",
		).get()).toEqual({ count: 0 });
	});
});
