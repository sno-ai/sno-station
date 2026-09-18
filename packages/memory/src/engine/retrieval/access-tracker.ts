/** @file access-tracker.ts
 * @purpose Tracks memory access signals that feed recency, ranking, and decay decisions.
 * @boundary Memory store metadata and retrieval result identifiers.
 * @see store.ts, retriever.ts, selective-forgetting-scorer.ts, retrieval-stats.ts.
 */

/**
 * Access Tracker
 *
 * Tracks memory access patterns to support reinforcement-based decay.
 * Frequently accessed memories decay more slowly (longer effective half-life).
 */

import { createLogger } from "@snoai/utils/logger";
import { DEFAULT_RECALL_LIFECYCLE, type RecallLifecycleConfig } from "../../../config/index";
import type { MemoryMetadata } from "../shared/types";
import type { MemoryStore } from "../../store/store";

const log = createLogger("sno-station-mem:access-tracker");

// Types

export interface AccessMetadata {
	readonly accessCount: number;
	readonly lastAccessedAt: number;
}

export interface AccessTrackerOptions {
	readonly store: MemoryStore;
	readonly debounceMs?: number;
	readonly recallLifecycle?: RecallLifecycleConfig;
}

// Constants

const MIN_ACCESS_COUNT = 0;
// Legacy hard cap retained for parseAccessMetadata normalization of historical
// rows when the autoRecallAccessTracking flag is OFF (preserves pre-Phase-0
// observable behavior). The Phase 0 §3 hard ceiling is sourced per-instance
// from `recallLifecycle.accessCountCeiling` (PRD §6.1, default 20).
const LEGACY_MAX_ACCESS_COUNT = 10_000;

/** Default debounce interval before flushing pending writes (5 seconds) */
const DEFAULT_DEBOUNCE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_WRITE_FAILURES_PER_ID = 5;

/** Access count itself decays with a 30-day half-life */
const ACCESS_DECAY_HALF_LIFE_DAYS = 30;

// Utility

/** Implements clamp access count as the local access reinforcement metadata operation. */
function clampAccessCount(value: number, ceiling: number = LEGACY_MAX_ACCESS_COUNT): number {
	// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
	if (!Number.isFinite(value)) return MIN_ACCESS_COUNT;
	// Centralize the retrieval scoring fallback value at the boundary of this helper.
	return Math.min(ceiling, Math.max(MIN_ACCESS_COUNT, Math.floor(value)));
}

// Metadata Parsing

/**
 * Parse access-related fields from a metadata JSON string.
 *
 * Handles: undefined, empty string, malformed JSON, negative numbers,
 * numbers exceeding 10000. Always returns a valid AccessMetadata.
 */
// LH: Access state lives in metadata JSON, not dedicated columns, so existing databases can adopt reinforcement without migration.
// LH: Parsing is tolerant because older memories may not contain access fields yet.
// LH: The retriever and decay engine both rely on this shape for access-aware half-life behavior.
export function parseAccessMetadata(
	metadata: string | undefined,
): AccessMetadata & Partial<MemoryMetadata> {
	// Guard metadata here so the remaining retrieval scoring path works with normalized inputs.
	if (metadata === undefined || metadata === "") {
		// Return the normalized access tracking payload expected by callers.
		return { accessCount: 0, lastAccessedAt: 0 };
	}

	let parsed: unknown;
	// Isolate the access tracking operation that can fail because of runtime I/O or input shape.
	try {
		// Parse serialized metadata inside the narrowest block that can recover from bad JSON.
		parsed = JSON.parse(metadata);
	} catch {
		// Return the normalized access tracking payload expected by callers.
		return { accessCount: 0, lastAccessedAt: 0 };
	}

	// Guard parsed here so the remaining retrieval scoring path works with normalized inputs.
	if (typeof parsed !== "object" || parsed === null) {
		return { accessCount: 0, lastAccessedAt: 0 };
	}

	const obj = parsed as Record<string, unknown>;

	// Accept both persisted key styles for backward-compatible metadata reads.
	const rawCountAny = obj.accessCount ?? obj.access_count;
	const rawCount = typeof rawCountAny === "number" ? rawCountAny : Number(rawCountAny ?? 0);

	const rawLastAny = obj.lastAccessedAt ?? obj.last_accessed_at;
	const rawLastAccessed = typeof rawLastAny === "number" ? rawLastAny : Number(rawLastAny ?? 0);

	return {
		accessCount: clampAccessCount(rawCount),
		lastAccessedAt: Number.isFinite(rawLastAccessed) && rawLastAccessed >= 0 ? rawLastAccessed : 0,
	};
}

// Metadata Building

/**
 * Merge an access-count increment into existing metadata JSON.
 *
 * Preserves ALL existing fields in the metadata object — only overwrites
 * `accessCount` and `lastAccessedAt`. Returns a new JSON string.
 */
export function buildUpdatedMetadata(
	existingMetadata: string | undefined,
	accessDelta: number,
	ceiling: number = LEGACY_MAX_ACCESS_COUNT,
): string {
	let existing: Record<string, unknown> = {};

	// Guard existing metadata here so the remaining retrieval scoring path works with normalized inputs.
	if (existingMetadata !== undefined && existingMetadata !== "") {
		// Isolate the access tracking operation that can fail because of runtime I/O or input shape.
		try {
			// Parse serialized metadata inside the narrowest block that can recover from bad JSON.
			const parsed = JSON.parse(existingMetadata);
			// Guard parsed here so the remaining retrieval scoring path works with normalized inputs.
			if (typeof parsed === "object" && parsed !== null) {
				existing = { ...parsed };
			}
		} catch {
			// malformed JSON — start fresh
		}
	}

	const prev = parseAccessMetadata(existingMetadata);
	const newCount = clampAccessCount(prev.accessCount + accessDelta, ceiling);
	const now = Date.now();

	// Serialize metadata once at the boundary so storage receives a stable payload.
	return JSON.stringify({
		...existing,
		// Write both camelCase and snake_case for compatibility.
		accessCount: newCount,
		lastAccessedAt: now,
		access_count: newCount,
		last_accessed_at: now,
	});
}

// Effective Half-Life Computation

/**
 * Compute the effective half-life for a memory based on its access history.
 *
 * The access count itself decays over time (30-day half-life for access
 * freshness), so stale accesses contribute less reinforcement. The extension
 * uses a logarithmic curve (`Math.log1p`) to provide diminishing returns.
 *
 * @param baseHalfLife        - Base half-life in days (e.g. 30)
 * @param accessCount         - Raw number of times the memory was accessed
 * @param lastAccessedAt      - Timestamp (ms) of last access
 * @param reinforcementFactor - Scaling factor for reinforcement (0 = disabled)
 * @param maxMultiplier       - Hard cap: result <= baseHalfLife * maxMultiplier
 * @returns Effective half-life in days
 */
// LH: Effective half-life increases with access evidence so frequently useful memories decay more slowly.
// LH: The formula feeds ranking policy without changing storage schema or mutating tier state.
// LH: Bounds prevent access bursts from making stale memories immortal.
export function computeEffectiveHalfLife(
	baseHalfLife: number,
	accessCount: number,
	lastAccessedAt: number,
	reinforcementFactor: number,
	maxMultiplier: number,
	now: number = Date.now(),
): number {
	// Short-circuit: no reinforcement or no accesses
	if (reinforcementFactor === 0 || accessCount <= 0) {
		return baseHalfLife;
	}

	const daysSinceLastAccess = Math.max(0, (now - lastAccessedAt) / (1000 * 60 * 60 * 24));

	// Access freshness decays exponentially with 30-day half-life
	const accessFreshness = Math.exp(-daysSinceLastAccess * (Math.LN2 / ACCESS_DECAY_HALF_LIFE_DAYS));

	// Effective access count after freshness decay
	const effectiveAccessCount = accessCount * accessFreshness;

	// Logarithmic extension for diminishing returns
	const extension = baseHalfLife * reinforcementFactor * Math.log1p(effectiveAccessCount);

	const result = baseHalfLife + extension;

	// Hard cap
	const cap = baseHalfLife * maxMultiplier;
	return Math.min(result, cap);
}

// AccessTracker Class

/**
 * Debounced write-back tracker for memory access events.
 *
 * `recordAccess()` is synchronous (Map update only, no I/O). Pending deltas
 * accumulate until `flush()` is called (or after debounceMs timeout).
 * On flush, each pending entry is read via `store.getById()`, its metadata
 * is merged with the accumulated access delta, and written back via
 * `store.update()`.
 */
export class AccessTracker {
	private readonly pending: Map<string, number> = new Map();
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private flushPromise: Promise<void> | undefined;
	private readonly debounceMs: number;
	private readonly store: MemoryStore;
	private retryDelayMs: number;
	private readonly writeFailures: Map<string, number> = new Map();
	private destroying = false;
	private readonly recallLifecycle: RecallLifecycleConfig;
	private readonly clampedOnce: Set<string> = new Set();

	/**
	 * Initializes access reinforcement metadata collaborators while keeping runtime work in
	 * explicit methods.
	 */
	constructor(options: AccessTrackerOptions) {
		this.store = options.store;
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.retryDelayMs = this.debounceMs;
		this.recallLifecycle = options.recallLifecycle ?? DEFAULT_RECALL_LIFECYCLE;
	}

	/**
	 * Record one access for each of the given memory IDs.
	 * Synchronous — only updates the in-memory pending map.
	 */
	recordAccess(ids: readonly string[]): void {
		// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
		if (this.destroying) return;
		// Iterate deterministically so access tracking output order remains stable.
		for (const id of ids) {
			const current = this.pending.get(id) ?? 0;
			this.pending.set(id, current + 1);
		}
		this.resetTimer();
	}

	/** Return a snapshot of all pending (id -> delta) entries. */
	getPendingUpdates(): Map<string, number> {
		return new Map(this.pending);
	}

	/**
	 * Flush pending access deltas to the store.
	 *
	 * If a flush is already in progress, awaits the current flush to complete.
	 * If new pending data accumulated during the in-flight flush, a follow-up
	 * flush is automatically triggered.
	 */
	async flush(): Promise<void> {
		this.clearTimer();

		// If a flush is in progress, wait for it to finish
		if (this.flushPromise) {
			await this.flushPromise;
			// Defer retries to the timer path so concurrent flush callers do not recurse.
			if (this.pending.size > 0 && !this.destroying) {
				this.scheduleRetry();
			}
			return;
		}

		// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
		if (this.pending.size === 0) return;

		this.flushPromise = this.doFlush();
		// Isolate the access tracking operation that can fail because of runtime I/O or input shape.
		try {
			await this.flushPromise;
		} finally {
			this.flushPromise = undefined;
		}

		// Guard this.pending.size here so the remaining retrieval scoring path works with normalized inputs.
		if (this.pending.size > 0) {
			// Guard this.destroying here so the remaining retrieval scoring path works with normalized inputs.
			if (!this.destroying) {
				this.scheduleRetry();
			}
			return;
		}

		this.retryDelayMs = this.debounceMs;
	}

	/** Tear down the tracker with one final best-effort flush. */
	async destroy(): Promise<void> {
		this.destroying = true;
		this.clearTimer();

		// Guard guard condition here so the remaining retrieval scoring path works with normalized inputs.
		if (this.flushPromise) {
			await this.flushPromise;
		}

		// Guard this.pending.size here so the remaining retrieval scoring path works with normalized inputs.
		if (this.pending.size > 0) {
			await this.doFlush();
		}

		// Guard this.pending.size here so the remaining retrieval scoring path works with normalized inputs.
		if (this.pending.size > 0) {
			log.warn("destroying with pending writes", {
				pendingCount: this.pending.size,
			}, {
				event_name: "sno_station_mem.access-tracker.destroying.with.pending.writes",
				file: "packages/sno-station-mem/src/engine/retrieval/access-tracker.ts",
				function: "destroy",
				site_id: "access-tracker.destroy.5991e0f580",
			});
		}
		this.pending.clear();
		this.writeFailures.clear();
		this.retryDelayMs = this.debounceMs;
	}

	// Internal helpers

	/**
	 * Flushes all pending deltas in ONE store call (one mutex acquisition + one
	 * transaction), instead of the historical per-id mutex+transaction+full
	 * update() round trip. Policy (rate-limit window, ceiling clamp) stays here,
	 * delivered through per-id delta callbacks; the store only merges and writes.
	 */
	private async doFlush(): Promise<void> {
		const batch = new Map(this.pending);
		this.pending.clear();
		if (batch.size === 0) return;

		try {
			const entries = Array.from(batch).flatMap(([id, delta]) => {
				const memory = this.store.getById(id);
				if (memory?.category !== "episodic") return [];
				return [
					{
						memoryId: id,
						deltaFn: (current: MemoryMetadata) => this.buildAccessDelta(id, delta, current),
					},
				];
			});
			await this.store.applyMetadataDeltas(entries);
			for (const id of batch.keys()) this.writeFailures.delete(id);
		} catch (err) {
			// The batch transaction rolled back as a unit: re-queue every delta,
			// dropping ids that keep failing (same per-id cap as the old path).
			for (const [id, delta] of batch) {
				const failures = (this.writeFailures.get(id) ?? 0) + 1;
				if (failures >= MAX_WRITE_FAILURES_PER_ID) {
					this.writeFailures.delete(id);
					log.warn("dropping access delta after repeated write failures", {
						memory_id: id,
						failures,
						error: err,
					}, {
						event_name: "sno_station_mem.access-tracker.dropping.access.delta.after.repeated.write.failures",
						file: "packages/sno-station-mem/src/engine/retrieval/access-tracker.ts",
						function: "doFlush",
						site_id: "access-tracker.doFlush.b3bb3939f2",
					});
					continue;
				}
				this.writeFailures.set(id, failures);
				this.pending.set(id, (this.pending.get(id) ?? 0) + delta);
			}
			log.warn("access flush batch failed", {
				batchSize: batch.size,
				error: err,
				committed_count: 0,
			}, {
				event_name: "sno_station_mem.access-tracker.access.flush.batch.failed",
				file: "packages/sno-station-mem/src/engine/retrieval/access-tracker.ts",
				function: "doFlush",
				site_id: "access-tracker.doFlush.f82865a307",
			});
		}
	}

	/**
	 * Per-id policy transform executed inside the store's batch transaction.
	 * Returns undefined to skip the write (rate-limited). Both metadata key
	 * styles are written — see the cross-subsystem naming note on
	 * buildUpdatedMetadata.
	 */
	private buildAccessDelta(
		id: string,
		delta: number,
		current: MemoryMetadata,
	): Partial<MemoryMetadata> | undefined {
		const record = current as Record<string, unknown>;
		const rawCount = record.accessCount ?? record.access_count;
		const prevCount = clampAccessCount(
			typeof rawCount === "number" ? rawCount : Number(rawCount ?? 0),
		);
		const rawLast = record.lastAccessedAt ?? record.last_accessed_at;
		const prevLastRaw = typeof rawLast === "number" ? rawLast : Number(rawLast ?? 0);
		const prevLast = Number.isFinite(prevLastRaw) && prevLastRaw >= 0 ? prevLastRaw : 0;
		const now = Date.now();

		// PRD §6.1 hard caps engage only when the autoRecallAccessTracking flag is
		// on (Phase 0 lands the gate, Phase 1+ flips it). With the flag off, the
		// legacy 10_000 ceiling and lack of rate-limit are preserved bit-for-bit.
		let ceiling = LEGACY_MAX_ACCESS_COUNT;
		if (this.recallLifecycle.autoRecallAccessTracking) {
			ceiling = this.recallLifecycle.accessCountCeiling;
			const withinWindow =
				prevLast > 0 && now - prevLast < this.recallLifecycle.accessRateLimitMs;
			if (withinWindow) return undefined;
			if (prevCount > ceiling && !this.clampedOnce.has(id)) {
				this.clampedOnce.add(id);
				log.warn("legacy access count clamped to ceiling", {
					memory_id: id,
					previousCount: prevCount,
					ceiling,
				}, {
					event_name: "sno_station_mem.access-tracker.legacy.access.count.clamped.to.ceiling",
					file: "packages/sno-station-mem/src/engine/retrieval/access-tracker.ts",
					function: "buildAccessDelta",
					site_id: "access-tracker.buildAccessDelta.4ac8f20936",
				});
			}
		}

		const newCount = clampAccessCount(prevCount + delta, ceiling);
		return {
			accessCount: newCount,
			lastAccessedAt: now,
			access_count: newCount,
			last_accessed_at: now,
		} as Partial<MemoryMetadata>;
	}

	/** Implements reset timer as the local access reinforcement metadata operation. */
	private resetTimer(): void {
		this.resetTimerWithDelay(this.debounceMs);
	}

	/** Implements schedule retry as the local access reinforcement metadata operation. */
	private scheduleRetry(): void {
		this.retryDelayMs = Math.min(this.retryDelayMs * 2, MAX_RETRY_DELAY_MS);
		this.resetTimerWithDelay(this.retryDelayMs);
	}

	/** Implements reset timer with delay as the local access reinforcement metadata operation. */
	private resetTimerWithDelay(delayMs: number): void {
		// Guard this branch early so the remaining retrieval scoring path works with normalized inputs.
		if (this.destroying) return;
		this.clearTimer();
		this.debounceTimer = setTimeout(() => {
			void this.flush();
		}, delayMs);
	}

	/** Removes timer while preserving access reinforcement metadata invariants. */
	private clearTimer(): void {
		// Guard this.debounce timer here so the remaining retrieval scoring path works with normalized inputs.
		if (this.debounceTimer !== undefined) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
	}
}
