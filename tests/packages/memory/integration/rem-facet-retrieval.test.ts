import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MAX_CANDIDATE_POOL_SIZE } from "../../../../packages/memory/config/index.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("REM facet retrieval", () => {
	let testDb: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(() => {
		store?.close();
		testDb?.cleanup();
		store = undefined;
		testDb = undefined;
	});



	it("serves every matching memory, past the retired ceiling and past the caller's budget", async () => {
		// One more than the ceiling this path used to impose, so the fixture can tell the two
		// designs apart: a store that stopped at the ceiling would score identically under both.
		const seeded = MAX_CANDIDATE_POOL_SIZE + 1;
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		const storedIds: string[] = [];
		for (let index = 0; index < seeded; index += 1) {
			const memory = await store.store({
				text: `Coffee purchase ${index}: $1.00.`,
				category: "episodic",
				projectId: "global",
				importance: 0.8,
			});
			storedIds.push(memory.id);
		}
		const retriever = createRetriever(store, embedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			minScore: 0,
		});

		const aggregation = await retriever.retrieve({
			query: "How much did the user spend on coffee?",
			limit: 1,
			aggregation: { operation: "evidence", terms: ["coffee"] },
		});

		// Membership, not just the count: a total is wrong in the same way whether rows are missing
		// or silently swapped, and the failure this path had was losing the newest rows specifically.
		expect(aggregation).toHaveLength(seeded);
		expect(aggregation.map((result) => result.entry.id).sort()).toEqual([...storedIds].sort());
	});
});
