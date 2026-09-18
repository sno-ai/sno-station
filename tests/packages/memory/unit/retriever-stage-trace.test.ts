/**
 * Proves the scoring pipeline records what each stage did.
 *
 * Until 2026-08-26 none of the seven stages left any trace, so a memory that some stage
 * dropped and a memory that reached the model and lost were indistinguishable afterwards —
 * which is why a wrong answer could never be attributed to the stage that removed its
 * evidence. These assertions exist to keep that record from silently disappearing again:
 * a stage that stops calling the collector fails here, not two evals later.
 */

import { describe, expect, it } from "vitest";
import {
	MemoryRetriever,
	type MemoryRetrieverInternals,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import { TraceCollector } from "../../../../packages/sno-station-mem/src/engine/retrieval/retrieval-trace.ts";
import type { RetrievalResult } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

function buildResult(id: string, score: number, text = `text-${id}`): RetrievalResult {
	return {
		entry: {
			id,
			text,
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
 * prototype with only the two collaborators stubbed — a bare object literal silently loses
 * every stage.
 */
function makeInternals(config: Record<string, unknown>): MemoryRetrieverInternals {
	const internals = Object.create(MemoryRetriever.prototype) as Record<string, unknown>;
	internals["config"] = config;
	internals["store"] = { getVectorsByIds: () => new Map<string, Float32Array>() };
	return internals as unknown as MemoryRetrieverInternals;
}

function runPipeline(
	results: RetrievalResult[],
	config: Record<string, unknown>,
	trace: TraceCollector,
): RetrievalResult[] {
	return makeInternals(config).applyScoringPipeline(results, trace);
}

const ALL_ON = {
	temporalWeighting: true,
	recencyHalfLifeDays: 30,
	recencyWeight: 0.1,
	lengthNormAnchor: 500,
	timeDecayHalfLifeDays: 60,
	hardMinScore: 0,
	mmrLambda: 0.7,
	recallLifecycle: { retentionScorer: false },
};

const STAGE_ORDER = [
	"recency_boost",
	"importance_weight",
	"length_normalization",
	"time_decay",
	"retention_boost",
	"hard_min_score",
	"mmr_diversity",
];

describe("the scoring pipeline records every stage", () => {
	it("emits all seven stages, in pipeline order, with real counts", () => {
		const trace = new TraceCollector();
		const results = [buildResult("a", 0.9), buildResult("b", 0.5), buildResult("c", 0.3)];
		runPipeline(results, ALL_ON, trace);

		const stages = trace.finalize("q", "precision-recall").stages;
		expect(stages.map((s) => s.name)).toEqual(STAGE_ORDER);
		// Every stage saw the three candidates and, with no floor, passed all three on.
		for (const stage of stages) {
			expect(stage.inputCount).toBe(3);
			expect(stage.outputCount).toBe(3);
			expect(stage.droppedIds).toEqual([]);
		}
	});

	it("names the memories a stage removed, not just how many", () => {
		const trace = new TraceCollector();
		// A floor above two of the three scores: the floor stage must say WHICH two went.
		runPipeline(
			[buildResult("keep", 0.9), buildResult("cut-1", 0.2), buildResult("cut-2", 0.1)],
			{ ...ALL_ON, recencyWeight: 0, recencyHalfLifeDays: 0, hardMinScore: 0.5 },
			trace,
		);

		const floor = trace
			.finalize("q", "precision-recall")
			.stages.find((s) => s.name === "hard_min_score");
		expect(floor).toBeDefined();
		expect(floor?.inputCount).toBe(3);
		expect(floor?.outputCount).toBe(1);
		expect(floor?.droppedIds.sort()).toEqual(["cut-1", "cut-2"]);
	});

	it("a stage turned off by config says which key turned it off", () => {
		const trace = new TraceCollector();
		runPipeline(
			[buildResult("a", 0.9), buildResult("b", 0.5)],
			{ ...ALL_ON, lengthNormAnchor: 0, timeDecayHalfLifeDays: 0 },
			trace,
		);

		const stages = trace.finalize("q", "precision-recall").stages;
		const byName = new Map(stages.map((s) => [s.name, s]));
		// A disabled stage and a stage that ran and changed nothing look identical in the
		// counts. The reason is the only thing that separates a config mistake from a no-op.
		expect(byName.get("length_normalization")?.metadata?.skipped).toBe("lengthNormAnchor");
		expect(byName.get("time_decay")?.metadata?.skipped).toBe("timeDecayHalfLifeDays");
		expect(byName.get("retention_boost")?.metadata?.skipped).toBe(
			"recallLifecycle.retentionScorer",
		);
		// A stage that really ran carries no skip reason.
		expect(byName.get("importance_weight")?.metadata?.skipped).toBeUndefined();
	});

	it("records nothing and does not throw when no collector is passed", () => {
		const results = [buildResult("a", 0.9), buildResult("b", 0.5)];
		const internals = makeInternals(ALL_ON);
		expect(() => internals.applyScoringPipeline(results)).not.toThrow();
		expect(internals.applyScoringPipeline(results)).toHaveLength(2);
	});
});
