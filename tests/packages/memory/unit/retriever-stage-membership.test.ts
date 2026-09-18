/**
 * Proves each stage record names WHICH memories survived it, not just how many.
 *
 * Counts and `droppedIds` alone cannot place a required memory at every stage, so a stage
 * record fabricated by copying the final served ids backward through the pipeline reads as
 * valid. These assertions make that fabrication fail: a candidate pool larger than what
 * survives leaves the first stage and the last stage holding different members, and the
 * per-stage `outputIds` is what records the difference.
 */

import { describe, expect, it } from "vitest";
import {
	MemoryRetriever,
	type MemoryRetrieverInternals,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import { TraceCollector } from "../../../../packages/sno-station-mem/src/engine/retrieval/retrieval-trace.ts";
import type { RetrievalResult } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

function buildResult(id: string, score: number): RetrievalResult {
	return {
		entry: {
			id,
			text: `text-${id}`,
			category: "episodic",
			lane: "active",
			projectId: "global",
			importance: 1,
			timestamp: Date.now(),
			metadata: "",
			contentHash: `hash-${id}`,
		},
		score,
		sources: { vector: { score, rank: 1 } },
	};
}

/**
 * The pipeline calls its own stage methods through `this`, so the harness has to be the real
 * prototype with only the two collaborators stubbed.
 */
function makeInternals(config: Record<string, unknown>): MemoryRetrieverInternals {
	const internals = Object.create(MemoryRetriever.prototype) as Record<string, unknown>;
	internals["config"] = config;
	internals["store"] = { getVectorsByIds: () => new Map<string, Float32Array>() };
	return internals as unknown as MemoryRetrieverInternals;
}

// A floor high enough that the weak half of the pool cannot reach the served set.
const POOL_EXCEEDS_SERVE_LIMIT = {
	temporalWeighting: true,
	recencyHalfLifeDays: 30,
	recencyWeight: 0.1,
	lengthNormAnchor: 500,
	timeDecayHalfLifeDays: 60,
	hardMinScore: 0.4,
	mmrLambda: 0.7,
	recallLifecycle: { retentionScorer: false },
};

describe("every stage record names its surviving members", () => {
	it("records outputIds for each stage, agreeing with that stage's outputCount", () => {
		const trace = new TraceCollector();
		const pool = [0.95, 0.9, 0.85, 0.8, 0.2, 0.15, 0.1, 0.05].map((score, index) =>
			buildResult(`m${index}`, score),
		);
		makeInternals(POOL_EXCEEDS_SERVE_LIMIT).applyScoringPipeline(pool, trace);

		const stages = trace.finalize("q", "precision-recall").stages;
		expect(stages.length).toBeGreaterThan(0);
		for (const stage of stages) {
			expect(stage.outputIds).toHaveLength(stage.outputCount);
		}
	});

	it("leaves the first stage and the final slice holding different members", () => {
		const trace = new TraceCollector();
		const pool = [0.95, 0.9, 0.85, 0.8, 0.2, 0.15, 0.1, 0.05].map((score, index) =>
			buildResult(`m${index}`, score),
		);
		makeInternals(POOL_EXCEEDS_SERVE_LIMIT).applyScoringPipeline(pool, trace);

		const stages = trace.finalize("q", "precision-recall").stages;
		const firstStage = stages[0];
		const finalStage = stages.at(-1);
		if (!firstStage || !finalStage) throw new Error("the pipeline recorded no stages");

		// The record a backward copy would have produced: every stage carrying the served ids.
		expect(finalStage.outputIds.length).toBeLessThan(firstStage.outputIds.length);
		expect(new Set(firstStage.outputIds)).not.toEqual(new Set(finalStage.outputIds));
		for (const id of finalStage.outputIds) {
			expect(firstStage.outputIds).toContain(id);
		}
	});
});
