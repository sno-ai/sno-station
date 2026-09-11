import { describe, expect, it } from "vitest";
import { RetrievalStatsCollector } from "../../../../packages/sno-station-mem/src/engine/retrieval/retrieval-stats.ts";
import { TraceCollector } from "../../../../packages/sno-station-mem/src/engine/retrieval/retrieval-trace.ts";

function traceWithRerankFallback(reason?: string) {
	const trace = new TraceCollector();
	trace.startStage("rerank", ["a", "b"]);
	trace.endStage(
		["a", "b"],
		[0.5, 0.4],
		reason
			? { rerankFallbackReason: reason, rerankFallbackProvider: "voyage" }
			: undefined,
	);
	return trace.finalize("q", "precision-recall");
}

describe("RetrievalStatsCollector rerank fallback aggregation", () => {
	it("counts each rerank fallback reason that appears on stage metadata", () => {
		const collector = new RetrievalStatsCollector();

		collector.recordQuery(traceWithRerankFallback("http_error"), "manual");
		collector.recordQuery(traceWithRerankFallback("http_error"), "manual");
		collector.recordQuery(traceWithRerankFallback("invalid_response"), "manual");
		collector.recordQuery(traceWithRerankFallback(), "manual");

		const stats = collector.getStats();
		expect(stats.rerankFallbacksByReason).toEqual({
			http_error: 2,
			invalid_response: 1,
		});
		expect(stats.rerankUsed).toBe(4);
	});

	it("returns an empty fallback map when no rerank stages ran", () => {
		const collector = new RetrievalStatsCollector();
		const trace = new TraceCollector();
		trace.startStage("vector_search", ["a"]);
		trace.endStage(["a"], [0.9]);
		collector.recordQuery(trace.finalize("q", "vector"), "manual");

		const stats = collector.getStats();
		expect(stats.rerankFallbacksByReason).toEqual({});
		expect(stats.rerankUsed).toBe(0);
	});
});
