// Reference implementation of the CURRENT MMR contract — a simple splice-based
// greedy version, kept deliberately naive so the production `applyMmrDiversity`
// (incremental maxSim cache) can be verified byte-identical against it for every
// input shape the production call site emits.
//
// Contract (2026-07-05 scoring-pipeline audit + codex-reviewer telemetry fix):
//   - relevance is batch-max normalized: score / max(score) — without it the
//     shrinker chain compresses scores to ~0.03-0.06 and the diversity term
//     dominates by an order of magnitude;
//   - the seed stamps mmrScore = score/maxScore, so
//     rank-1 no longer reports the lowest mmr_score of the set in telemetry;
//   - no n<=2 short-circuit: n=1 seeds and stamps, n=2 runs the greedy pick.
// (Updated 2026-07-13: the previous copy froze the pre-audit un-normalized
// algorithm and diverged from the shipped implementation.)

import { describe, expect, it } from "vitest";
import {
	MemoryRetriever,
	type MemoryRetrieverInternals,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import { dotProduct } from "../../../../packages/sno-station-mem/src/engine/retrieval/retrieval-scoring-utils.ts";
import type { RetrievalResult } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";
import { clamp01 } from "../../../../packages/sno-station-mem/src/engine/shared/utils.ts";

// Lambda must match production default so behavior matches a real call path.
// Source: apps/mem-claw/config/index.ts (MMR_LAMBDA = 0.7).
const MMR_LAMBDA = 0.7;

// --- Frozen reference (verbatim copy of the splice-based MMR algorithm) -----
function mmrReference(
	results: RetrievalResult[],
	lambda: number,
	vectorMap: Map<string, Float32Array>,
): RetrievalResult[] {
	if (results.length === 0) return results;

	const getVector = (result: RetrievalResult): Float32Array | undefined => {
		if (!result.chunkId) return undefined;
		return vectorMap.get(result.chunkId);
	};

	const remaining = [...results].sort((a, b) => {
		const diff = b.score - a.score;
		if (diff !== 0) return diff;
		return a.entry.id.localeCompare(b.entry.id);
	});
	const maxScore = Math.max(remaining[0]?.score ?? 0, 1e-9);

	const comparable = remaining.filter((result) => getVector(result) !== undefined);
	const dimension = comparable[0] ? getVector(comparable[0])?.length : undefined;
	const dimensionsMatch =
		dimension !== undefined && comparable.every((result) => getVector(result)?.length === dimension);
	if (!dimensionsMatch || comparable.length < 2) {
		return remaining.map((r) => ({ ...r, mmrScore: r.score / maxScore }));
	}
	const comparableSlots = new Set(comparable.map((result) => result.entry.id));
	const diversified: RetrievalResult[] = [];

	while (comparable.length > 0 && diversified.length < results.length) {
		if (diversified.length === 0) {
			const first = comparable.shift();
			if (first) diversified.push({ ...first, mmrScore: first.score / maxScore });
			continue;
		}

		let bestIndex = 0;
		let bestMmrScore = Number.NEGATIVE_INFINITY;
		for (const [index, candidate] of comparable.entries()) {
			const candVec = getVector(candidate);
			let maxSimilarity = 0;
			if (candVec) {
				for (const item of diversified) {
					const itemVec = getVector(item);
					if (!itemVec || itemVec.length !== candVec.length) continue;
					const sim = clamp01(dotProduct(candVec, itemVec), 0);
					if (sim > maxSimilarity) maxSimilarity = sim;
				}
			}
			const mmrScore = lambda * (candidate.score / maxScore) - (1 - lambda) * maxSimilarity;
			if (mmrScore > bestMmrScore) {
				bestMmrScore = mmrScore;
				bestIndex = index;
			}
		}
		const next = comparable.splice(bestIndex, 1)[0];
		if (next) {
			diversified.push({ ...next, mmrScore: bestMmrScore });
		}
	}
	let diversifiedIndex = 0;
	return remaining.map((result) => {
		if (!comparableSlots.has(result.entry.id)) {
			return { ...result, mmrScore: result.score / maxScore };
		}
		const next = diversified[diversifiedIndex];
		diversifiedIndex += 1;
		return next ?? { ...result, mmrScore: result.score / maxScore };
	});
}

// --- Deterministic PRNG (mulberry32) ----------------------------------------
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function normalize(vec: Float32Array): Float32Array {
	let norm = 0;
	for (let i = 0; i < vec.length; i += 1) {
		const x = vec[i] ?? 0;
		norm += x * x;
	}
	const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
	for (let i = 0; i < vec.length; i += 1) vec[i] = (vec[i] ?? 0) * inv;
	return vec;
}

function randomVector(dim: number, rng: () => number): Float32Array {
	const v = new Float32Array(dim);
	for (let i = 0; i < dim; i += 1) v[i] = rng() * 2 - 1;
	return normalize(v);
}

interface BuildOptions {
	id: string;
	score: number;
	chunkId?: string;
}

function buildResult({ id, score, chunkId }: BuildOptions): RetrievalResult {
	return {
		entry: {
			id,
			text: `text-${id}`,
			category: "episodic",
			lane: "active",
			projectId: "global",
			importance: 1,
			timestamp: 0,
			metadata: "",
			contentHash: `hash-${id}`,
		},
		score,
		sources: { vector: { score, rank: 1 } },
		...(chunkId !== undefined ? { chunkId } : {}),
	};
}

// --- Harness ---------------------------------------------------------------
function runProd(
	results: RetrievalResult[],
	vectorMap: Map<string, Float32Array>,
	lambda: number = MMR_LAMBDA,
): RetrievalResult[] {
	const internals = {
		config: { mmrLambda: lambda },
		store: { getVectorsByIds: (_ids: string[]) => vectorMap },
	} as unknown as MemoryRetrieverInternals;
	// Runtime prototype composition is not visible on the MemoryRetriever class type.
	const applyMmrDiversity = (
		MemoryRetriever.prototype as unknown as {
			applyMmrDiversity: MemoryRetrieverInternals["applyMmrDiversity"];
		}
	).applyMmrDiversity;
	return applyMmrDiversity.call(internals, [...results]);
}

function runBoth(
	results: RetrievalResult[],
	vectorMap: Map<string, Float32Array>,
	lambda: number = MMR_LAMBDA,
): { actual: RetrievalResult[]; expected: RetrievalResult[] } {
	return {
		actual: runProd(results, vectorMap, lambda),
		expected: mmrReference([...results], lambda, vectorMap),
	};
}

// --- Tests -----------------------------------------------------------------
describe("applyMmrDiversity equivalence with frozen reference", () => {
	it("n=3 happy path with full 1024-dim vectors", () => {
		const rng = mulberry32(0x1234);
		const dim = 1024;
		const items: RetrievalResult[] = [];
		const map = new Map<string, Float32Array>();
		for (let i = 0; i < 3; i += 1) {
			const chunkId = `c${i}`;
			items.push(buildResult({ id: `m${i}`, score: rng(), chunkId }));
			map.set(chunkId, randomVector(dim, rng));
		}
		const { actual, expected } = runBoth(items, map);
		expect(actual).toEqual(expected);
	});

	it("n=64 production-sized candidate pool", () => {
		const rng = mulberry32(0xabc);
		const dim = 1024;
		const items: RetrievalResult[] = [];
		const map = new Map<string, Float32Array>();
		for (let i = 0; i < 64; i += 1) {
			const chunkId = `c${String(i).padStart(2, "0")}`;
			items.push(buildResult({ id: `m${String(i).padStart(2, "0")}`, score: rng(), chunkId }));
			map.set(chunkId, randomVector(dim, rng));
		}
		const { actual, expected } = runBoth(items, map);
		expect(actual).toEqual(expected);
	});

	it("varied scores with vectors present — rank stability", () => {
		const rng = mulberry32(42);
		const dim = 128;
		const items: RetrievalResult[] = [];
		const map = new Map<string, Float32Array>();
		// Use a small score alphabet to force ties without making all scores identical.
		const scoreAlphabet = [0.9, 0.7, 0.7, 0.5, 0.5, 0.3, 0.3, 0.1];
		for (let i = 0; i < 16; i += 1) {
			const chunkId = `c${i}`;
			const score = scoreAlphabet[i % scoreAlphabet.length] ?? 0;
			items.push(buildResult({ id: `m${String(i).padStart(2, "0")}`, score, chunkId }));
			map.set(chunkId, randomVector(dim, rng));
		}
		const { actual, expected } = runBoth(items, map);
		expect(actual).toEqual(expected);
	});

	it("all-tied scores → fully deterministic ordering", () => {
		const rng = mulberry32(7);
		const dim = 64;
		const items: RetrievalResult[] = [];
		const map = new Map<string, Float32Array>();
		for (let i = 0; i < 10; i += 1) {
			const chunkId = `c${i}`;
			items.push(buildResult({ id: `id-${String(i).padStart(2, "0")}`, score: 0.5, chunkId }));
			map.set(chunkId, randomVector(dim, rng));
		}
		const { actual, expected } = runBoth(items, map);
		expect(actual).toEqual(expected);
		// Seed must be the lowest-id (ties broken by id asc).
		expect(actual[0]?.entry.id).toBe("id-00");
	});

	it("some results missing chunkId keep their slots while comparable results diversify", () => {
		const items = [
			buildResult({ id: "a", score: 0.9, chunkId: "ca" }),
			buildResult({ id: "x", score: 0.85 }),
			buildResult({ id: "b", score: 0.8, chunkId: "cb" }),
			buildResult({ id: "y", score: 0.75 }),
			buildResult({ id: "c", score: 0.7, chunkId: "cc" }),
		];
		const map = new Map<string, Float32Array>([
			["ca", new Float32Array([1, 0])],
			["cb", new Float32Array([1, 0])],
			["cc", new Float32Array([0, 1])],
		]);
		const { actual, expected } = runBoth(items, map, 0);
		expect(actual).toEqual(expected);
		expect(actual.map((r) => r.entry.id)).toEqual(["a", "x", "c", "y", "b"]);
		expect(actual[1]?.mmrScore).toBeCloseTo(0.85 / 0.9, 12);
		expect(actual[3]?.mmrScore).toBeCloseTo(0.75 / 0.9, 12);
	});

	it("mixed vector dimensions → whole batch falls back to relevance order", () => {
		const rng = mulberry32(0xdead);
		const items: RetrievalResult[] = [];
		const map = new Map<string, Float32Array>();
		for (let i = 0; i < 12; i += 1) {
			const chunkId = `c${i}`;
			const dim = i < 6 ? 1024 : 8;
			items.push(buildResult({ id: `m${String(i).padStart(2, "0")}`, score: rng(), chunkId }));
			map.set(chunkId, randomVector(dim, rng));
		}
		const { actual, expected } = runBoth(items, map);
		expect(actual).toEqual(expected);
	});

	it("n=2 with B.score > A.score → seeds with B (highest), stamps mmrScore on both", () => {
		// Locks down the fix for the prior n<=2 early-return bug that returned input order
		// unsorted and skipped mmrScore stamping, plus direct assertions of the
		// normalized-relevance contract values.
		const rng = mulberry32(1);
		const dim = 16;
		const vecA = randomVector(dim, rng);
		const vecB = randomVector(dim, rng);
		const items = [
			buildResult({ id: "a", score: 0.6, chunkId: "ca" }),
			buildResult({ id: "b", score: 0.8, chunkId: "cb" }),
		];
		const map = new Map<string, Float32Array>([
			["ca", vecA],
			["cb", vecB],
		]);
		const { actual, expected } = runBoth(items, map);
		expect(actual).toEqual(expected);
		expect(actual).toHaveLength(2);
		expect(actual[0]?.entry.id).toBe("b");
		// Seed stamps on the normalized scale: 0.8 / 0.8 = 1.
		expect(actual[0]?.mmrScore).toBe(1);
		expect(actual[1]?.entry.id).toBe("a");
		// Second pick = λ*(score/maxScore) - (1-λ)*sim(A, B).
		const sim = Math.max(0, Math.min(1, vecA.reduce((s, x, i) => s + x * (vecB[i] ?? 0), 0)));
		const expectedA = MMR_LAMBDA * (0.6 / 0.8) - (1 - MMR_LAMBDA) * sim;
		expect(actual[1]?.mmrScore).toBeCloseTo(expectedA, 10);
	});

	it("n=1 stamps mmrScore on the lone result", () => {
		const items = [buildResult({ id: "solo", score: 0.42, chunkId: "cs" })];
		const map = new Map<string, Float32Array>([["cs", new Float32Array([1, 0, 0])]]);
		const actual = runProd(items, map);
		expect(actual).toHaveLength(1);
		expect(actual[0]?.entry.id).toBe("solo");
		// Normalized against the batch max (itself): 0.42 / 0.42 = 1.
		expect(actual[0]?.mmrScore).toBe(1);
	});

	it("n=0 returns empty", () => {
		const actual = runProd([], new Map());
		expect(actual).toEqual([]);
	});

	it("n=3 all chunkIds undefined → relevance order, no diversity term", () => {
		const items = [
			buildResult({ id: "a", score: 0.9 }),
			buildResult({ id: "b", score: 0.5 }),
			buildResult({ id: "c", score: 0.3 }),
		];
		const map = new Map<string, Float32Array>();
		const { actual, expected } = runBoth(items, map);
		expect(actual).toEqual(expected);
		// No vectors at all → nothing is comparable → relevance order, and mmrScore is the
		// normalized relevance rather than lambda-scaled.
		expect(actual.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
		expect(actual.map((r) => r.mmrScore)).toEqual([1, 0.5 / 0.9, 0.3 / 0.9]);
	});

	it("all-tied scores AND identical vectors → maximum tie collision", () => {
		const dim = 32;
		const sharedVec = new Float32Array(dim);
		for (let i = 0; i < dim; i += 1) sharedVec[i] = 1 / Math.sqrt(dim);
		const items: RetrievalResult[] = [];
		const map = new Map<string, Float32Array>();
		for (let i = 0; i < 8; i += 1) {
			const chunkId = `c${i}`;
			items.push(buildResult({ id: `id-${String(i).padStart(2, "0")}`, score: 0.5, chunkId }));
			map.set(chunkId, sharedVec);
		}
		const { actual, expected } = runBoth(items, map);
		expect(actual).toEqual(expected);
	});

	it("heterogeneous vector dims → one odd dimension disqualifies the whole batch", () => {
		// One dim=8 vector among four dim=1024 ones. Its similarity to the rest cannot be
		// computed, and a candidate whose similarity is unknown must not be scored as novel,
		// so the batch is ordered by relevance instead of partially diversified.
		const rng = mulberry32(0xbeef);
		const items: RetrievalResult[] = [
			buildResult({ id: "s-seed", score: 0.95, chunkId: "cs" }),
			buildResult({ id: "s-mid", score: 0.9, chunkId: "cm" }),
			buildResult({ id: "r-a", score: 0.8, chunkId: "ra" }),
			buildResult({ id: "r-b", score: 0.75, chunkId: "rb" }),
			buildResult({ id: "r-c", score: 0.7, chunkId: "rc" }),
		];
		const map = new Map<string, Float32Array>([
			["cs", randomVector(1024, rng)],
			["cm", randomVector(8, rng)],
			["ra", randomVector(1024, rng)],
			["rb", randomVector(1024, rng)],
			["rc", randomVector(1024, rng)],
		]);
		const { actual, expected } = runBoth(items, map);
		expect(actual).toEqual(expected);
	});
});
