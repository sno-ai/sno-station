import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let embedder: Embedder;
let cleanup: () => void;
let store: MemoryStore;

beforeAll(async () => { embedder = await createTestEmbedder(); });
beforeEach(() => {
	const db = createTestDb();
	cleanup = db.cleanup;
	store = new MemoryStore({ dbPath: db.dbPath, embedder });
});
afterEach(() => { store.close(); cleanup(); });

// A pasted log or hash dump has no sentence breaks and many tokens per character, so the embedder's own chunker
// cannot cut it under the model's token limit; recall used to fail outright with it as the query.
it("recalls with a query longer than the embedding model's token limit", async () => {
	const text = "The Yukon release checklist requires the cedar rollback procedure.";
	await store.store({ text, category: "episodic", projectId: "long-query" });
	const query = `Yukon release checklist ${Array.from({ length: 400 }, (_, i) => (i * 2654435761 >>> 0).toString(16)).join("")}`;
	expect(embedder.countTokens(query)).toBeGreaterThan(512);
	const results = await createRetriever(store, embedder, undefined, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" }).retrieve({ query, limit: 5, scopeFilter: ["long-query"] });
	expect(results.map(r => r.entry.text)).toContain(text);
});
