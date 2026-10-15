/** @file local-rerank-model.test.ts
 * @purpose The local ranking's reranker model puts the memory that answers above one that only talks about the same
 * thing, in English and in Chinese (cases where the model's margin is wide; its 8-bit scores move by up to about one
 * logit with how texts are batched), and recall keeps the cosine order until the model has loaded.
 * @boundary Real encrypted store, real local embedder and reranker model (downloaded on first use), real retriever.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";

// In each pair the first memory shares more of the question's words and the second one answers it.
const MEMORIES: Record<string, string> = {
	"sister-talk": "Nate: My sister and I talk about work every week, she always asks where I want to go next.",
	"sister-job": "Nate: My sister started as a nurse at the city hospital in March.",
	"dog-tricks": "Nate：我的狗老得什么把戏都会了，但它还是像只小狗一样。",
	"dog-age": "Nate：Max 六月满七岁了，我们给它办了个小派对。",
};

let embedder: Embedder;
let fixture: TestDb;
let store: MemoryStore;

beforeAll(async () => {
	embedder = await createTestEmbedder();
	fixture = createTestDb();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	let order = 0;
	for (const [id, text] of Object.entries(MEMORIES)) {
		order += 1;
		await store.importEntry({
			id, text, category: "episodic", lane: "active", projectId: "global", importance: 0.7,
			timestamp: Date.UTC(2026, 0, 1) + order, metadata: "{}", contentHash: id,
		});
	}
}, 120_000);

afterAll(async () => {
	await store.close();
	fixture.cleanup();
});

const first = async (query: string): Promise<string | undefined> => {
	const retriever = createRetriever(store, embedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "lightweight", minScore: 0, hardMinScore: 0 });
	return (await retriever.retrieve({ query, limit: 3 }))[0]?.entry.id;
};

it("keeps the cosine order until the model has loaded, then ranks the answering memory first", async () => {
	// The first call starts the model load and does not wait for it.
	expect(await first("Where does Nate's sister work?")).toBe("sister-talk");
	const deadline = Date.now() + 240_000;
	while ((await embedder.scoreRelevance("probe", ["probe"])) === undefined && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	expect(await first("Where does Nate's sister work?")).toBe("sister-job");
	expect(await first("Nate 的狗几岁了？")).toBe("dog-age");
}, 300_000);
