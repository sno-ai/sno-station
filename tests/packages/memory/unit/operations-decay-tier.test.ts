import { describe, expect, it } from "vitest";
import {
	createTierPromoter,
	type TierableMemory,
} from "../../../../packages/sno-station-mem/src/engine/operations/memory-tier-promoter.ts";
import {
	createRetentionScorer,
	DEFAULT_DECAY_CONFIG,
} from "../../../../packages/sno-station-mem/src/engine/operations/selective-forgetting-scorer.ts";
import type {
	DecayableMemory,
	DecayScore,
	MemoryTier,
} from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

function memory(
	id: string,
	tier: MemoryTier,
	createdDaysAgo: number,
	lastAccessedDaysAgo: number,
	accessCount: number,
	importance: number,
	confidence: number,
	temporalType?: "static" | "dynamic",
	metadata?: string,
): DecayableMemory {
	return {
		id,
		tier,
		createdAt: NOW - createdDaysAgo * DAY_MS,
		lastAccessedAt: NOW - lastAccessedDaysAgo * DAY_MS,
		accessCount,
		importance,
		confidence,
		temporalType,
		metadata,
	};
}

function tierMemory(
	id: string,
	tier: MemoryTier,
	accessCount: number,
	importance: number,
	ageDays: number,
): TierableMemory {
	return {
		id,
		tier,
		accessCount,
		importance,
		timestamp: NOW - ageDays * DAY_MS,
	};
}

function score(memoryId: string, composite: number): DecayScore {
	return {
		memoryId,
		recency: composite,
		frequency: 0,
		intrinsic: 0,
		composite,
	};
}

describe("selective forgetting decay golden parity", () => {
	const engine = createRetentionScorer();
	const coreStatic = memory(
		"core-static",
		"core",
		90,
		7,
		12,
		0.9,
		0.8,
		"static",
	);
	const peripheralStale = memory(
		"peripheral-stale",
		"peripheral",
		240,
		240,
		0,
		0.2,
		0.5,
	);
	const workingDynamic = memory(
		"working-dynamic",
		"working",
		45,
		45,
		0,
		0.5,
		0.8,
		"dynamic",
	);
	const workingStaticAgeMatch = memory(
		"working-static-age-match",
		"working",
		45,
		45,
		0,
		0.5,
		0.8,
		"static",
	);
	const metadataDynamic = memory(
		"metadata-dynamic",
		"working",
		45,
		45,
		0,
		0.5,
		0.8,
		undefined,
		'{"kind":"episodic","memory_category":"episodic","memory_temporal_type":"dynamic"}',
	);

	it("applies dynamic temporal decay only when enabled", () => {
		const dynamicScore = engine.score(workingDynamic, NOW);
		const staticScore = engine.score(workingStaticAgeMatch, NOW);
		expect(dynamicScore.recency).toBeLessThan(staticScore.recency);
		expect(dynamicScore.composite).toBeLessThan(staticScore.composite);
		expect(engine.score(metadataDynamic, NOW).recency).toBeCloseTo(dynamicScore.recency);

		const noTemporalEngine = createRetentionScorer({
			...DEFAULT_DECAY_CONFIG,
			temporalDecay: false,
		});
		const noTemporalScore = noTemporalEngine.score(workingDynamic, NOW);
		expect(noTemporalScore.recency).toBeCloseTo(staticScore.recency);
		expect(noTemporalScore.composite).toBeCloseTo(staticScore.composite);
	});

	it("scoreAll preserves input order", () => {
		const scores = engine.scoreAll([peripheralStale, coreStatic], NOW);
		expect(scores.map((item) => item.memoryId)).toEqual([
			"peripheral-stale",
			"core-static",
		]);
	});

	it("returns stale memories below threshold sorted by ascending composite", () => {
		const stale = engine.getStaleMemories(
			[workingStaticAgeMatch, workingDynamic, peripheralStale],
			NOW,
		);

		expect(stale.map((item) => item.memoryId)).toEqual(["peripheral-stale"]);
		expect(stale.every((item) => item.composite < DEFAULT_DECAY_CONFIG.staleThreshold)).toBe(true);
	});

});

describe("memory tier promotion golden parity", () => {
	const promoter = createTierPromoter();

	it("returns expected promotion and demotion transition shapes", () => {
		const cases = [
			{
				memory: tierMemory("peripheral-promote", "peripheral", 3, 0.5, 10),
				decayScore: score("peripheral-promote", 0.4),
				expected: {
					memoryId: "peripheral-promote",
					fromTier: "peripheral",
					toTier: "working",
				},
			},
			{
				memory: tierMemory("working-promote", "working", 10, 0.8, 10),
				decayScore: score("working-promote", 0.7),
				expected: {
					memoryId: "working-promote",
					fromTier: "working",
					toTier: "core",
				},
			},
			{
				memory: tierMemory("working-low", "working", 5, 0.7, 10),
				decayScore: score("working-low", 0.149),
				expected: {
					memoryId: "working-low",
					fromTier: "working",
					toTier: "peripheral",
				},
			},
			{
				memory: tierMemory("working-aged", "working", 2, 0.7, 61),
				decayScore: score("working-aged", 0.5),
				expected: {
					memoryId: "working-aged",
					fromTier: "working",
					toTier: "peripheral",
				},
			},
			{
				memory: tierMemory("core-demote", "core", 2, 0.9, 30),
				decayScore: score("core-demote", 0.149),
				expected: {
					memoryId: "core-demote",
					fromTier: "core",
					toTier: "working",
				},
			},
		];

		for (const { memory: item, decayScore, expected } of cases) {
			const transition = promoter.evaluate(item, decayScore, NOW);
			expect(transition).toMatchObject(expected);
			expect(transition?.reason).toEqual(expect.any(String));
			expect(transition?.reason.length).toBeGreaterThan(0);
		}
	});

	it("keeps stable memories at null and locks threshold boundary semantics", () => {
		expect(
			promoter.evaluate(
				tierMemory("peripheral-stable", "peripheral", 2, 0.5, 10),
				score("peripheral-stable", 0.4),
				NOW,
			),
		).toBeNull();
		expect(
			promoter.evaluate(
				tierMemory("working-stable", "working", 10, 0.8, 10),
				score("working-stable", 0.69),
				NOW,
			),
		).toBeNull();
		expect(
			promoter.evaluate(
				tierMemory("core-stable", "core", 2, 0.9, 10),
				score("core-stable", 0.15),
				NOW,
			),
		).toBeNull();
		expect(
			promoter.evaluate(
				tierMemory("working-age-boundary", "working", 2, 0.7, 60),
				score("working-age-boundary", 0.5),
				NOW,
			),
		).toBeNull();
	});

	it("evaluateAll matches scores by id, skips missing scores, and preserves memory order", () => {
		const transitions = promoter.evaluateAll(
			[
				tierMemory("working-promote", "working", 10, 0.8, 10),
				tierMemory("missing-score", "working", 10, 0.8, 10),
				tierMemory("peripheral-promote", "peripheral", 3, 0.5, 10),
			],
			[score("peripheral-promote", 0.4), score("working-promote", 0.7)],
			NOW,
		);

		expect(transitions.map((item) => item.memoryId)).toEqual([
			"working-promote",
			"peripheral-promote",
		]);
		expect(transitions.map((item) => item.toTier)).toEqual(["core", "working"]);
	});
});
