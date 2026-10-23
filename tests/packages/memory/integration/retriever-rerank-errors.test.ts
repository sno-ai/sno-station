import { describe, expect, it } from "vitest";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
const TEST_ENTRY = { id: "mem-1", text: "TypeScript strict mode avoids implicit any bugs.", category: "episodic" as const, projectId: "global", importance: 0.7, timestamp: Date.now(), metadata: "{}", contentHash: "hash-1" };
const embedderStub = { warmup: async () => {}, embed: async () => new Float32Array([1, 0, 0]) };
describe("retrieval final filtering", () => {
	it("applies minScore in bm25-only tagged queries", async () => {
		const taggedResults = [
			{
				entry: {
					...TEST_ENTRY,
					id: "mem-low",
					text: "proj:AIF low score tagged match",
					importance: 1,
					contentHash: "hash-low",
				},
				score: 0.49,
			},
			{
				entry: {
					...TEST_ENTRY,
					id: "mem-pass",
					text: "proj:AIF passing tagged match",
					importance: 1,
					contentHash: "hash-pass",
				},
				score: 0.55,
			},
		];

		const retriever = createRetriever(
			{
				hasFtsSupport: true,
				isMemoryOnFactSurface: () => true,
				searchSemantic: async () => {
					throw new Error("vector search should not run for tagged queries");
				},
				searchKeyword: async () => taggedResults,
			} as never,
			embedderStub as never,
			{ warn: () => {} },
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "none",
				minScore: 0.5,
				hardMinScore: 0,
				lengthNormAnchor: 0,
				importanceWeightBase: 0.5,
			},
		);

		const results = await retriever.retrieve({
			query: "proj:AIF deploy",
			limit: 5,
		});

		expect(results.map((result) => result.entry.id)).toEqual(["mem-pass"]);
	});

});
