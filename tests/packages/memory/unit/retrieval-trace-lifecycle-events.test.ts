import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TraceCollector } from "../../../../apps/mem-claw/src/retrieval/retrieval-trace.ts";

describe("TraceCollector — Phase 0 §9 lifecycle events", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("omits lifecycleEvents from finalized trace when disabled", () => {
		const trace = new TraceCollector();

		trace.writeRetentionTrace({
			memoryId: "m-1",
			tier: "working",
			composite: 0.8,
			multiplier: 1.0,
		});
		trace.writeAccessTrace({
			memoryId: "m-1",
			accessCount: 5,
			skipped: false,
			reason: "ok",
		});
		trace.writeTierTrace({
			memoryId: "m-1",
			from: "peripheral",
			to: "working",
			promoted: true,
		});

		const finalized = trace.finalize("q", "vector");
		expect(finalized).not.toHaveProperty("lifecycleEvents");
		expect(trace.lifecycleEvents).toEqual([]);
	});

	it("records and finalizes lifecycle events when enabled", () => {
		const trace = new TraceCollector({ lifecycleEnabled: true });

		vi.advanceTimersByTime(3);
		trace.writeRetentionTrace({
			memoryId: "mem-1",
			tier: "core",
			composite: 0.9,
			multiplier: 0.95,
		});
		vi.advanceTimersByTime(2);
		trace.writeAccessTrace({
			memoryId: "mem-1",
			accessCount: 7,
			skipped: true,
			reason: "rate-limited",
		});
		vi.advanceTimersByTime(1);
		trace.writeTierTrace({
			memoryId: "mem-1",
			from: "working",
			to: "core",
			promoted: true,
		});

		const finalized = trace.finalize("q", "precision-recall");
		expect(finalized.lifecycleEvents).toEqual([
			{
				kind: "retention-score-computed",
				at: 2_003,
				memoryId: "mem-1",
				tier: "core",
				composite: 0.9,
				multiplier: 0.95,
			},
			{
				kind: "access-tracker-update",
				at: 2_005,
				memoryId: "mem-1",
				accessCount: 7,
				skipped: true,
				reason: "rate-limited",
			},
			{
				kind: "tier-promotion-evaluated",
				at: 2_006,
				memoryId: "mem-1",
				from: "working",
				to: "core",
				promoted: true,
			},
		]);
	});

	it("preserves existing stage stream shape when lifecycle events are appended", () => {
		const trace = new TraceCollector({ lifecycleEnabled: true });

		trace.startStage("vector_search", ["a", "b"]);
		vi.advanceTimersByTime(5);
		trace.endStage(["a"], [0.8]);
		trace.writeRetentionTrace({
			memoryId: "a",
			tier: "peripheral",
			composite: 0.4,
			multiplier: 0.5,
		});

		const finalized = trace.finalize("q", "vector");
		expect(finalized.stages).toHaveLength(1);
		expect(finalized.stages[0]).toMatchObject({
			name: "vector_search",
			inputCount: 2,
			outputCount: 1,
		});
		expect(finalized.lifecycleEvents).toHaveLength(1);
	});

	it("emits no lifecycleEvents key when enabled but no events were written", () => {
		const trace = new TraceCollector({ lifecycleEnabled: true });

		trace.startStage("vector_search", ["a"]);
		trace.endStage(["a"], [1]);

		const finalized = trace.finalize("q", "vector");
		expect(finalized).not.toHaveProperty("lifecycleEvents");
	});
});
