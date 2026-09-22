import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RECALL_LIFECYCLE } from "../../../../packages/memory/config/index.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	type MemoryRetrieverInternals,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { TraceCollector } from "../../../../packages/memory/src/engine/retrieval/retrieval-trace.ts";
import type { RetrievalResult } from "../../../../packages/memory/src/engine/shared/types.ts";

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
			metadata: '{"memory_category":"episodic"}',
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
	it("excludes a candidate whose post-decay score falls below hardMinScore", () => {
		// Raw 0.55 > floor (0.50) but time-decay shrinks it to ~0.33, which violates
		// the returned-set contract if the floor were applied before decay.
		const now = Date.now();
		const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			temporalWeighting: true,
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
			temporalWeighting: true,
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
			temporalWeighting: true,
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


describe("temporal weighting switch", () => {
	it("restores literal recency, decay, and retention scores when enabled", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		try {
			const retriever = createRetriever(noopStore, noopEmbedder, undefined, {
				...DEFAULT_RETRIEVAL_CONFIG, temporalWeighting: true,
			});
			retriever.setRecallLifecycle({ ...DEFAULT_RECALL_LIFECYCLE, retentionScorer: true });
			const internals = retriever as unknown as MemoryRetrieverInternals;
			const output = internals.applyScoringPipeline([
				buildCandidate({ id: "fresh", score: 0.8, timestamp: 1_800_000_000_000 }),
			]);
			expect(output.map((row) => row.entry.id)).toEqual(["fresh"]);
			expect(output[0]?.score).toBeCloseTo(0.84735, 10);
		} finally {
			vi.restoreAllMocks();
		}
	});
});


describe("default temporal trace and MMR window", () => {
	it("records all three disabled age stages without changing scores", () => {
		const retriever = createRetriever(noopStore, noopEmbedder);
		const trace = new TraceCollector();
		const output = (retriever as unknown as MemoryRetrieverInternals).applyScoringPipeline([
			buildCandidate({ id: "old", score: 0.8, timestamp: 0 }),
		], trace);
		const stages = trace.finalize("q", "precision-recall").stages;
		expect(stages.filter((stage) => stage.metadata?.skipped === "temporalWeighting")
			.map((stage) => [stage.name, stage.outputIds, stage.scoreRange])).toEqual([
			["recency_boost", ["old"], [0.8, 0.8]],
			["time_decay", ["old"], [0.8, 0.8]],
			["retention_boost", ["old"], [0.8, 0.8]],
		]);
		expect(output[0]?.score).toBe(0.8);
	});

	it("reorders only the requested window and cannot admit an outside candidate", () => {
		const vectors = new Map([
			["a", new Float32Array([1, 0, 0])],
			["b", new Float32Array([1, 0, 0])],
			["c", new Float32Array([0, 1, 0])],
			["d", new Float32Array([0, 0, 1])],
		]);
		const candidates = [0.9, 0.8, 0.7, 0.6].map((score, index) => {
			const id = ["a", "b", "c", "d"][index] ?? "";
			return { ...buildCandidate({ id, score, timestamp: 0 }), chunkId: id };
		});
		const make = (mmrWindowOnly: boolean): MemoryRetrieverInternals => createRetriever(
			{ getVectorsByIds: () => vectors } as never, noopEmbedder, undefined,
			{ ...DEFAULT_RETRIEVAL_CONFIG, mmrWindowOnly },
		) as unknown as MemoryRetrieverInternals;
		expect(make(false).applyScoringPipeline(candidates, undefined, 3)
			.map((row) => row.entry.id)).toEqual(["a", "c", "d", "b"]);
		expect(make(true).applyScoringPipeline(candidates, undefined, 3)
			.map((row) => row.entry.id)).toEqual(["a", "c", "b", "d"]);
		expect(make(true).applyScoringPipeline(candidates, undefined, 2)
			.map((row) => row.entry.id)).toEqual(["a", "b", "c", "d"]);
		const first = candidates[0];
		if (!first) throw new Error("Missing first candidate");
		first.entry.importance = 0;
		const filteredRetriever = make(true);
		filteredRetriever.config.hardMinScore = 0.65;
		const filtered = filteredRetriever.applyScoringPipeline(candidates, undefined, 2);
		expect(filtered.map((row) => row.entry.id)).toEqual(["b", "c"]);
		// Filtering out the original first row must not give the outside row an MMR score.
		expect(filtered.map((row) => row.mmrScore ?? null)).toEqual([1, null]);
	});
});
