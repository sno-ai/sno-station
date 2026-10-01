/** Owner-null D7 configuration fixture shared by independent REM entry tests. */

	export function createRemOwnerNullOperationalConfiguration(): Record<string, unknown> {
	return {
		profileId: "sno-e2e",
		budgets: { maxPairs: 10 },
		retrieval: { neighborLimit: 10, similarityThreshold: 0.8 },
		coverage: { accuracyFloor: null },
		retries: { liveContentionRetries: 1 },
		facetPolicy: {
			aggregationGrammar: "current-first-v1",
			historyGrammar: "history-evidence-v1",
		},
		calibration: {
			minimumPublishableScoreEffect: null,
			minimumTargetCount: null,
			minimumTargetPercent: null,
		},
		operations: {
			"rem-update": true,
			"rem-replace": true,
			"rem-distill": false,
			"rem-retire": false,
		},
		enableGateDigests: {
			"p5-production-config": "a".repeat(64),
			"p6-monthly-non-regression": "b".repeat(64),
			"p7-detector-gate-verdict": "c".repeat(64),
			"population-routing": "d".repeat(64),
			"rem-update": "e".repeat(64),
			"rem-replace": "f".repeat(64),
		},
	};
}

export function createRemOwnerDecidedOperationalConfiguration(): Record<string, unknown> {
	const configuration = createRemOwnerNullOperationalConfiguration();
	return {
		...configuration,
		coverage: {
			...(configuration["coverage"] as Record<string, unknown>),
			accuracyFloor: 1,
		},
		calibration: {
			minimumPublishableScoreEffect: 0.02,
			minimumTargetCount: 30,
			minimumTargetPercent: 0.8,
		},
	};
}
