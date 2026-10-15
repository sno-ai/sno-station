/** @file local-ranking-keyword-only-hits.test.ts
 * @purpose The local ranking puts the memory that answers the question above memories that only share a word with it.
 * @boundary Real retriever and its default local ranking, real local embedder for every vector; the store returns the
 * branch scores the product's own store returned for a question of this shape on LoCoMo (measured 2026-10-15);
 * the texts are written for this test.
 */

import { beforeAll, expect, it } from "vitest";
import { createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import type { MemoryEntry, MemorySearchResult } from "../../../../packages/memory/src/engine/shared/types.ts";

const QUERY = "When did Nate take time off to chill with his pets?";
// The answer reached the pool through both branches; the other four through the keyword branch alone, each sharing a
// word with the question. Scores as the product's store returned them.
const ROWS = [
	{ id: "answer", vector: 0.527, keyword: 0.941, text: "[10:57 am on 22 August, 2022] Nate: I'm taking a few days off this weekend just to chill at home with my pets." },
	{ id: "games", keyword: 0.876, text: "[10:58 am on 9 October, 2022] Joanna: Board games get tense when everyone takes each move so seriously." },
	{ id: "congrats", keyword: 0.828, text: "[2:12 pm on 5 June, 2022] Nate: Well done on the award, Joanna! Take a minute to enjoy it." },
	{ id: "competitive", keyword: 0.826, text: "[2:01 pm on 23 January, 2022] Nate: Some players are really competitive, so I hang out with the chill ones." },
	{ id: "later", keyword: 0.808, text: "[9:27 am on 7 February, 2022] Joanna: Talk soon, take care!" },
];

function entry(id: string, text: string): MemoryEntry {
	return { id, text, category: "episodic", lane: "active", projectId: "global", importance: 0.7, timestamp: Date.UTC(2022, 0, 1), timezone: "UTC", metadata: "{}", contentHash: id };
}

let embedder: Embedder;
const vectors = new Map<string, Float32Array>();

beforeAll(async () => {
	embedder = await createTestEmbedder();
	const embedded = await embedder.embedChunks(ROWS.map((row) => row.text));
	for (const [index, row] of ROWS.entries()) {
		const vector = embedded[index];
		if (vector) vectors.set(`${row.id}:0`, vector);
	}
}, 120_000);

it("ranks the memory that answers first, above memories that only share a word with the question", async () => {
	const hit = (row: (typeof ROWS)[number], score: number): MemorySearchResult =>
		({ entry: entry(row.id, row.text), score, chunkId: `${row.id}:0`, chunkIndex: 0, bestChunkScore: score }) as MemorySearchResult;
	const store = {
		hasFtsSupport: true,
		isMemoryOnFactSurface: () => true,
		searchSemantic: async () => ROWS.filter((row) => row.vector !== undefined).map((row) => hit(row, row.vector ?? 0)),
		searchKeyword: async () => ROWS.map((row) => hit(row, row.keyword)),
		getVectorsByIds: (ids: string[]) => new Map(ids.flatMap((id) => { const v = vectors.get(id); return v ? [[id, v] as const] : []; })),
	};
	const retriever = createRetriever(store as never, embedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "lightweight", minScore: 0, hardMinScore: 0 });
	const results = await retriever.retrieve({ query: QUERY, limit: 3 });
	expect(results[0]?.entry.id).toBe("answer");
}, 60_000);
