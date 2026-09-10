import { describe, expect, it } from "vitest";
import {
	createTierPromoter,
	type TierableMemory,
} from "../../../../apps/mem-claw/src/operations/memory-tier-promoter.ts";
import {
	createRetentionScorer,
	DEFAULT_DECAY_CONFIG,
} from "../../../../apps/mem-claw/src/operations/selective-forgetting-scorer.ts";
import type {
	DecayableMemory,
	DecayScore,
	MemoryTier,
} from "../../../../apps/mem-claw/src/shared/types.ts";

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

function expectScore(
	actual: DecayScore,
	expected: {
		memoryId: string;
		recency: number;
		frequency: number;
		intrinsic: number;
		composite: number;
	},
): void {
	expect(actual.memoryId).toBe(expected.memoryId);
	expect(actual.recency).toBeCloseTo(expected.recency, 10);
	expect(actual.frequency).toBeCloseTo(expected.frequency, 10);
	expect(actual.intrinsic).toBeCloseTo(expected.intrinsic, 10);
	expect(actual.composite).toBeCloseTo(expected.composite, 10);
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
	const workingStatic = memory(
		"working-static",
		"working",
		40,
		5,
		4,
		0.6,
		0.75,
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

	it("scores fixed tier and temporal fixtures with literal component values", () => {
		expectScore(engine.score(coreStatic, NOW), {
			memoryId: "core-static",
			recency: 0.929154775675,
			frequency: 0.808179737631,
			intrinsic: 0.72,
			composite: 0.830115831559,
		});
		expectScore(engine.score(workingStatic, NOW), {
			memoryId: "working-static",
			recency: 0.954117195262,
			frequency: 0.461960569167,
			intrinsic: 0.45,
			composite: 0.655235048855,
		});
		expectScore(engine.score(peripheralStale, NOW), {
			memoryId: "peripheral-stale",
			recency: 0.000906464149,
			frequency: 0,
			intrinsic: 0.1,
			composite: 0.03036258566,
		});
		expectScore(engine.score(workingDynamic, NOW), {
			memoryId: "working-dynamic",
			recency: 0.229147827444,
			frequency: 0,
			intrinsic: 0.4,
			composite: 0.211659130978,
		});
		expectScore(engine.score(workingStaticAgeMatch, NOW), {
			memoryId: "working-static-age-match",
			recency: 0.611934935701,
			frequency: 0,
			intrinsic: 0.4,
			composite: 0.364773974281,
		});
		expectScore(engine.score(metadataDynamic, NOW), {
			memoryId: "metadata-dynamic",
			recency: 0.229147827444,
			frequency: 0,
			intrinsic: 0.4,
			composite: 0.211659130978,
		});
	});

	it("applies dynamic temporal decay only when enabled", () => {
		const dynamicScore = engine.score(workingDynamic, NOW);
		const staticScore = engine.score(workingStaticAgeMatch, NOW);
		expect(dynamicScore.recency).toBeLessThan(staticScore.recency);
		expect(dynamicScore.composite).toBeLessThan(staticScore.composite);

		const noTemporalEngine = createRetentionScorer({
			...DEFAULT_DECAY_CONFIG,
			temporalDecay: false,
		});
		expectScore(noTemporalEngine.score(workingDynamic, NOW), {
			memoryId: "working-dynamic",
			recency: 0.611934935701,
			frequency: 0,
			intrinsic: 0.4,
			composite: 0.364773974281,
		});
	});

	it("scoreAll preserves input order and component values", () => {
		const scores = engine.scoreAll([peripheralStale, coreStatic], NOW);
		expect(scores.map((item) => item.memoryId)).toEqual([
			"peripheral-stale",
			"core-static",
		]);

		const first = scores.at(0);
		const second = scores.at(1);
		if (!first || !second)
			throw new Error("scoreAll fixture did not produce scores");

		expectScore(first, {
			memoryId: "peripheral-stale",
			recency: 0.000906464149,
			frequency: 0,
			intrinsic: 0.1,
			composite: 0.03036258566,
		});
		expectScore(second, {
			memoryId: "core-static",
			recency: 0.929154775675,
			frequency: 0.808179737631,
			intrinsic: 0.72,
			composite: 0.830115831559,
		});
	});

	it("returns stale memories below threshold sorted by ascending composite", () => {
		const stale = engine.getStaleMemories(
			[workingStaticAgeMatch, workingDynamic, peripheralStale],
			NOW,
		);

		expect(stale.map((item) => item.memoryId)).toEqual([
			"peripheral-stale",
			"working-dynamic",
		]);
		expectScore(stale[0] as DecayScore, {
			memoryId: "peripheral-stale",
			recency: 0.000906464149,
			frequency: 0,
			intrinsic: 0.1,
			composite: 0.03036258566,
		});
		expectScore(stale[1] as DecayScore, {
			memoryId: "working-dynamic",
			recency: 0.229147827444,
			frequency: 0,
			intrinsic: 0.4,
			composite: 0.211659130978,
		});
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
