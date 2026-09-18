/** @file retriever-scoring-pipeline.ts
 * @purpose Applies post-retrieval scoring, decay, noise, and diversity transforms.
 * @boundary Prototype-mounted MemoryRetriever methods; no constructor state ownership.
 */

import { experimentMmrDisabled } from "../../../config/index";
import {
	createRetentionScorer,
	DEFAULT_DECAY_CONFIG,
} from "../operations/selective-forgetting-scorer";
import { dotProduct } from "./retrieval-scoring-utils";
import type { TraceCollector } from "./retrieval-trace";
import { MemoryRetriever, type MemoryRetrieverInternals } from "./retriever-core";
import type { RetrievalResult } from "./retriever-dependencies";
import {
	clamp01,
	computeEffectiveHalfLife,
	IMPORTANCE_WEIGHT_BASE,
	MMR_LAMBDA,
	parseAccessMetadata,
	parseInsightMetadata,
	TEMPORAL_DYNAMIC_HALF_LIFE_DIVISOR,
	TIME_DECAY_FLOOR,
} from "./retriever-dependencies";
import { DEFAULT_MEMORY_TIER, type DecayableMemory, type DecayScore, type MemoryTier } from "../shared/types";

// Pinned per openspec/changes/mem-lifecycle PRD §6.1 — single source of truth
// is `DEFAULT_DECAY_CONFIG.searchBoostMin`. Re-exporting via const here would
// fork the constant; importing keeps D86 arm-comparison math drift-free.
const SEARCH_BOOST_MIN = DEFAULT_DECAY_CONFIG.searchBoostMin;

// Tier-specific recency floors reused by the `withFloor` arm of `boostMultiplier`.
// Values match the Retention Scorer's per-tier decay floors so the boost stage and
// the scorer agree on "how much retention can ever survive at this tier".
function getTierFloor(tier: MemoryTier): number {
	switch (tier) {
		case "core":
			return DEFAULT_DECAY_CONFIG.coreDecayFloor;
		case "working":
			return DEFAULT_DECAY_CONFIG.workingDecayFloor;
		case "peripheral":
			return DEFAULT_DECAY_CONFIG.peripheralDecayFloor;
	}
}

/**
 * Multiplier formula from openspec/changes/mem-lifecycle PRD §4.1 + retention-
 * scoring spec §62. Bounded to `[SEARCH_BOOST_MIN, 1.0]`; never amplifies,
 * only suppresses, so existing scores are an upper bound after the stage.
 *
 * - `bare`: linear interpolation `searchBoostMin + (1 - searchBoostMin) * composite`.
 * - `withFloor`: same shape but the interpolated input is
 *   `max(getTierFloor(tier), composite, recency)` so highly-decayed core
 *   memories cannot fall below the tier floor.
 */
export function boostMultiplier(
	score: DecayScore,
	mode: "bare" | "withFloor",
	tier: MemoryTier,
): number {
	if (mode === "bare") {
		const linear = SEARCH_BOOST_MIN + (1 - SEARCH_BOOST_MIN) * score.composite;
		return Math.min(1, Math.max(SEARCH_BOOST_MIN, linear));
	}
	const candidate = Math.max(getTierFloor(tier), score.composite, score.recency);
	const linear = SEARCH_BOOST_MIN + (1 - SEARCH_BOOST_MIN) * candidate;
	return Math.min(1, Math.max(SEARCH_BOOST_MIN, linear));
}

/**
 * Adapt a `RetrievalResult.entry` into the `DecayableMemory` shape the
 * Retention Scorer consumes. `MemoryEntry` lacks `tier`, `confidence`,
 * `accessCount`, `lastAccessedAt`, and `createdAt` as native columns; all
 * five come out of the same metadata JSON the rest of the scoring pipeline
 * already parses via `parseInsightMetadata` + `parseAccessMetadata`.
 *
 * `createdAt` maps to `entry.timestamp` because `MemoryStore.store` writes
 * the caller-provided `timestamp` (or `Date.now()`) into both the entry row
 * and the embedding's creation time — there is no separate `created_at`.
 */
function toDecayableMemory(entry: RetrievalResult["entry"]): DecayableMemory {
	const insight = parseInsightMetadata(entry.metadata, entry);
	const access = parseAccessMetadata(entry.metadata);
	const tier: MemoryTier = insight.tier ?? DEFAULT_MEMORY_TIER;
	const memory: DecayableMemory = {
		id: entry.id,
		importance: entry.importance,
		confidence: insight.confidence,
		tier,
		accessCount: access.accessCount,
		createdAt: entry.timestamp,
		lastAccessedAt: access.lastAccessedAt > 0 ? access.lastAccessedAt : entry.timestamp,
	};
	if (insight.memory_temporal_type !== undefined) {
		memory.temporalType = insight.memory_temporal_type;
	}
	if (entry.metadata !== undefined) {
		memory.metadata = entry.metadata;
	}
	return memory;
}

/**
 * Run one stage of the scoring pipeline and record what it did.
 *
 * Every stage mutates scores or removes candidates, and until 2026-08-26 not one of them left
 * a trace — so a memory that reached the model and lost, and a memory some stage quietly
 * dropped, were indistinguishable after the fact. `skipReason` matters just as much: a stage
 * disabled by config returns its input untouched, which looks identical to a stage that ran
 * and changed nothing. Ported from the upstream reference's `stageCounts` + `buildDropSummary`
 * (memory-memory-lancedb-pro/src/retriever.ts:655, :303).
 */
function tracedStage(
	trace: TraceCollector | undefined,
	name: string,
	skipReason: string | undefined,
	run: (input: RetrievalResult[]) => RetrievalResult[],
	input: RetrievalResult[],
): RetrievalResult[] {
	if (!trace) return run(input);
	trace.startStage(
		name,
		input.map((result) => result.entry.id),
	);
	const output = run(input);
	trace.endStage(
		output.map((result) => result.entry.id),
		output.map((result) => result.score),
		skipReason === undefined ? undefined : { skipped: skipReason },
	);
	return output;
}

Object.assign(MemoryRetriever.prototype, {
	applyScoringPipeline(
		this: MemoryRetrieverInternals,
		results: RetrievalResult[],
		trace?: TraceCollector,
		limit: number = results.length,
	): RetrievalResult[] {
		// Run every score-mutating stage first so the hardMinScore filter sees the final
		// per-result score. This keeps two contracts honest: (1) the returned set always
		// satisfies `score >= hardMinScore` even after multiplicative shrinkers like
		// time-decay and length-norm, and (2) additive boosts (recency) get a chance to
		// lift a near-miss above the floor instead of being discarded too early.
		const stage = (
			name: string,
			skipReason: string | undefined,
			run: (input: RetrievalResult[]) => RetrievalResult[],
			input: RetrievalResult[],
		): RetrievalResult[] => tracedStage(trace, name, skipReason, run, input);

		const temporalOff = !this.config.temporalWeighting;
		let scored = stage(
			"recency_boost",
			temporalOff ? "temporalWeighting" : this.config.recencyHalfLifeDays <= 0
				? "recencyHalfLifeDays"
				: this.config.recencyWeight <= 0
					? "recencyWeight"
					: undefined,
			(input) => temporalOff ? input : this.applyRecencyBoost(input),
			results,
		);
		scored = stage(
			"importance_weight",
			undefined,
			(input) => this.applyImportanceWeight(input),
			scored,
		);
		scored = stage(
			"length_normalization",
			this.config.lengthNormAnchor <= 0 ? "lengthNormAnchor" : undefined,
			(input) => this.applyLengthNormalization(input),
			scored,
		);
		scored = stage(
			"time_decay",
			temporalOff ? "temporalWeighting" : this.config.timeDecayHalfLifeDays <= 0 ? "timeDecayHalfLifeDays" : undefined,
			(input) => temporalOff ? input : this.applyTimeDecay(input),
			scored,
		);
		// Retention Scorer multiplier (openspec/changes/mem-lifecycle PRD §4.1).
		// Slot picked per §4.1: after time-decay so the retention recency
		// component layers on top of the time-decay multiplier, and before
		// hardMinScore so retention-suppressed entries can drop out before
		// MMR sees them. Pass-through when `recallLifecycle.retentionScorer`
		// is off — the OFF path returns the input array reference unchanged.
		scored = stage(
			"retention_boost",
			temporalOff ? "temporalWeighting" : this.config.recallLifecycle?.retentionScorer === true
				? undefined
				: "recallLifecycle.retentionScorer",
			(input) => temporalOff ? input : this.applyRetentionBoost(input),
			scored,
		);
		scored = stage(
			"hard_min_score",
			undefined,
			(input) => input.filter((result) => result.score >= this.config.hardMinScore),
			scored,
		);
		// MMR ordering is the final ranking; do not re-sort after diversification.
		// The block 210 experiment override turns the stage into a pass-through and says so
		// in the stage record, so a run with MMR off is distinguishable from one where MMR
		// ran and reordered nothing. Unset in every ordinary run, including production.
		const mmrOff = experimentMmrDisabled();
		scored = stage(
			"mmr_diversity",
			mmrOff ? "experiment.disableMmr" : undefined,
			(input) => {
				if (mmrOff) return input;
				if (!this.config.mmrWindowOnly) return this.applyMmrDiversity(input);
				const windowIds = new Set(results.slice(0, limit).map((result) => result.entry.id));
				const window = input.filter((result) => windowIds.has(result.entry.id));
				const tail = input.filter((result) => !windowIds.has(result.entry.id));
				return [...this.applyMmrDiversity(window), ...tail];
			},
			scored,
		);
		return scored;
	},

	applyRecencyBoost(this: MemoryRetrieverInternals, results: RetrievalResult[]): RetrievalResult[] {
		// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
		if (this.config.recencyHalfLifeDays <= 0 || this.config.recencyWeight <= 0) {
			return results;
		}
		const now = Date.now();
		const halfLifeMs = this.config.recencyHalfLifeDays * 24 * 60 * 60 * 1000;
		return results.map((result) => {
			const ageMs = Math.max(0, now - result.entry.timestamp);
			// Compute the normalized decay once so later retrieval scoring checks use one value.
			const decay = Math.exp((-Math.log(2) * ageMs) / halfLifeMs);
			return {
				...result,
				score: result.score + decay * this.config.recencyWeight,
			};
		});
	},

	applyImportanceWeight(
		this: MemoryRetrieverInternals,
		results: RetrievalResult[],
	): RetrievalResult[] {
		const base = this.config.importanceWeightBase ?? IMPORTANCE_WEIGHT_BASE;
		return results.map((result) => ({
			...result,
			score: result.score * (base + (1 - base) * result.entry.importance),
		}));
	},

	applyLengthNormalization(
		this: MemoryRetrieverInternals,
		results: RetrievalResult[],
	): RetrievalResult[] {
		// Branch on configuration before selecting the runtime strategy.
		if (this.config.lengthNormAnchor <= 0) {
			return results;
		}
		return results.map((result) => {
			const length = result.entry.text.length;
			const ratio = Math.max(1, length / this.config.lengthNormAnchor);
			const normalization = 1 / (1 + 0.5 * Math.log2(ratio));
			return { ...result, score: result.score * normalization };
		});
	},

	applyTimeDecay(this: MemoryRetrieverInternals, results: RetrievalResult[]): RetrievalResult[] {
		// Branch on configuration before selecting the runtime strategy.
		if (this.config.timeDecayHalfLifeDays <= 0) {
			return results;
		}
		const floor = this.config.timeDecayFloor ?? TIME_DECAY_FLOOR;
		const now = Date.now();
		const baseHalfLifeDays = this.config.timeDecayHalfLifeDays;
		const reinforcementFactor = this.config.reinforcementFactor ?? 0.5;
		const maxMultiplier = this.config.maxHalfLifeMultiplier ?? 3;

		return results.map((result) => {
			// Frequently accessed memories decay more slowly.
			const access = parseAccessMetadata(result.entry.metadata);

			// Dynamic memories decay faster when temporal decay is enabled.
			const meta = parseInsightMetadata(result.entry.metadata, result.entry);
			const adjustedBase =
				this.config.temporalDecay && meta.memory_temporal_type === "dynamic"
					? baseHalfLifeDays / TEMPORAL_DYNAMIC_HALF_LIFE_DIVISOR
					: baseHalfLifeDays;

			const effectiveHalfLifeDays = computeEffectiveHalfLife(
				adjustedBase,
				access.accessCount,
				access.lastAccessedAt,
				reinforcementFactor,
				maxMultiplier,
				now,
			);

			const halfLifeMs = effectiveHalfLifeDays * 24 * 60 * 60 * 1000;
			const ageMs = Math.max(0, now - result.entry.timestamp);
			// Keep the decay multiplier bounded to [floor, 1.0].
			const factor = floor + (1 - floor) * Math.exp((-Math.log(2) * ageMs) / halfLifeMs);
			return { ...result, score: result.score * factor };
		});
	},

	applyRetentionBoost(
		this: MemoryRetrieverInternals,
		results: RetrievalResult[],
	): RetrievalResult[] {
		const lifecycle = this._recallLifecycle;
		// Flag off → return the input array reference unchanged (no `.map`,
		// no allocation), so the OFF path is an exact no-op on the pipeline.
		if (lifecycle?.retentionScorer !== true) {
			return results;
		}
		if (this._retentionScorer === undefined) {
			this._retentionScorer = createRetentionScorer();
		}
		const scorer = this._retentionScorer;
		const mode = lifecycle.tierFloorMode;
		const now = Date.now();
		return results.map((result) => {
			const decayable = toDecayableMemory(result.entry);
			const score = scorer.score(decayable, now);
			const multiplier = boostMultiplier(score, mode, decayable.tier);
			return { ...result, score: result.score * multiplier };
		});
	},

	applyMmrDiversity(this: MemoryRetrieverInternals, results: RetrievalResult[]): RetrievalResult[] {
		// The greedy loop below handles every n correctly: n=0 returns []; n=1 seeds and exits;
		// n>=2 runs full MMR. An earlier `n<=2` short-circuit returned the input unsorted, which
		// broke the "seed is highest-scored" contract for n=2 and dropped the mmrScore stamp.
		if (results.length === 0) return results;
		const lambda = this.config.mmrLambda ?? MMR_LAMBDA;

		// Single batched fetch over all candidate chunk vectors so MMR
		// inner-loop is O(N²) cosine over Float32Arrays, not O(N²) DB calls.
		const chunkIds = results.map((r) => r.chunkId).filter((id): id is string => id !== undefined);
		const vectorMap =
			chunkIds.length > 0 ? this.store.getVectorsByIds(chunkIds) : new Map<string, Float32Array>();

		// Sort by current score before MMR so the greedy seed is the highest-scored result
		const sorted = [...results].sort((a, b) => {
			const diff = b.score - a.score;
			if (diff !== 0) return diff;
			return a.entry.id.localeCompare(b.entry.id);
		});

		// Normalize relevance to [0,1] (batch-max) before mixing with `maxSim`, which is
		// already a true cosine in [0,1]. The upstream shrinker chain (importance,
		// length-norm, time-decay, retention) routinely compresses `.score` to ~0.03-0.06
		// for a well-aged memory; without this normalization the diversity term dominates
		// by roughly an order of magnitude and MMR stops ranking by relevance at all
		// (confirmed 2026-07-05 scoring-pipeline audit). Sort order / seed pick are
		// unaffected (dividing by a positive constant preserves order).
		const maxScore = Math.max(sorted[0]?.score ?? 0, 1e-9);

		const n = sorted.length;
		// Pre-resolve vectors aligned to `sorted` so the inner loop never touches the Map.
		const vectors: (Float32Array | undefined)[] = new Array(n);
		for (let i = 0; i < n; i += 1) {
			const id = sorted[i]?.chunkId;
			vectors[i] = id ? vectorMap.get(id) : undefined;
		}

		// Unknown similarity is NOT zero. Zero is the value that means "similar to nothing
		// already selected" — maximally novel — so reading an uncomputable similarity as zero
		// hands the largest possible diversity bonus to exactly the candidates we know least
		// about, promoting them over candidates whose similarity was actually measured. The
		// failure is silent: nothing throws, and the only symptom is a quietly worse ranking.
		// (Adversarial review 2026-08-26, severity high.)
		//
		// Uncomparable candidates keep their relevance slots. Comparable candidates still use
		// those slots for MMR, so one expected BM25-only result does not disable diversity for
		// the rest of the batch or receive an unearned novelty bonus.
		const comparableIndices = vectors.flatMap((vector, index) => (vector ? [index] : []));
		const firstComparableIndex = comparableIndices[0];
		const dimension =
			firstComparableIndex === undefined ? undefined : vectors[firstComparableIndex]?.length;
		const dimensionsMatch =
			dimension !== undefined &&
			comparableIndices.every((index) => vectors[index]?.length === dimension);
		if (firstComparableIndex === undefined || !dimensionsMatch || comparableIndices.length < 2) {
			return sorted.map((result) => ({ ...result, mmrScore: result.score / maxScore }));
		}

		// Incremental MMR: maintain maxSim[i] = max cosine between candidate i and any selected item.
		// Update only when a new item joins `selected`, so total work is O(n²) similarity ops instead
		// of O(n³) (recomputing every pair per outer iteration).
		const maxSim = new Float64Array(n);
		const taken = new Uint8Array(n);
		const selected: RetrievalResult[] = [];

		// Seed: highest-scored comparable entry.
		const seed = sorted[firstComparableIndex];
		if (!seed) return selected;
		taken[firstComparableIndex] = 1;
		// Stamp on the same normalized scale as every other selected item's
		// mmrScore below. It is 1.0 unless a higher-scored result has no vector.
		// stamping the raw un-normalized score here made rank-1 report the
		// lowest mmr_score of the whole set in telemetry (host-reviewer, 2026-07-05).
		selected.push({ ...seed, mmrScore: seed.score / maxScore });
		let lastAdmitted = firstComparableIndex;

		while (selected.length < comparableIndices.length) {
			// Refresh maxSim for every still-unselected candidate against the last admitted item.
			const justAddedVec = vectors[lastAdmitted];
			if (justAddedVec) {
				for (const i of comparableIndices) {
					if (taken[i] === 1) continue;
					// Narrowing only — the batch guard above already proved every vector is
					// present and of one dimension.
					const v = vectors[i];
					if (!v) continue;
					const sim = clamp01(dotProduct(v, justAddedVec), 0);
					const prev = maxSim[i] ?? 0;
					if (sim > prev) maxSim[i] = sim;
				}
			}

			let bestIndex = -1;
			let bestMmrScore = Number.NEGATIVE_INFINITY;
			// Iterate in sorted order so ties resolve to the first-encountered (highest-ranked) index,
			// matching the original strict `>` comparison over `remaining.entries()`.
			for (const i of comparableIndices) {
				if (taken[i] === 1) continue;
				const candidate = sorted[i];
				if (!candidate) continue;
				const normalizedRelevance = candidate.score / maxScore;
				const mmrScore = lambda * normalizedRelevance - (1 - lambda) * (maxSim[i] ?? 0);
				if (mmrScore > bestMmrScore) {
					bestMmrScore = mmrScore;
					bestIndex = i;
				}
			}
			if (bestIndex === -1) break;
			const next = sorted[bestIndex];
			if (!next) break;
			taken[bestIndex] = 1;
			selected.push({ ...next, mmrScore: bestMmrScore });
			lastAdmitted = bestIndex;
		}
		let selectedIndex = 0;
		return sorted.map((result, index) => {
			if (!vectors[index]) return { ...result, mmrScore: result.score / maxScore };
			const diversified = selected[selectedIndex];
			selectedIndex += 1;
			return diversified ?? { ...result, mmrScore: result.score / maxScore };
		});
	},
});
