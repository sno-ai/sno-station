/** @file retrieval-trace.ts
 * @purpose Captures per-query retrieval trace details for debugging ranking decisions.
 * @boundary Candidate scoring, filters, and retriever observability.
 * @see retriever.ts, retrieval-stats.ts, store.ts.
 */

/**
 * Retrieval Trace — Observable pipeline diagnostics
 *
 * Tracks entry IDs through each retrieval stage, computes drops,
 * score ranges, and timing. Zero overhead when not used.
 */

// Types

/**
 * Per-stage structured annotations. Keyed strings only — must survive
 * JSON serialization and downstream aggregation. Used today for the
 * rerank fallback reason; not a freeform diagnostic bag.
 */
export type RetrievalStageMetadata = Readonly<Record<string, string | number | boolean>>;

export interface RetrievalStageResult {
	/** Stage name, e.g. "vector_search", "bm25_search", "rrf_fusion" */
	name: string;
	/** Number of entries entering this stage */
	inputCount: number;
	/** Number of entries surviving this stage */
	outputCount: number;
	/** IDs that were present in input but not in output */
	droppedIds: string[];
	/**
	 * IDs that survived this stage, in the order the stage passed them on.
	 *
	 * `droppedIds` alone cannot place a memory at a stage it never entered, so a stage record
	 * fabricated by copying the final served ids backward reads as valid. This is the field
	 * that makes such a record fail.
	 */
	outputIds: string[];
	/** [min, max] score range of surviving entries, null if no scores */
	scoreRange: [number, number] | null;
	/** Wall-clock duration of this stage in milliseconds */
	durationMs: number;
	/** Optional structured stage annotations (e.g. rerank fallback reason). */
	metadata?: RetrievalStageMetadata;
}

export interface RetrievalTrace {
	/** The original search query */
	query: string;
	/** Retrieval mode used */
	mode: "precision-recall" | "vector" | "aggregation";
	/** Timestamp when retrieval started (epoch ms) */
	startedAt: number;
	/** Per-stage results in pipeline order */
	stages: RetrievalStageResult[];
	/** Number of results after all stages */
	finalCount: number;
	/** Total wall-clock time in milliseconds */
	totalMs: number;
	/**
	 * Phase 0 §9 lifecycle event stream. Absent when `recallLifecycle.traceEnabled`
	 * is off so the trace shape stays bit-exact for existing consumers.
	 */
	lifecycleEvents?: LifecycleTraceEvent[];
}

type RetrievalMode = RetrievalTrace["mode"];

// =============================================================================
// PHASE 0 §9 — Lifecycle trace events
// =============================================================================

/** Retention scorer output for a single memory at scoring time. */
export interface RetentionScoreEvent {
	kind: "retention-score-computed";
	at: number;
	memoryId: string;
	tier: string;
	composite: number;
	multiplier: number;
}

/** Tier-transition evaluation outcome. `to === from` means "no change". */
export interface TierPromotionEvent {
	kind: "tier-promotion-evaluated";
	at: number;
	memoryId: string;
	from: string;
	to: string;
	promoted: boolean;
}

/** Access-tracker update event. `skipped` reflects rate-limit / ceiling gates. */
export interface AccessTrackerEvent {
	kind: "access-tracker-update";
	at: number;
	memoryId: string;
	accessCount: number;
	skipped: boolean;
	reason?: "rate-limited" | "ceiling" | "ok";
}

export type LifecycleTraceEvent =
	| RetentionScoreEvent
	| TierPromotionEvent
	| AccessTrackerEvent;

class StageLifecycle {
	readonly name: string;
	private readonly inputOrder: string[];
	private readonly inputSet: Set<string>;
	private readonly openedAt: number;

	private constructor(name: string, entryIds: string[], openedAt: number) {
		this.name = name;
		this.inputOrder = Array.from(new Set(entryIds));
		this.inputSet = new Set(this.inputOrder);
		this.openedAt = openedAt;
	}

	static open(name: string, entryIds: string[], openedAt: number): StageLifecycle {
		return new StageLifecycle(name, entryIds, openedAt);
	}

	closeUnchanged(closedAt: number): RetrievalStageResult {
		return this.closeWith(this.inputOrder, undefined, closedAt);
	}

	closeWith(
		survivingIds: string[],
		scores: number[] | undefined,
		closedAt: number,
		metadata?: RetrievalStageMetadata,
	): RetrievalStageResult {
		const base: RetrievalStageResult = {
			name: this.name,
			inputCount: this.inputSet.size,
			outputCount: survivingIds.length,
			droppedIds: this.findDroppedIds(survivingIds),
			outputIds: [...survivingIds],
			scoreRange: getScoreRange(scores),
			durationMs: closedAt - this.openedAt,
		};
		return metadata ? { ...base, metadata } : base;
	}

	private findDroppedIds(survivingIds: string[]): string[] {
		const survivors = new Set(survivingIds);
		return this.inputOrder.filter((id) => !survivors.has(id));
	}
}

function getScoreRange(scores: number[] | undefined): [number, number] | null {
	if (!scores || scores.length === 0) return null;

	let min = scores[0] ?? 0;
	let max = min;
	for (const score of scores.slice(1)) {
		if (score < min) min = score;
		if (score > max) max = score;
	}
	return [min, max];
}

function finalOutputCount(stages: readonly RetrievalStageResult[]): number {
	return stages.at(-1)?.outputCount ?? 0;
}

function formatScoreRange(scoreRange: [number, number] | null): string {
	return scoreRange ? ` scores=[${scoreRange[0].toFixed(3)}, ${scoreRange[1].toFixed(3)}]` : "";
}

function formatDroppedIds(droppedIds: string[]): string | null {
	if (droppedIds.length === 0) return null;
	if (droppedIds.length <= 5) return `    dropped: ${droppedIds.join(", ")}`;

	const shown = droppedIds.slice(0, 5).join(", ");
	return `    dropped: ${shown} (+${droppedIds.length - 5} more)`;
}

export interface TraceCollectorOptions {
	/**
	 * Phase 0 §9 toggle — when false (the default) `writeRetentionTrace`,
	 * `writeAccessTrace`, and `writeTierTrace` are no-ops and the finalized
	 * trace omits `lifecycleEvents` entirely (existing format preserved).
	 */
	lifecycleEnabled?: boolean;
}

export class TraceCollector {
	private readonly startedAtMs: number;
	private readonly startedMonotonicMs: number;
	private readonly results: RetrievalStageResult[] = [];
	private readonly lifecycle: LifecycleTraceEvent[] = [];
	private readonly lifecycleEnabled: boolean;
	private activeStage: StageLifecycle | null = null;

	/**
	 * Initializes retrieval tracing collaborators while keeping runtime work in explicit methods.
	 */
	constructor(options?: TraceCollectorOptions) {
		this.startedAtMs = Date.now();
		this.startedMonotonicMs = performance.now();
		this.lifecycleEnabled = options?.lifecycleEnabled === true;
	}

	/**
	 * Begin tracking a pipeline stage.
	 * @param name - Stage identifier (e.g. "vector_search")
	 * @param entryIds - IDs of entries entering this stage
	 */
	startStage(name: string, entryIds: string[]): void {
		this.closeActiveStageAsUnchanged();
		this.activeStage = StageLifecycle.open(name, entryIds, performance.now());
	}

	/**
	 * End the current stage.
	 * @param survivingIds - IDs of entries that survived this stage
	 * @param scores - Optional scores for surviving entries (parallel to survivingIds)
	 * @param metadata - Optional structured annotations attached to this stage
	 */
	endStage(
		survivingIds: string[],
		scores?: number[],
		metadata?: RetrievalStageMetadata,
	): void {
		const stage = this.activeStage;
		if (!stage) return;

		this.results.push(stage.closeWith(survivingIds, scores, performance.now(), metadata));
		this.activeStage = null;
	}

	/**
	 * Finalize the trace and produce the complete RetrievalTrace object.
	 */
	finalize(query: string, mode: RetrievalMode): RetrievalTrace {
		this.closeActiveStageAsUnchanged();

		const base: RetrievalTrace = {
			query,
			mode,
			startedAt: this.startedAtMs,
			stages: this.results,
			finalCount: finalOutputCount(this.results),
			totalMs: performance.now() - this.startedMonotonicMs,
		};
		// Preserve the pre-Phase-0 shape when the lifecycle channel is off — the
		// extra key would otherwise leak into existing serializers.
		if (this.lifecycleEnabled && this.lifecycle.length > 0) {
			return { ...base, lifecycleEvents: this.lifecycle };
		}
		return base;
	}

	/** Append a retention-scorer outcome to the lifecycle stream. */
	writeRetentionTrace(event: Omit<RetentionScoreEvent, "kind" | "at">): void {
		if (!this.lifecycleEnabled) return;
		this.lifecycle.push({ kind: "retention-score-computed", at: Date.now(), ...event });
	}

	/** Append an access-tracker update to the lifecycle stream. */
	writeAccessTrace(event: Omit<AccessTrackerEvent, "kind" | "at">): void {
		if (!this.lifecycleEnabled) return;
		this.lifecycle.push({ kind: "access-tracker-update", at: Date.now(), ...event });
	}

	/** Append a tier-promotion evaluation outcome to the lifecycle stream. */
	writeTierTrace(event: Omit<TierPromotionEvent, "kind" | "at">): void {
		if (!this.lifecycleEnabled) return;
		this.lifecycle.push({ kind: "tier-promotion-evaluated", at: Date.now(), ...event });
	}

	/** Access collected lifecycle events (read-only). */
	get lifecycleEvents(): readonly LifecycleTraceEvent[] {
		return this.lifecycle;
	}

	/**
	 * Produce a human-readable summary of the trace.
	 */
	summarize(): string {
		const lines = [`Retrieval trace (${this.results.length} stages):`];
		for (const stage of this.results) {
			lines.push(
				`  ${stage.name}: ${stage.inputCount} -> ${stage.outputCount} (-${stage.droppedIds.length}) ${stage.durationMs}ms${formatScoreRange(stage.scoreRange)}`,
			);
			const droppedLine = formatDroppedIds(stage.droppedIds);
			if (droppedLine) lines.push(droppedLine);
		}
		lines.push(
			`  total: ${performance.now() - this.startedMonotonicMs}ms, final count: ${finalOutputCount(this.results)}`,
		);
		return lines.join("\n");
	}

	/** Access collected stages (read-only). */
	get stages(): readonly RetrievalStageResult[] {
		return this.results;
	}

	private closeActiveStageAsUnchanged(): void {
		const stage = this.activeStage;
		if (!stage) return;

		this.results.push(stage.closeUnchanged(performance.now()));
		this.activeStage = null;
	}
}
