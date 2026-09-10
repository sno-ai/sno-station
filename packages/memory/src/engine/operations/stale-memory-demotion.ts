/** @file stale-memory-demotion.ts
 * @purpose Demote stale `working`-tier memories one level to `peripheral`.
 * @boundary Tier downgrade only — never deletes, never touches core or peripheral.
 */

import { createLogger } from "@snoai/utils/logger";
import { parseInsightMetadata } from "../extraction/memory-metadata-codec";
import { parseAccessMetadata } from "../retrieval/access-tracker";
import type { DecayableMemory, MemoryEntry, MemoryTier } from "../shared/types";
import { createRetentionScorer } from "./selective-forgetting-scorer";

const log = createLogger("sno-station-mem:stale-memory-demotion");

/**
 * Minimal store surface needed for stale-tier demotion. `MemoryStore`
 * satisfies this structurally; the narrow interface keeps this operations
 * module independent of the storage layer's full API.
 */
export interface DemotionStore {
	list(opts: { projectIdFilter?: string[] }): Promise<MemoryEntry[]>;
	updateTier(
		memoryId: string,
		newTier: MemoryTier,
		options?: { writerAuthority?: "offline-family" },
	): Promise<void>;
}

export interface DemotionResult {
	/** Memories scored. */
	scanned: number;
	/** Memories downgraded `working` → `peripheral`. */
	demoted: number;
}

/**
 * Convert a stored row to the scorer's input shape. Mirrors the retrieval
 * pipeline's adapter: tier and confidence come from insight metadata, access
 * counts from access metadata; a missing tier defaults to `peripheral`.
 */
function toDecayableMemory(entry: MemoryEntry): DecayableMemory {
	const insight = parseInsightMetadata(entry.metadata, entry);
	const access = parseAccessMetadata(entry.metadata);
	const memory: DecayableMemory = {
		id: entry.id,
		importance: entry.importance,
		confidence: insight.confidence,
		tier: insight.tier ?? "peripheral",
		accessCount: access.accessCount,
		createdAt: entry.timestamp,
		lastAccessedAt: access.lastAccessedAt > 0 ? access.lastAccessedAt : entry.timestamp,
		metadata: entry.metadata,
	};
	if (insight.memory_temporal_type !== undefined) {
		memory.temporalType = insight.memory_temporal_type;
	}
	return memory;
}

/**
 * Score every memory in the given scopes and demote stale `working`-tier
 * memories one level to `peripheral`.
 *
 * Demotion is a single downgrade step, not deletion: `core` is never demoted
 * (it must survive forgetting), and `peripheral` is already the floor. Only
 * `working` rows that the retention scorer flags as stale move down.
 *
 * @param store  Storage backend (`list` + `updateTier`)
 * @param scopes Scope filter; undefined = all scopes
 */
export async function runStaleDemotion(
	store: DemotionStore,
	scopes?: string[],
): Promise<DemotionResult> {
	const entries = await store.list(scopes ? { projectIdFilter: scopes } : {});
	if (entries.length === 0) {
		return { scanned: 0, demoted: 0 };
	}

	const decayables = entries.map(toDecayableMemory);
	const tierById = new Map(decayables.map((m) => [m.id, m.tier]));

	const scorer = createRetentionScorer();
	const stale = scorer.getStaleMemories(decayables);

	let demoted = 0;
	for (const score of stale) {
		// Only `working` rows are eligible: `core` is preserved, `peripheral`
		// is already the floor.
		if (tierById.get(score.memoryId) !== "working") continue;
		try {
			await store.updateTier(score.memoryId, "peripheral", {
				writerAuthority: "offline-family",
			});
			demoted += 1;
		} catch (err) {
			log.warn("failed to demote stale memory", {
				memoryId: score.memoryId,
				error: err instanceof Error ? err : new Error(String(err)),
			}, {
				event_name: "sno_station_mem.stale-memory-demotion.failed.to.demote.stale.memory",
				file: "packages/sno-station-mem/src/engine/operations/stale-memory-demotion.ts",
				function: "runStaleDemotion",
				site_id: "stale-memory-demotion.runStaleDemotion.e86f004935",
			});
		}
	}

	log.info("stale-tier demotion complete", { scanned: entries.length, demoted }, {
		event_name: "sno_station_mem.stale-memory-demotion.stale.tier.demotion.complete",
		file: "packages/sno-station-mem/src/engine/operations/stale-memory-demotion.ts",
		function: "runStaleDemotion",
		site_id: "stale-memory-demotion.runStaleDemotion.d7a77107bb",
	});
	return { scanned: entries.length, demoted };
}
