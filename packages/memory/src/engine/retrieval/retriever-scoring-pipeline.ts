/** @file retriever-scoring-pipeline.ts
 * @purpose Applies post-retrieval importance, length, score-floor, and diversity transforms.
 * @boundary Prototype-mounted MemoryRetriever methods; no constructor state ownership.
 */

import { experimentMmrDisabled } from "../../../config/index";
import { dotProduct } from "./retrieval-scoring-utils";
import type { TraceCollector } from "./retrieval-trace";
import { MemoryRetriever, type MemoryRetrieverInternals } from "./retriever-core";
import type { RetrievalResult } from "./retriever-dependencies";
import {
	clamp01,
	IMPORTANCE_WEIGHT_BASE,
	MMR_LAMBDA,
} from "./retriever-dependencies";

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
	): RetrievalResult[] {
		// Apply score transforms before the floor so it sees the final per-result score.
		const stage = (
			name: string,
			skipReason: string | undefined,
			run: (input: RetrievalResult[]) => RetrievalResult[],
			input: RetrievalResult[],
		): RetrievalResult[] => tracedStage(trace, name, skipReason, run, input);

		let scored = stage(
			"importance_weight",
			undefined,
			(input) => this.applyImportanceWeight(input),
			results,
		);
		scored = stage(
			"length_normalization",
			this.config.lengthNormAnchor <= 0 ? "lengthNormAnchor" : undefined,
			(input) => this.applyLengthNormalization(input),
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
			(input) => (mmrOff ? input : this.applyMmrDiversity(input)),
			scored,
		);
		return scored;
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

		// Batch-max normalization keeps relevance and cosine similarity on comparable scales.
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
