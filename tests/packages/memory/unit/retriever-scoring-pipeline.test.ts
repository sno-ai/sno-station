import { describe, expect, it } from "vitest";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	type MemoryRetrieverInternals,
} from "../../../../apps/mem-claw/src/retrieval/retriever.ts";
import type { RetrievalResult } from "../../../../apps/mem-claw/src/shared/types.ts";

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
	it("excludes a candidate whose post-decay score falls below hardMinScore", () => {
		// Raw 0.55 > floor (0.50) but time-decay shrinks it to ~0.33, which violates
		// the returned-set contract if the floor were applied before decay.
		const now = Date.now();
		const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			hardMinScore: 0.5,
			minScore: 0,
			recencyHalfLifeDays: 0,
			recencyWeight: 0,
			lengthNormAnchor: 0,
			importanceWeightBase: 1,
			timeDecayHalfLifeDays: 30,
			timeDecayFloor: 0.6,
			temporalDecay: false,
			rerank: "none",
			reinforcementFactor: 0,
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

		expect(output.map((r) => r.entry.id)).not.toContain("stale-near-floor");
		for (const r of output) {
			expect(r.score).toBeGreaterThanOrEqual(0.5);
		}
	});

	it("keeps a near-miss candidate that the recency boost lifts above hardMinScore", () => {
		// Raw 0.45 < floor (0.50). Recency boost (additive 0.3 * 1.0) lifts it to 0.75.
		// A pre-stage filter would drop it before the boost ever ran.
		const now = Date.now();
		const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			hardMinScore: 0.5,
			minScore: 0,
			recencyHalfLifeDays: 7,
			recencyWeight: 0.3,
			lengthNormAnchor: 0,
			importanceWeightBase: 1,
			timeDecayHalfLifeDays: 0,
			temporalDecay: false,
			rerank: "none",
			reinforcementFactor: 0,
		});
		const internals = retriever as unknown as MemoryRetrieverInternals;

		const candidates = [
			buildCandidate({ id: "fresh-near-miss", score: 0.45, timestamp: now }),
		];

		const output = internals.applyScoringPipeline(candidates);

		const lifted = output.find((r) => r.entry.id === "fresh-near-miss");
		expect(lifted).toBeDefined();
		expect(lifted?.score).toBeGreaterThanOrEqual(0.5);
	});

	it("matches a pure hardMinScore filter when decay and boost stages are disabled", () => {
		// With all multiplicative shrinkers and additive boosts off, the new
		// ordering must agree with what a single hardMinScore filter would return.
		const now = Date.now();
		const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			hardMinScore: 0.5,
			minScore: 0,
			recencyHalfLifeDays: 0,
			recencyWeight: 0,
			lengthNormAnchor: 0,
			importanceWeightBase: 1,
			timeDecayHalfLifeDays: 0,
			temporalDecay: false,
			rerank: "none",
			reinforcementFactor: 0,
		});
		const internals = retriever as unknown as MemoryRetrieverInternals;

		const candidates = [
			buildCandidate({ id: "above", score: 0.8, timestamp: now }),
			buildCandidate({ id: "below", score: 0.3, timestamp: now }),
		];

		const output = internals.applyScoringPipeline(candidates);
		const expected = candidates.filter((c) => c.score >= 0.5).map((c) => c.entry.id);

		expect(output.map((r) => r.entry.id)).toEqual(expected);
		for (const r of output) {
			const original = candidates.find((c) => c.entry.id === r.entry.id);
			expect(r.score).toBe(original?.score);
		}
	});
});
