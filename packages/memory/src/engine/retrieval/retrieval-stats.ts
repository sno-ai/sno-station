/** @file retrieval-stats.ts
 * @purpose Tracks bounded retrieval telemetry for diagnostics and adaptive behavior.
 * @boundary Recall requests, result metrics, and runtime observability.
 * @see retriever.ts, retrieval-gate.ts, lru.ts.
 */

/**
 * Retrieval Statistics — Aggregate query metrics
 *
 * Collects per-query traces and produces aggregate statistics
 * for monitoring retrieval quality and performance.
 */

import type { RetrievalTrace } from "./retrieval-trace";

// Types

export interface AggregateStats {
	/** Total number of queries recorded */
	totalQueries: number;
	/** Number of queries that returned zero results */
	zeroResultQueries: number;
	/** Average latency across all queries (ms) */
	avgLatencyMs: number;
	/** 95th percentile latency (ms) */
	p95LatencyMs: number;
	/** Average number of results returned */
	avgResultCount: number;
	/** Number of queries where reranking was applied */
	rerankUsed: number;
	/** Number of queries where noise filter removed results */
	noiseFiltered: number;
	/** Query counts broken down by source */
	queriesBySource: Record<string, number>;
	/** Stages that drop the most entries across all queries */
	topDropStages: { name: string; totalDropped: number }[];
	/**
	 * Counts of rerank stages that degraded to the pre-rerank ordering,
	 * keyed by the {@link RerankFallbackReason} that fired. Absent reasons
	 * are not enumerated — read consumers should treat a missing key as zero.
	 */
	rerankFallbacksByReason: Record<string, number>;
}

// RetrievalStatsCollector

interface QueryRecord {
	trace: RetrievalTrace;
	source: string;
}

type StageDropTotal = {
	name: string;
	totalDropped: number;
};

type StatsAccumulator = {
	totalLatencyMs: number;
	totalResultCount: number;
	zeroResultQueries: number;
	latencies: number[];
	rerankUsed: number;
	noiseFiltered: number;
	queriesBySource: Record<string, number>;
	dropsByStage: Map<string, number>;
	rerankFallbacksByReason: Map<string, number>;
};

function emptyStats(): AggregateStats {
	return {
		totalQueries: 0,
		zeroResultQueries: 0,
		avgLatencyMs: 0,
		p95LatencyMs: 0,
		avgResultCount: 0,
		rerankUsed: 0,
		noiseFiltered: 0,
		queriesBySource: {},
		topDropStages: [],
		rerankFallbacksByReason: {},
	};
}

function emptyAccumulator(): StatsAccumulator {
	return {
		totalLatencyMs: 0,
		totalResultCount: 0,
		zeroResultQueries: 0,
		latencies: [],
		rerankUsed: 0,
		noiseFiltered: 0,
		queriesBySource: {},
		dropsByStage: new Map<string, number>(),
		rerankFallbacksByReason: new Map<string, number>(),
	};
}

function addDrop(total: Map<string, number>, stageName: string, dropped: number): void {
	total.set(stageName, (total.get(stageName) ?? 0) + dropped);
}

function absorbRecord(acc: StatsAccumulator, record: QueryRecord): void {
	const { trace, source } = record;

	acc.totalLatencyMs += trace.totalMs;
	acc.totalResultCount += trace.finalCount;
	acc.latencies.push(trace.totalMs);
	if (trace.finalCount === 0) acc.zeroResultQueries++;

	acc.queriesBySource[source] = (acc.queriesBySource[source] ?? 0) + 1;

	for (const stage of trace.stages) {
		const dropped = stage.inputCount - stage.outputCount;
		if (dropped > 0) addDrop(acc.dropsByStage, stage.name, dropped);
		if (stage.name === "rerank") {
			acc.rerankUsed++;
			const reason = stage.metadata?.rerankFallbackReason;
			// `rerankFallbackReason` is set by the search-mode caller from a
			// closed `RerankFallbackReason` union, so a string at this key is
			// always a known reason; defensive `typeof` keeps a future metadata
			// schema drift from silently breaking the counter.
			if (typeof reason === "string") {
				acc.rerankFallbacksByReason.set(
					reason,
					(acc.rerankFallbacksByReason.get(reason) ?? 0) + 1,
				);
			}
		}
		if (stage.name === "noise_filter" && dropped > 0) acc.noiseFiltered++;
	}
}

function percentile95(latencies: number[]): number {
	const sorted = [...latencies].sort((a, b) => a - b);
	const index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
	return sorted[index] ?? 0;
}

function topDropStages(dropsByStage: Map<string, number>): StageDropTotal[] {
	return [...dropsByStage.entries()]
		.map(([name, totalDropped]) => ({ name, totalDropped }))
		.sort((a, b) => b.totalDropped - a.totalDropped)
		.slice(0, 5);
}

export class RetrievalStatsCollector {
	private readonly _records: QueryRecord[] = [];
	private readonly _maxRecords: number;

	/**
	 * Initializes retrieval telemetry collaborators while keeping runtime work in explicit
	 * methods.
	 */
	constructor(maxRecords = 1000) {
		if (!Number.isInteger(maxRecords) || maxRecords < 0) {
			throw new RangeError("Invalid array length");
		}
		this._maxRecords = maxRecords;
	}

	/**
	 * Record a completed query trace.
	 * @param trace - The finalized retrieval trace
	 * @param source - Query source identifier (e.g. "manual", "auto-recall")
	 */
	recordQuery(trace: RetrievalTrace, source: string): void {
		if (this._maxRecords === 0) return;
		this._records.push({ trace, source });
		const overflow = this._records.length - this._maxRecords;
		if (overflow > 0) this._records.splice(0, overflow);
	}

	/**
	 * Compute aggregate statistics from all recorded queries.
	 */
	getStats(): AggregateStats {
		if (this._records.length === 0) return emptyStats();

		const acc = emptyAccumulator();
		for (const record of this._records) absorbRecord(acc, record);
		const totalQueries = this._records.length;

		return {
			totalQueries,
			zeroResultQueries: acc.zeroResultQueries,
			avgLatencyMs: Math.round(acc.totalLatencyMs / totalQueries),
			p95LatencyMs: percentile95(acc.latencies),
			avgResultCount: Math.round((acc.totalResultCount / totalQueries) * 10) / 10,
			rerankUsed: acc.rerankUsed,
			noiseFiltered: acc.noiseFiltered,
			queriesBySource: acc.queriesBySource,
			topDropStages: topDropStages(acc.dropsByStage),
			rerankFallbacksByReason: Object.fromEntries(acc.rerankFallbacksByReason),
		};
	}

	/**
	 * Reset all collected statistics.
	 */
	reset(): void {
		this._records.length = 0;
	}

	/** Number of recorded queries. */
	get count(): number {
		return this._records.length;
	}
}
