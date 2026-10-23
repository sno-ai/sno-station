import { expect, it } from "vitest";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG, type MemoryRetrieverInternals } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import type { RetrievalResult } from "../../../../packages/memory/src/engine/shared/types.ts";
const noopStore = { getVectorsByIds: () => new Map<string, Float32Array>() } as never;
function candidate(id: string, score: number): RetrievalResult {
	return { entry: { id, text: `memory ${id}`, category: "episodic", lane: "active", projectId: "global", importance: 1, timestamp: Date.now(), metadata: "", contentHash: `hash-${id}` }, score, sources: { vector: { score, rank: 1 } } };
}
it("blends the local model's logit range with cosine while retaining the head's score slots", async () => {
	const embedder = { scoreRelevance: async () => [10, 9, 11] } as never;
	const retriever = createRetriever(noopStore, embedder, undefined, DEFAULT_RETRIEVAL_CONFIG) as unknown as MemoryRetrieverInternals;
	const outcome = await retriever.rerankLocalModel("query", [candidate("first", 0.9), candidate("second", 0.8), candidate("third", 0.1)]);
	expect(outcome.modelOrder).toEqual(["first", "third", "second"]);
	expect(outcome.candidates.map((result) => result.score)).toEqual([0.9, 0.8, 0.1]);
});

it("an untyped direct caller's retired remote mode still runs the local model", async () => {
	const local = createRetriever(noopStore, { scoreRelevance: async () => [-10, 10] } as never, undefined, {
		...DEFAULT_RETRIEVAL_CONFIG, rerank: "cross-encoder", rerankEndpoint: "http://127.0.0.1:9/rerank", rerankApiKey: "old-key",
	} as never) as unknown as MemoryRetrieverInternals;
	const outcome = await local.rerank("query", [candidate("near-miss", 0.9), candidate("answer", 0.8)], new Float32Array([1, 0, 0]));
	expect(outcome.modelOrder).toEqual(["answer", "near-miss"]);
});

it("an explicit none choice bypasses the model", async () => {
	const local = createRetriever(noopStore, { scoreRelevance: async () => [-10, 10] } as never, undefined, {
		...DEFAULT_RETRIEVAL_CONFIG, rerank: "none",
	}) as unknown as MemoryRetrieverInternals;
	const original = [candidate("first", 0.9), candidate("second", 0.8)];
	expect((await local.rerank("query", original, new Float32Array([1, 0, 0]))).candidates).toEqual(original);
});
