import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraceCollector } from "../../../../packages/memory/src/engine/retrieval/retrieval-trace.ts";

describe("TraceCollector", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("records stage start, end, and finalize details", () => {
		const trace = new TraceCollector();

		trace.startStage("vector_search", ["a", "b", "c"]);
		vi.advanceTimersByTime(12);
		trace.endStage(["a", "c"], [0.9, 0.4]);
		vi.advanceTimersByTime(8);

		const finalized = trace.finalize("test query", "precision-recall");

		expect(finalized).toMatchObject({
			query: "test query",
			mode: "precision-recall",
			startedAt: 1_000,
			finalCount: 2,
			totalMs: 20,
		});
		expect(finalized.stages).toEqual([
			{
				name: "vector_search",
				inputCount: 3,
				outputCount: 2,
				droppedIds: ["b"],
				outputIds: ["a", "c"],
				scoreRange: [0.4, 0.9],
				durationMs: 12,
			},
		]);
		expect(trace.stages).toBe(finalized.stages);
	});

	it("auto-closes a previous pending stage when a new stage starts", () => {
		const trace = new TraceCollector();

		trace.startStage("first", ["x", "y"]);
		vi.advanceTimersByTime(5);
		trace.startStage("second", ["z"]);
		vi.advanceTimersByTime(7);
		const finalized = trace.finalize("q", "vector");

		expect(finalized.stages).toEqual([
			{
				name: "first",
				inputCount: 2,
				outputCount: 2,
				droppedIds: [],
				outputIds: ["x", "y"],
				scoreRange: null,
				durationMs: 5,
			},
			{
				name: "second",
				inputCount: 1,
				outputCount: 1,
				droppedIds: [],
				outputIds: ["z"],
				scoreRange: null,
				durationMs: 7,
			},
		]);
		expect(finalized.finalCount).toBe(1);
	});

	it("tracks score range and dropped IDs", () => {
		const trace = new TraceCollector();

		trace.startStage("rank", ["a", "b", "c", "d"]);
		vi.advanceTimersByTime(3);
		trace.endStage(["d", "b"], [0.25, 0.75]);

		expect(trace.stages[0]).toMatchObject({
			droppedIds: ["a", "c"],
			scoreRange: [0.25, 0.75],
			durationMs: 3,
		});
	});

	it("propagates stage metadata when endStage is called with it", () => {
		const trace = new TraceCollector();

		trace.startStage("rerank", ["a", "b"]);
		vi.advanceTimersByTime(4);
		trace.endStage(["a", "b"], [0.5, 0.4], {
			rerankFallbackReason: "no_endpoint",
			rerankFallbackProvider: "cohere",
		});

		expect(trace.stages[0]).toMatchObject({
			name: "rerank",
			metadata: {
				rerankFallbackReason: "no_endpoint",
				rerankFallbackProvider: "cohere",
			},
		});
	});

	it("omits the metadata field when none is supplied", () => {
		const trace = new TraceCollector();

		trace.startStage("rerank", ["a"]);
		vi.advanceTimersByTime(1);
		trace.endStage(["a"], [0.9]);

		expect(trace.stages[0]).not.toHaveProperty("metadata");
	});

	it("summarizes the trace without relying on exact whitespace", () => {
		const trace = new TraceCollector();

		trace.startStage("rank", ["a", "b", "c"]);
		vi.advanceTimersByTime(2);
		trace.endStage(["a"], [0.5]);
		vi.advanceTimersByTime(4);

		const summary = trace.summarize();

		expect(summary).toContain("Retrieval trace (1 stages):");
		expect(summary).toContain("rank");
		expect(summary).toContain("3 -> 1");
		expect(summary).toContain("scores=[0.500, 0.500]");
		expect(summary).toContain("dropped: b, c");
		expect(summary).toContain("total: 6ms");
		expect(summary).toContain("final count: 1");
	});
});
