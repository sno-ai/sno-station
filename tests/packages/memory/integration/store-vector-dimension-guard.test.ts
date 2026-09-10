import { describe, expect, it, beforeAll } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("MemoryStore vector dimension guard", () => {
	async function storeVector(store: MemoryStore, dim: number) {
		const vector = new Float32Array(dim);
		vector[0] = 1;
		await store.store({
			text: `dimension ${dim} memory`,
			vector,
			category: "episodic",
			projectId: "global",
		});
	}

	it("creates the vec table at the configured dim on first init", () => {
		const testDb = createTestDb();
		try {
			const store = new MemoryStore({ dbPath: testDb.dbPath, vectorDim: 1536, embedder: testEmbedder });
			store.close();

			const reopened = new MemoryStore({
				dbPath: testDb.dbPath,
				vectorDim: 1536,
				embedder: testEmbedder,
			});
			reopened.close();
		} finally {
			testDb.cleanup();
		}
	});

	it("recreates an empty legacy vec table at the configured dim", () => {
		const testDb = createTestDb();
		try {
			const store = new MemoryStore({ dbPath: testDb.dbPath, vectorDim: 1024, embedder: testEmbedder });
			store.close();

			const switched = new MemoryStore({
				dbPath: testDb.dbPath,
				vectorDim: 512,
				embedder: testEmbedder,
			});
			switched.close();

			const reopened = new MemoryStore({
				dbPath: testDb.dbPath,
				vectorDim: 512,
				embedder: testEmbedder,
			});
			reopened.close();
		} finally {
			testDb.cleanup();
		}
	});

	it("throws when reopening with a different dim after vectors exist", async () => {
		const testDb = createTestDb();
		try {
			const store = new MemoryStore({ dbPath: testDb.dbPath, vectorDim: 1024, embedder: testEmbedder });
			await storeVector(store, 1024);
			store.close();

			expect(
				() => new MemoryStore({ dbPath: testDb.dbPath, vectorDim: 512, embedder: testEmbedder }),
				// The refusal names the table and both dimensions. Asserting on the dimensions
				// keeps the check strict: a message that merely says "mismatch" would let a
				// guard that compared the wrong pair of numbers pass.
			).toThrow(/configured dim 512, found dim 1024/);
		} finally {
			testDb.cleanup();
		}
	});

	it("can reopen cleanly at the locked dim after a failed mismatch open", async () => {
		const testDb = createTestDb();
		try {
			const initial = new MemoryStore({
				dbPath: testDb.dbPath,
				vectorDim: 1024,
				embedder: testEmbedder,
			});
			await storeVector(initial, 1024);
			initial.close();

			expect(
				() => new MemoryStore({ dbPath: testDb.dbPath, vectorDim: 512, embedder: testEmbedder }),
			).toThrow(/configured dim 512, found dim 1024/);

			const reopened = new MemoryStore({
				dbPath: testDb.dbPath,
				vectorDim: 1024,
				embedder: testEmbedder,
			});
			reopened.close();
		} finally {
			testDb.cleanup();
		}
	});
});
