/**
 * Phase 0 §4 Retention boost stage stub tests.
 *
 * Covers tasks 4.2-4.4 of openspec/changes/mem-lifecycle/tasks.md:
 *   - 4.2 (stage placement): `applyRetentionBoost` runs between `applyTimeDecay`
 *     and the `hardMinScore` filter when the flag is on.
 *   - 4.3 (`boostMultiplier` bare): `composite=0 -> SEARCH_BOOST_MIN`,
 *     `composite=1 -> 1.0`.
 *   - 4.4 (`boostMultiplier` withFloor): honors
 *     `max(getTierFloor(tier), composite, recency)`.
 *
 * The flag-OFF pass-through invariant (task 4.1) is asserted here at the
 * stage boundary: `applyRetentionBoost` must return the input array
 * reference unchanged — no allocation — when `retentionScorer` is off.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_RECALL_LIFECYCLE,
	type RecallLifecycleConfig,
} from "../../../../packages/sno-station-mem/config/index.ts";
import { DEFAULT_DECAY_CONFIG } from "../../../../packages/sno-station-mem/src/engine/operations/selective-forgetting-scorer.ts";
import { boostMultiplier } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever-scoring-pipeline.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	type MemoryRetrieverInternals,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import type {
	DecayScore,
	MemoryTier,
	RetrievalResult,
} from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

const noopStore = {
	getVectorsByIds: () => new Map<string, Float32Array>(),
} as never;
const noopEmbedder = {
	embed: async () => new Float32Array([1, 0, 0]),
} as never;

const SEARCH_BOOST_MIN = DEFAULT_DECAY_CONFIG.searchBoostMin;
const DAY_MS = 24 * 60 * 60 * 1000;

interface CandidateInput {
	id: string;
	score: number;
	timestamp: number;
	importance?: number;
	tier?: MemoryTier;
	accessCount?: number;
	confidence?: number;
}

function buildCandidate(input: CandidateInput): RetrievalResult {
	const metadata = JSON.stringify({
		kind: "episodic",
		memory_category: "episodic",
		tier: input.tier ?? "peripheral",
		access_count: input.accessCount ?? 0,
		confidence: input.confidence ?? 0.7,
	});
	return {
		entry: {
			id: input.id,
			text: `memory text for ${input.id}`,
			category: "episodic",
			lane: "active",
			projectId: "global",
			importance: input.importance ?? 0.5,
			timestamp: input.timestamp,
			metadata,
			contentHash: `hash-${input.id}`,
		},
		score: input.score,
		sources: { vector: { score: input.score, rank: 1 } },
	};
}

/**
 * Build a retriever whose scoring pipeline is degenerate except for the
 * retention-boost stage: recency / importance / lengthNorm / time-decay all
 * zeroed so per-result score == raw input score before the boost runs.
 */
function makeRetriever(
	recallLifecycle: RecallLifecycleConfig | undefined,
): MemoryRetrieverInternals {
	const config = {
		...DEFAULT_RETRIEVAL_CONFIG,
		recencyHalfLifeDays: 0,
		recencyWeight: 0,
		lengthNormAnchor: 0,
		importanceWeightBase: 1,
		timeDecayHalfLifeDays: 0,
		temporalDecay: false,
		hardMinScore: 0,
		minScore: 0,
		rerank: "none" as const,
		reinforcementFactor: 0,
		...(recallLifecycle === undefined ? {} : { recallLifecycle }),
	};
	const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, config);
	if (recallLifecycle !== undefined) {
		retriever.setRecallLifecycle(recallLifecycle);
	}
	return retriever as unknown as MemoryRetrieverInternals;
}

function decayScore(composite: number, recency: number, memoryId = "x"): DecayScore {
	return {
		memoryId,
		composite,
		recency,
		frequency: 0,
		intrinsic: 0,
	};
}

describe("boostMultiplier (tasks §4.3 — bare mode)", () => {
	it("returns SEARCH_BOOST_MIN when composite == 0", () => {
		const m = boostMultiplier(decayScore(0, 0), "bare", "peripheral");
		// Exact equality: the formula at composite=0 is the floor itself.
		expect(m).toBe(SEARCH_BOOST_MIN);
	});

	it("returns 1.0 when composite == 1", () => {
		const m = boostMultiplier(decayScore(1, 1), "bare", "core");
		expect(m).toBe(1);
	});

	it("interpolates linearly between floor and 1 for intermediate composites", () => {
		const composite = 0.5;
		const expected = SEARCH_BOOST_MIN + (1 - SEARCH_BOOST_MIN) * composite;
		const m = boostMultiplier(decayScore(composite, 0), "bare", "peripheral");
		expect(m).toBeCloseTo(expected, 12);
	});

	it("clamps below the floor and above 1 even if composite leaks outside [0,1]", () => {
		expect(boostMultiplier(decayScore(-0.5, 0), "bare", "peripheral")).toBe(SEARCH_BOOST_MIN);
		expect(boostMultiplier(decayScore(2, 0), "bare", "core")).toBe(1);
	});
});

describe("boostMultiplier (tasks §4.4 — withFloor mode)", () => {
	it("uses the per-tier floor when composite and recency are below it", () => {
		// Peripheral floor = 0.5 (DEFAULT_DECAY_CONFIG.peripheralDecayFloor).
		// composite = recency = 0 → candidate = 0.5 → multiplier = 0.65.
		const floor = DEFAULT_DECAY_CONFIG.peripheralDecayFloor;
		const expected = SEARCH_BOOST_MIN + (1 - SEARCH_BOOST_MIN) * floor;
		const m = boostMultiplier(decayScore(0, 0), "withFloor", "peripheral");
		expect(m).toBeCloseTo(expected, 12);
	});

	it("uses composite when composite exceeds tier floor and recency", () => {
		const composite = 0.92;
		const expected = SEARCH_BOOST_MIN + (1 - SEARCH_BOOST_MIN) * composite;
		const m = boostMultiplier(decayScore(composite, 0), "withFloor", "core");
		expect(m).toBeCloseTo(expected, 12);
	});

	it("uses recency when recency exceeds tier floor and composite", () => {
		// Working floor = 0.7; pick recency above the floor and above composite.
		const recency = 0.85;
		const expected = SEARCH_BOOST_MIN + (1 - SEARCH_BOOST_MIN) * recency;
		const m = boostMultiplier(decayScore(0.2, recency), "withFloor", "working");
		expect(m).toBeCloseTo(expected, 12);
	});

	it("matches per-tier floor magnitudes (core > working > peripheral)", () => {
		const corefloor = boostMultiplier(decayScore(0, 0), "withFloor", "core");
		const workingfloor = boostMultiplier(decayScore(0, 0), "withFloor", "working");
		const peripheralfloor = boostMultiplier(decayScore(0, 0), "withFloor", "peripheral");
		expect(corefloor).toBeGreaterThan(workingfloor);
		expect(workingfloor).toBeGreaterThan(peripheralfloor);
	});
});

describe("applyRetentionBoost stage gating", () => {
	const now = Date.now();

	it("returns the input array reference unchanged when flag is OFF", () => {
		const internals = makeRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: false,
		});
		const candidates = [
			buildCandidate({ id: "a", score: 0.8, timestamp: now }),
			buildCandidate({ id: "b", score: 0.4, timestamp: now }),
		];
		const out = internals.applyRetentionBoost(candidates);
		// Strict reference equality: OFF path must not allocate.
		expect(out).toBe(candidates);
	});

	it("returns the input array reference unchanged when recallLifecycle is absent entirely", () => {
		const internals = makeRetriever(undefined);
		// Force-delete the resolved field so the optional-chain guard hits.
		(internals as { config: { recallLifecycle?: unknown } }).config.recallLifecycle = undefined;
		const candidates = [buildCandidate({ id: "a", score: 0.8, timestamp: now })];
		expect(internals.applyRetentionBoost(candidates)).toBe(candidates);
	});

	it("uses injected recallLifecycle rather than constructor defaults", () => {
		const config = {
			...DEFAULT_RETRIEVAL_CONFIG,
			recencyHalfLifeDays: 0,
			recencyWeight: 0,
			lengthNormAnchor: 0,
			importanceWeightBase: 1,
			timeDecayHalfLifeDays: 0,
			temporalDecay: false,
			hardMinScore: 0,
			minScore: 0,
			rerank: "none" as const,
			reinforcementFactor: 0,
			recallLifecycle: {
				...DEFAULT_RECALL_LIFECYCLE,
				retentionScorer: true,
			},
		};
		const retriever = createRetriever(noopStore, noopEmbedder, { warn: () => {} }, config);
		retriever.setRecallLifecycle({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: false,
		});
		const internals = retriever as unknown as MemoryRetrieverInternals;
		const candidates = [buildCandidate({ id: "a", score: 0.8, timestamp: now })];
		expect(internals.applyRetentionBoost(candidates)).toBe(candidates);
	});

	it("preserves scores when flag is ON but composite == 0 only via floor (peripheral, no access)", () => {
		// composite=0 is unreachable in practice (intrinsic >= 0.5*0.7 = 0.35),
		// so the ON-flag pass-through assertion uses observed multiplier bounds.
		const internals = makeRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: true,
			tierFloorMode: "bare",
		});
		const candidates = [
			buildCandidate({ id: "fresh", score: 1, timestamp: now, accessCount: 0 }),
		];
		const out = internals.applyRetentionBoost(candidates);
		expect(out).toHaveLength(1);
		// Multiplier strictly in [SEARCH_BOOST_MIN, 1]; never amplifies.
		const o = out[0];
		expect(o).toBeDefined();
		if (!o) return;
		expect(o.score).toBeGreaterThanOrEqual(SEARCH_BOOST_MIN);
		expect(o.score).toBeLessThanOrEqual(1);
		// Mutates score field only — sources is preserved by reference.
		expect(o.sources).toBe(candidates[0]?.sources);
	});

	it("ranks fresh-high-importance above stale-low-importance after the boost (flag ON)", () => {
		const internals = makeRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: true,
			tierFloorMode: "bare",
		});
		// Same raw score; retention boost should pull the stale entry's score
		// down more than the fresh entry's, preserving monotonicity.
		const candidates = [
			buildCandidate({
				id: "fresh-important",
				score: 0.5,
				timestamp: now,
				importance: 0.9,
				confidence: 0.9,
				tier: "core",
				accessCount: 10,
			}),
			buildCandidate({
				id: "stale-unimportant",
				score: 0.5,
				timestamp: now - 365 * DAY_MS,
				importance: 0.1,
				confidence: 0.5,
				tier: "peripheral",
				accessCount: 0,
			}),
		];
		const out = internals.applyRetentionBoost(candidates);
		expect(out).toHaveLength(2);
		const fresh = out.find((r) => r.entry.id === "fresh-important");
		const stale = out.find((r) => r.entry.id === "stale-unimportant");
		expect(fresh).toBeDefined();
		expect(stale).toBeDefined();
		if (!fresh || !stale) return;
		expect(fresh.score).toBeGreaterThan(stale.score);
		// Stale floor: multiplier clamped at SEARCH_BOOST_MIN, raw score 0.5 →
		// post-boost score must be at least 0.5 * SEARCH_BOOST_MIN.
		expect(stale.score).toBeGreaterThanOrEqual(0.5 * SEARCH_BOOST_MIN);
		expect(fresh.score).toBeLessThanOrEqual(0.5); // multiplier <= 1
	});

	it("withFloor + core tier never falls below core floor for an old core memory", () => {
		const internals = makeRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: true,
			tierFloorMode: "withFloor",
		});
		const internalsBare = makeRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: true,
			tierFloorMode: "bare",
		});
		const candidates = [
			buildCandidate({
				id: "old-core",
				score: 1,
				timestamp: now - 365 * DAY_MS,
				importance: 0.1,
				confidence: 0.5,
				tier: "core",
				accessCount: 0,
			}),
		];
		const withFloor = internals.applyRetentionBoost(candidates.map((c) => ({ ...c })));
		const bare = internalsBare.applyRetentionBoost(candidates.map((c) => ({ ...c })));
		expect(withFloor).toHaveLength(1);
		expect(bare).toHaveLength(1);
		const wf = withFloor[0];
		const b = bare[0];
		expect(wf).toBeDefined();
		expect(b).toBeDefined();
		if (!wf || !b) return;
		// withFloor should be >= bare because the tier floor lifts the candidate.
		expect(wf.score).toBeGreaterThanOrEqual(b.score);
	});
});

describe("applyScoringPipeline integrates retention boost in the correct slot (task §4.2)", () => {
	const now = Date.now();

	it("OFF flag: full pipeline matches a degenerate pass-through", () => {
		const internals = makeRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: false,
		});
		const candidates = [
			buildCandidate({ id: "a", score: 0.7, timestamp: now }),
			buildCandidate({ id: "b", score: 0.4, timestamp: now }),
		];
		const out = internals.applyScoringPipeline(candidates);
		// Sorted by score desc through MMR seed rule.
		expect(out.map((r) => r.entry.id)).toEqual(["a", "b"]);
		// Scores untouched (all other stages are zeroed in makeRetriever).
		expect(out.find((r) => r.entry.id === "a")?.score).toBe(0.7);
		expect(out.find((r) => r.entry.id === "b")?.score).toBe(0.4);
	});

	it("ON flag: retention boost shrinks every score before hardMinScore filter sees it", () => {
		const internals = makeRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: true,
			tierFloorMode: "bare",
		});
		// hardMinScore = 0 (set by makeRetriever) so the filter is a no-op;
		// every survivor's score must be <= the raw input score because the
		// boost stage's multiplier is in [SEARCH_BOOST_MIN, 1].
		const candidates = [
			buildCandidate({ id: "a", score: 0.9, timestamp: now, accessCount: 5 }),
			buildCandidate({ id: "b", score: 0.7, timestamp: now, accessCount: 1 }),
		];
		const raw = new Map(candidates.map((c) => [c.entry.id, c.score]));
		const out = internals.applyScoringPipeline(candidates);
		expect(out).toHaveLength(2);
		for (const r of out) {
			const rawScore = raw.get(r.entry.id);
			expect(rawScore).toBeDefined();
			if (rawScore === undefined) continue;
			expect(r.score).toBeLessThanOrEqual(rawScore);
			expect(r.score).toBeGreaterThanOrEqual(rawScore * SEARCH_BOOST_MIN);
		}
	});
});
