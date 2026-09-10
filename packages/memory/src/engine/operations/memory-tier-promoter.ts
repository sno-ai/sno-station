/** @file memory-tier-promoter.ts
 * @purpose Assigns memory tiers that influence retention, recall, and decay behavior.
 * @boundary Importance, access signals, and lifecycle maintenance jobs.
 * @see selective-forgetting-scorer.ts, access-tracker.ts, store.ts.
 */

/**
 * Tier Promoter — Three-tier memory promotion/demotion system
 *
 * Tiers:
 * - Core (decay floor 0.9): Identity-level facts, almost never forgotten
 * - Working (decay floor 0.7): Active context, ages out without reinforcement
 * - Peripheral (decay floor 0.5): Low-priority or aging memories
 *
 * Promotion: Peripheral → Working → Core (based on access, composite score, importance)
 * Demotion: Core → Working → Peripheral (based on decay, age)
 */

import type { DecayScore, MemoryTier } from "../shared/types";

// Types

export interface TierConfig {
	/** Minimum access count for Core promotion (default: 10) */
	coreAccessThreshold: number;
	/** Minimum composite decay score for Core promotion (default: 0.7) */
	coreCompositeThreshold: number;
	/** Minimum importance for Core promotion (default: 0.8) */
	coreImportanceThreshold: number;
	/** Composite threshold below which to demote to Peripheral (default: 0.15) */
	peripheralCompositeThreshold: number;
	/** Age in days after which infrequent memories demote to Peripheral (default: 60) */
	peripheralAgeDays: number;
	/** Minimum access count for Working promotion from Peripheral (default: 3) */
	workingAccessThreshold: number;
	/** Minimum composite for Working promotion from Peripheral (default: 0.4) */
	workingCompositeThreshold: number;
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
	coreAccessThreshold: 10,
	coreCompositeThreshold: 0.7,
	coreImportanceThreshold: 0.8,
	peripheralCompositeThreshold: 0.15,
	peripheralAgeDays: 60,
	workingAccessThreshold: 3,
	workingCompositeThreshold: 0.4,
};

export interface TierTransition {
	memoryId: string;
	fromTier: MemoryTier;
	toTier: MemoryTier;
	reason: string;
}

/** Minimal memory fields needed for tier evaluation.
 *  Uses `timestamp` to align with sno-station-mem's MemoryEntry shape. */
export interface TierableMemory {
	id: string;
	tier: MemoryTier;
	importance: number;
	accessCount: number;
	timestamp: number;
}

export interface TierPromoter {
	evaluate(memory: TierableMemory, decayScore: DecayScore, now?: number): TierTransition | null;

	evaluateAll(
		memories: TierableMemory[],
		decayScores: DecayScore[],
		now?: number,
	): TierTransition[];
}

type TierDecisionContext = {
	memory: TierableMemory;
	score: DecayScore;
	now: number;
	ageDays: number;
	config: TierConfig;
};

type TierRule = {
	from: MemoryTier;
	matches(context: TierDecisionContext): boolean;
	transition(context: TierDecisionContext): TierTransition;
};

// Factory

const MS_PER_DAY = 86_400_000;

function createTransition(
	context: TierDecisionContext,
	toTier: MemoryTier,
	reason: string,
): TierTransition {
	return {
		memoryId: context.memory.id,
		fromTier: context.memory.tier,
		toTier,
		reason,
	};
}

const TIER_RULES: readonly TierRule[] = [
	{
		from: "peripheral",
		matches({ memory, score, config }) {
			return (
				memory.accessCount >= config.workingAccessThreshold &&
				score.composite >= config.workingCompositeThreshold
			);
		},
		transition(context) {
			const { memory, score, config } = context;
			return createTransition(
				context,
				"working",
				`Access count (${memory.accessCount}) >= ${config.workingAccessThreshold} and composite (${score.composite.toFixed(2)}) >= ${config.workingCompositeThreshold}`,
			);
		},
	},
	{
		from: "working",
		matches({ memory, score, config }) {
			return (
				memory.accessCount >= config.coreAccessThreshold &&
				score.composite >= config.coreCompositeThreshold &&
				memory.importance >= config.coreImportanceThreshold
			);
		},
		transition(context) {
			const { memory, score } = context;
			return createTransition(
				context,
				"core",
				`High access (${memory.accessCount}), composite (${score.composite.toFixed(2)}), importance (${memory.importance})`,
			);
		},
	},
	{
		from: "working",
		matches({ memory, score, ageDays, config }) {
			return (
				score.composite < config.peripheralCompositeThreshold ||
				(ageDays > config.peripheralAgeDays && memory.accessCount < config.workingAccessThreshold)
			);
		},
		transition(context) {
			const { memory, score, ageDays } = context;
			return createTransition(
				context,
				"peripheral",
				`Low composite (${score.composite.toFixed(2)}) or aged ${ageDays.toFixed(0)} days with low access (${memory.accessCount})`,
			);
		},
	},
	{
		from: "core",
		matches({ memory, score, config }) {
			return (
				score.composite < config.peripheralCompositeThreshold &&
				memory.accessCount < config.workingAccessThreshold
			);
		},
		transition(context) {
			const { memory, score } = context;
			return createTransition(
				context,
				"working",
				`Severely low composite (${score.composite.toFixed(2)}) and access (${memory.accessCount})`,
			);
		},
	},
];

/** Creates the tier promoter that translates decay scores into promotion/demotion decisions.
 *  Promote is bidirectional here: Peripheral→Working→Core (up) and Core→Working→Peripheral (down). */
// LH: Tier promoter currently provides transition decisions but no plugin lifecycle path calls it automatically.
// LH: Treat this file as a ready primitive, not active retention behavior.
// LH: Promotion and demotion must stay inert until a scheduler and store mutation policy are wired deliberately.
// LH: When activated, tests must prove tier transitions do not hide or erase useful memories unexpectedly.
export function createTierPromoter(config: TierConfig = DEFAULT_TIER_CONFIG): TierPromoter {
	function createContext(
		memory: TierableMemory,
		score: DecayScore,
		now: number,
	): TierDecisionContext {
		return {
			memory,
			score,
			now,
			ageDays: (now - memory.timestamp) / MS_PER_DAY,
			config,
		};
	}

	function evaluate(
		memory: TierableMemory,
		decayScore: DecayScore,
		now: number = Date.now(),
	): TierTransition | null {
		const context = createContext(memory, decayScore, now);
		const rule = TIER_RULES.find(
			(candidate) => candidate.from === memory.tier && candidate.matches(context),
		);
		return rule ? rule.transition(context) : null;
	}

	return {
		evaluate,

		evaluateAll(memories, decayScores, now = Date.now()) {
			const scoreMap = new Map(decayScores.map((s) => [s.memoryId, s]));
			const transitions: TierTransition[] = [];

			for (const memory of memories) {
				const score = scoreMap.get(memory.id);
				if (!score) continue;

				const transition = evaluate(memory, score, now);
				if (transition) {
					transitions.push(transition);
				}
			}

			return transitions;
		},
	};
}
