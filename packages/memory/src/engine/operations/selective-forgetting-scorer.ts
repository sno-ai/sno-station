/** @file selective-forgetting-scorer.ts
 * @purpose Computes Selective Forgetting scores from age, access history, and intrinsic value.
 * @boundary Access history, importance, timestamps, and retrieval scoring inputs.
 * @see access-tracker.ts, retriever.ts, store.ts.
 */

/**
 * Selective Forgetting scorer — Weibull stretched-exponential retention model
 *
 * Composite score = recencyWeight * recency + frequencyWeight * frequency + intrinsicWeight * intrinsic
 *
 * - Recency: Weibull decay with importance-modulated half-life and tier-specific beta
 * - Frequency: Logarithmic saturation with time-weighted access pattern bonus
 * - Intrinsic: importance × confidence
 */

import { TEMPORAL_DYNAMIC_HALF_LIFE_DIVISOR } from "../../../config/index";
import { parseInsightMetadata } from "../extraction/memory-metadata-codec";
import type { DecayableMemory, DecayScore, MemoryTier } from "../shared/types";

export type { DecayableMemory } from "../shared/types";

// Types

const MS_PER_DAY = 86_400_000;

export interface DecayConfig {
	/** Dynamic memories use a shorter half-life when temporal decay is enabled */
	temporalDecay: boolean;
	/** Days until recency score halves (default: 30) */
	recencyHalfLifeDays: number;
	/** Weight of recency in composite (default: 0.4) */
	recencyWeight: number;
	/** Weight of access frequency (default: 0.3) */
	frequencyWeight: number;
	/** Weight of importance × confidence (default: 0.3) */
	intrinsicWeight: number;
	/** Below this composite = stale (default: 0.3) */
	staleThreshold: number;
	/** Minimum search boost (default: 0.3) */
	searchBoostMin: number;
	/** Importance modulation coefficient for half-life (default: 1.5) */
	importanceModulation: number;
	/** Weibull beta for Core tier — sub-exponential (default: 0.8) */
	betaCore: number;
	/** Weibull beta for Working tier — standard exponential (default: 1.0) */
	betaWorking: number;
	/** Weibull beta for Peripheral tier — super-exponential (default: 1.3) */
	betaPeripheral: number;
	/** Decay floor for Core memories (default: 0.9) */
	coreDecayFloor: number;
	/** Decay floor for Working memories (default: 0.7) */
	workingDecayFloor: number;
	/** Decay floor for Peripheral memories (default: 0.5) */
	peripheralDecayFloor: number;
}

// Light by ruling (owner, 2026-09-14): the retention stage's age is a memory's OWN time (the
// session it was said in, kept so a replayed timeline stays a timeline), so a store that mixes
// old and recent memories has every old one suppressed against every recent one on age alone.
// Measured on the LoCoMo store: rows anchored to 2023 beside rows anchored to the replay day
// ranked 100-250 places below them for their own exact text (floor 0.3, half-life 30 days).
// A floor of 0.85 caps the whole stage at a 15% suppression; 180 days keeps the slope gentle.
export const DEFAULT_DECAY_CONFIG: DecayConfig = {
	temporalDecay: true,
	recencyHalfLifeDays: 180,
	recencyWeight: 0.4,
	frequencyWeight: 0.3,
	intrinsicWeight: 0.3,
	staleThreshold: 0.3,
	searchBoostMin: 0.85,
	importanceModulation: 1.5,
	betaCore: 0.8,
	betaWorking: 1.0,
	betaPeripheral: 1.3,
	coreDecayFloor: 0.9,
	workingDecayFloor: 0.7,
	peripheralDecayFloor: 0.5,
};

export interface RetentionScorer {
	/** Calculate decay score for a single memory */
	score(memory: DecayableMemory, now?: number): DecayScore;
	/** Calculate decay scores for multiple memories */
	scoreAll(memories: DecayableMemory[], now?: number): DecayScore[];
	/** Find stale memories (composite below threshold) */
	getStaleMemories(memories: DecayableMemory[], now?: number): DecayScore[];
}

type ScoringContext = {
	memory: DecayableMemory;
	now: number;
	lastActiveAt: number;
	daysSinceActive: number;
	temporalType: "static" | "dynamic" | undefined;
	tierBeta: number;
	baseHalfLifeDays: number;
};

type ScoreComponents = {
	recency: number;
	frequency: number;
	intrinsic: number;
};

// Factory

/** Creates the Selective Forgetting scorer that blends intrinsic value, age, tier, and temporal hints. */
// LH: RetentionScorer is the retention scoring primitive; retriever lifecycle actions do not invoke it today.
// LH: Keep this distinction explicit: retention scoring can run while deletion, promotion, and demotion remain unwired.
// LH: The scorer consumes centralized DecayableMemory so future lifecycle wiring can share retriever semantics.
// LH: Temporal retention uses the same dynamic/static metadata field that recall ranking reads.
// LH: Any lifecycle activation must add tests proving when scores cause retention, demotion, or deletion.
export function createRetentionScorer(config: DecayConfig = DEFAULT_DECAY_CONFIG): RetentionScorer {
	const {
		temporalDecay,
		recencyHalfLifeDays: halfLife,
		recencyWeight: rw,
		frequencyWeight: fw,
		intrinsicWeight: iw,
		staleThreshold,
		importanceModulation: mu,
		betaCore,
		betaWorking,
		betaPeripheral,
	} = config;

	function betaForTier(tier: MemoryTier): number {
		switch (tier) {
			case "core":
				return betaCore;
			case "working":
				return betaWorking;
			case "peripheral":
				return betaPeripheral;
		}
	}

	function resolveTemporalType(memory: DecayableMemory): "static" | "dynamic" | undefined {
		if (memory.temporalType) return memory.temporalType;
		if (typeof memory.metadata !== "string" || memory.metadata.length === 0) {
			return undefined;
		}
		return parseInsightMetadata(memory.metadata).memory_temporal_type;
	}

	function activeTimestamp(memory: DecayableMemory): number {
		return memory.accessCount > 0 ? memory.lastAccessedAt : memory.createdAt;
	}

	function createScoringContext(memory: DecayableMemory, now: number): ScoringContext {
		const lastActive = activeTimestamp(memory);
		const temporalType = resolveTemporalType(memory);
		const baseHalfLifeDays =
			temporalDecay && temporalType === "dynamic"
				? halfLife / TEMPORAL_DYNAMIC_HALF_LIFE_DIVISOR
				: halfLife;

		return {
			memory,
			now,
			lastActiveAt: lastActive,
			daysSinceActive: Math.max(0, (now - lastActive) / MS_PER_DAY),
			temporalType,
			tierBeta: betaForTier(memory.tier),
			baseHalfLifeDays,
		};
	}

	function evaluateRecency(context: ScoringContext): number {
		const effectiveHalfLife = context.baseHalfLifeDays * Math.exp(mu * context.memory.importance);
		// Weibull survival must exponentiate the dimensionless ratio t/H so the
		// score halves at t = effectiveHalfLife for every beta; exponentiating raw
		// days shifts the half-life to H^(1/beta) (peripheral beta=1.3 decayed
		// ~2.8x faster than configured, core beta=0.8 slower).
		return Math.exp(-Math.LN2 * (context.daysSinceActive / effectiveHalfLife) ** context.tierBeta);
	}

	function evaluateFrequency(context: ScoringContext): number {
		const { memory } = context;
		const base = 1 - Math.exp(-memory.accessCount / 5);
		if (memory.accessCount <= 1) return base;

		const accessSpanDays = Math.max(1, (context.lastActiveAt - memory.createdAt) / MS_PER_DAY);
		const avgGapDays = accessSpanDays / Math.max(memory.accessCount - 1, 1);
		const recentnessBonus = Math.exp(-avgGapDays / 30);
		return base * (0.5 + 0.5 * recentnessBonus);
	}

	function evaluateIntrinsic(context: ScoringContext): number {
		return context.memory.importance * context.memory.confidence;
	}

	function evaluateComponents(context: ScoringContext): ScoreComponents {
		return {
			recency: evaluateRecency(context),
			frequency: evaluateFrequency(context),
			intrinsic: evaluateIntrinsic(context),
		};
	}

	function combineComponents(components: ScoreComponents): number {
		return rw * components.recency + fw * components.frequency + iw * components.intrinsic;
	}

	// LH: Tier-floor multiplication is intentionally absent here because it can keep stale peripheral memories too high.
	// LH: Reintroducing a tier floor needs A/B evaluation with real recall outcomes before lifecycle wiring.
	// LH: The composite score remains transparent: recency, frequency, and intrinsic value are inspectable components.
	function scoreOne(memory: DecayableMemory, now: number): DecayScore {
		const context = createScoringContext(memory, now);
		const components = evaluateComponents(context);

		return {
			memoryId: memory.id,
			...components,
			composite: combineComponents(components),
		};
	}

	return {
		score(memory, now = Date.now()) {
			return scoreOne(memory, now);
		},

		scoreAll(memories, now = Date.now()) {
			return memories.map((m) => scoreOne(m, now));
		},

		getStaleMemories(memories, now = Date.now()) {
			return memories
				.map((m) => scoreOne(m, now))
				.filter((s) => s.composite < staleThreshold)
				.sort((a, b) => a.composite - b.composite);
		},
	};
}
