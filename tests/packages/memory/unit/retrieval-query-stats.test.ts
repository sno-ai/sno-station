import { describe, expect, it } from "vitest";
import { RetrievalStatsCollector } from "../../../../packages/memory/src/engine/retrieval/retrieval-stats.ts";
import type { RetrievalTrace } from "../../../../packages/memory/src/engine/retrieval/retrieval-trace.ts";

function trace(
	totalMs: number,
	finalCount: number,
	stages: RetrievalTrace["stages"] = [],
): RetrievalTrace {
	return {
		query: `query-${totalMs}`,
		mode: "precision-recall",
		startedAt: 1_700_000_000_000,
		stages,
		finalCount,
		totalMs,
	};
}

describe("retrieval stats golden parity", () => {
	it("returns the exact empty aggregate shape", () => {
		const collector = new RetrievalStatsCollector();

		expect(collector.count).toBe(0);
		expect(collector.getStats()).toEqual({
			totalQueries: 0,
			zeroResultQueries: 0,
			avgLatencyMs: 0,
			p95LatencyMs: 0,
			avgResultCount: 0,
			rerankUsed: 0,
			rerankFallbacksByReason: {},
			noiseFiltered: 0,
			queriesBySource: {},
			topDropStages: [],
		});
	});

	it("aggregates fixed traces with stable p95, source, rerank, noise, and drop metrics", () => {
		const collector = new RetrievalStatsCollector();

		collector.recordQuery(
			trace(100, 3, [
				{
					name: "vector_search",
					inputCount: 8,
					outputCount: 5,
					droppedIds: ["a", "b", "c"],
					scoreRange: [0.2, 0.9],
					durationMs: 20,
				},
				{
					name: "noise_filter",
					inputCount: 5,
					outputCount: 4,
					droppedIds: ["d"],
					scoreRange: [0.3, 0.9],
					durationMs: 10,
				},
				{
					name: "rerank",
					inputCount: 4,
					outputCount: 4,
					droppedIds: [],
					scoreRange: [0.4, 0.95],
					durationMs: 30,
				},
			]),
			"manual",
		);
		collector.recordQuery(
			trace(260, 0, [
				{
					name: "bm25_search",
					inputCount: 5,
					outputCount: 0,
					droppedIds: ["e", "f", "g", "h", "i"],
					scoreRange: null,
					durationMs: 40,
				},
				{
					name: "noise_filter",
					inputCount: 0,
					outputCount: 0,
					droppedIds: [],
					scoreRange: null,
					durationMs: 1,
				},
			]),
			"auto-recall",
		);

		expect(collector.count).toBe(2);
		expect(collector.getStats()).toEqual({
			totalQueries: 2,
			zeroResultQueries: 1,
			avgLatencyMs: 180,
			p95LatencyMs: 260,
			avgResultCount: 1.5,
			rerankUsed: 1,
			rerankFallbacksByReason: {},
			noiseFiltered: 1,
			queriesBySource: {
				manual: 1,
				"auto-recall": 1,
			},
			topDropStages: [
				{ name: "bm25_search", totalDropped: 5 },
				{ name: "vector_search", totalDropped: 3 },
				{ name: "noise_filter", totalDropped: 1 },
			],
		});
	});

	it("evicts oldest records at capacity and keeps p95 index semantics stable", () => {
		const collector = new RetrievalStatsCollector(3);

		for (const totalMs of [10, 20, 30, 40, 50]) {
			collector.recordQuery(trace(totalMs, 1), "manual");
		}

		expect(collector.count).toBe(3);
		expect(collector.getStats()).toMatchObject({
			totalQueries: 3,
			avgLatencyMs: 40,
			p95LatencyMs: 50,
			queriesBySource: { manual: 3 },
		});
	});

	it("reset clears records, count, source counts, and top drop stages", () => {
		const collector = new RetrievalStatsCollector();
		collector.recordQuery(
			trace(80, 1, [
				{
					name: "noise_filter",
					inputCount: 2,
					outputCount: 1,
					droppedIds: ["a"],
					scoreRange: [0.7, 0.7],
					durationMs: 3,
				},
			]),
			"manual",
		);

		collector.reset();

		expect(collector.count).toBe(0);
		expect(collector.getStats()).toEqual({
			totalQueries: 0,
			zeroResultQueries: 0,
			avgLatencyMs: 0,
			p95LatencyMs: 0,
			avgResultCount: 0,
			rerankUsed: 0,
			rerankFallbacksByReason: {},
			noiseFiltered: 0,
			queriesBySource: {},
			topDropStages: [],
		});
	});
});
