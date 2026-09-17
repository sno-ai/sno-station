import { describe, expect, it } from "vitest";
import { DEFAULT_RECALL_LIFECYCLE } from "../../../../packages/sno-station-mem/config/index.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	type MemoryRetrieverInternals,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import type { RetrievalResult } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

// Pure-function pipeline tests. `applyScoringPipeline` does not touch the store
// or embedder; MMR is the only stage that would, and it is short-circuited
// whenever the filtered candidate set has 2 or fewer entries. Each test below
// keeps the post-filter count <= 2 so an empty store/embedder stub is sufficient.
const noopStore = {
	getVectorsByIds: () => new Map<string, Float32Array>(),
} as never;
const noopEmbedder = {
	embed: async () => new Float32Array([1, 0, 0]),
} as never;

const DAY_MS = 24 * 60 * 60 * 1000;

interface CandidateInput {
	id: string;
	score: number;
	timestamp: number;
	importance?: number;
	textLength?: number;
}

function buildCandidate(input: CandidateInput): RetrievalResult {
	const text = input.textLength ? "a".repeat(input.textLength) : "memory text";
	return {
		entry: {
			id: input.id,
			text,
			category: "episodic",
			lane: "active",
			projectId: "global",
			importance: input.importance ?? 1,
			timestamp: input.timestamp,
			metadata: "",
			contentHash: `hash-${input.id}`,
		},
		score: input.score,
		sources: { vector: { score: input.score, rank: 1 } },
	};
}

describe("retriever scoring pipeline ordering", () => {
	it("serves the more relevant memory first regardless of timestamp and last access", () => {
		const retriever = createRetriever(noopStore, noopEmbedder, undefined, {
			...DEFAULT_RETRIEVAL_CONFIG,
		});
		retriever.setRecallLifecycle(DEFAULT_RECALL_LIFECYCLE);
		const internals = retriever as unknown as MemoryRetrieverInternals;
		const now = Date.now();
		for (const [relevantAge, otherAge] of [[365, 0], [0, 365], [365, 365], [0, 0]]) {
			const candidates = [
				buildCandidate({ id: "relevant", score: 0.9, importance: 0.3, timestamp: now - (relevantAge ?? 0) * DAY_MS }),
				buildCandidate({ id: "other", score: 0.7, importance: 0.3, timestamp: now - (otherAge ?? 0) * DAY_MS }),
			];
			for (const candidate of candidates) {
				candidate.entry.metadata = JSON.stringify({ memory_category: "episodic", accessCount: 1, lastAccessedAt: candidate.entry.timestamp });
			}
			const output = internals.applyScoringPipeline(candidates);
			expect(output.map((row) => row.entry.id)).toEqual(["relevant", "other"]);
			expect(output[0]?.score).toBeCloseTo(0.711, 10);
			expect(output[1]?.score).toBeCloseTo(0.553, 10);
		}
	});

	it("keeps an old candidate above hardMinScore", () => {
		const now = Date.now();
		const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			hardMinScore: 0.5,
			minScore: 0,
			lengthNormAnchor: 0,
			importanceWeightBase: 1,
			rerank: "none",
		});
		const internals = retriever as unknown as MemoryRetrieverInternals;

		const candidates = [
			buildCandidate({ id: "fresh", score: 0.9, timestamp: now }),
			buildCandidate({
				id: "stale-near-floor",
				score: 0.55,
				timestamp: now - 365 * DAY_MS,
			}),
		];

		const output = internals.applyScoringPipeline(candidates);

		expect(output.map((r) => r.entry.id)).toEqual(["fresh", "stale-near-floor"]);
		expect(output[1]?.score).toBe(0.55);
	});

	it("does not lift a fresh near-miss above hardMinScore", () => {
		const now = Date.now();
		const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			hardMinScore: 0.5,
			minScore: 0,
			lengthNormAnchor: 0,
			importanceWeightBase: 1,
			rerank: "none",
		});
		const internals = retriever as unknown as MemoryRetrieverInternals;

		const candidates = [
			buildCandidate({ id: "fresh-near-miss", score: 0.45, timestamp: now }),
		];

		const output = internals.applyScoringPipeline(candidates);

		expect(output).toEqual([]);
	});

	it("applies hardMinScore without age adjustments", () => {
		const now = Date.now();
		const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			hardMinScore: 0.5,
			minScore: 0,
			lengthNormAnchor: 0,
			importanceWeightBase: 1,
			rerank: "none",
		});
		const internals = retriever as unknown as MemoryRetrieverInternals;

		const candidates = [
			buildCandidate({ id: "above", score: 0.8, timestamp: now }),
			buildCandidate({ id: "below", score: 0.3, timestamp: now }),
		];

		const output = internals.applyScoringPipeline(candidates);
		expect(output.map((r) => r.entry.id)).toEqual(["above"]);
		expect(output[0]?.score).toBe(0.8);
	});
});
