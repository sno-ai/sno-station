import { createHash } from "node:crypto";

import { z } from "zod";

const sha256Schema: z.ZodString = z.string().regex(/^[0-9a-f]{64}$/u);
const positiveSafeInteger: z.ZodNumber = z
	.number()
	.int()
	.safe()
	.positive("value must be positive and non-zero");
const nullablePercentage: z.ZodNullable<z.ZodNumber> = z.number().min(0).max(1).nullable();

export interface RemOperationalConfiguration {
	profileId: string;
	operations: {
		"rem-update": boolean;
		"rem-replace": boolean;
		"rem-distill": boolean;
		"rem-retire": boolean;
	};
	// `maxPairs` is the only bound a wave carries, and it is the only one derived from measurement
	// (the pair population of three real persona stores). Four siblings — maxRows, maxWallMs,
	// maxModelCalls, maxTokens — were removed on 2026-08-11: every one was a guessed ceiling, and
	// together they stopped the engine outright, maxTokens unconditionally so, because a reservation
	// costs a fixed 4096-token output allowance against a 1000-token budget. What they claimed to
	// watch is now measured and reported in the wave summary instead of enforced.
	budgets: { maxPairs: number };
	retrieval: { neighborLimit: number; similarityThreshold: number };
	coverage: { accuracyFloor: number | null };
	retries: { liveContentionRetries: number };
	modelRoute: string;
	facetPolicy: { aggregationGrammar: string; historyGrammar: string };
	calibration: {
		minimumPublishableScoreEffect: number | null;
		minimumTargetCount: number | null;
		minimumTargetPercent: number | null;
	};
	enableGateDigests: {
		"p5-production-config": string;
		"p6-monthly-non-regression": string;
		"p7-detector-gate-verdict": string;
		"population-routing": string;
		"rem-update": string;
		"rem-replace": string;
		"p5-immutable-profile"?: string | undefined;
	};
}

const remOperationalConfigurationSchema: z.ZodType<RemOperationalConfiguration> = z
	.object({
		profileId: z.string().min(1),
		operations: z
			.object({
				"rem-update": z.boolean(),
				"rem-replace": z.boolean(),
				"rem-distill": z.boolean(),
				"rem-retire": z.boolean(),
			})
			.strict(),
		budgets: z.object({ maxPairs: positiveSafeInteger }).strict(),
		retrieval: z
			.object({
				neighborLimit: positiveSafeInteger,
				similarityThreshold: z.number().min(0).max(1),
			})
			.strict(),
		coverage: z.object({ accuracyFloor: nullablePercentage }).strict(),
		retries: z
			.object({ liveContentionRetries: z.number().int().safe().nonnegative() })
			.strict(),
		modelRoute: z.string().url(),
		facetPolicy: z
			.object({
				aggregationGrammar: z.string().min(1),
				historyGrammar: z.string().min(1),
			})
			.strict(),
		calibration: z
			.object({
				minimumPublishableScoreEffect: z.number().nonnegative().nullable(),
				minimumTargetCount: positiveSafeInteger.nullable(),
				minimumTargetPercent: nullablePercentage,
			})
			.strict(),
		enableGateDigests: z
			.object({
				"p5-production-config": sha256Schema,
				"p6-monthly-non-regression": sha256Schema,
				"p7-detector-gate-verdict": sha256Schema,
				"population-routing": sha256Schema,
				"rem-update": sha256Schema,
				"rem-replace": sha256Schema,
				"p5-immutable-profile": sha256Schema.optional(),
			})
			.strict(),
	})
	.strict();

export type RemConfigurationDecision =
	| { decision: "allow"; reasonCode: null }
	| { decision: "refuse"; reasonCode: string };

export function parseRemOperationalConfiguration(input: unknown): RemOperationalConfiguration {
	return remOperationalConfigurationSchema.parse(input);
}

export function canonicalizeRemConfiguration(input: RemOperationalConfiguration): string {
	const { enableGateDigests: _excluded, ...operational } = parseRemOperationalConfiguration(input);
	return canonicalJson(operational);
}

export function deriveRemConfigurationSha256(input: RemOperationalConfiguration): string {
	return createHash("sha256").update(canonicalizeRemConfiguration(input), "utf8").digest("hex");
}

export function validateRemEnableGateDigestKeys(input: {
	configuration: RemOperationalConfiguration;
	p5ReadbackSource: "wrapper" | "immutable-profile";
}): RemConfigurationDecision {
	const digests = parseRemOperationalConfiguration(input.configuration).enableGateDigests;
	const hasImmutableProfile = digests["p5-immutable-profile"] !== undefined;
	if (hasImmutableProfile !== (input.p5ReadbackSource === "immutable-profile")) {
		return { decision: "refuse", reasonCode: "enableGateDigests.p5-immutable-profile" };
	}
	return { decision: "allow", reasonCode: null };
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function requireRemCoverageAccuracyFloor(input: {
	configuration: RemOperationalConfiguration;
}): RemConfigurationDecision {
	const configuration = parseRemOperationalConfiguration(input.configuration);
	return configuration.coverage.accuracyFloor === null
		? { decision: "refuse", reasonCode: "coverage.accuracyFloor" }
		: { decision: "allow", reasonCode: null };
}

export function requireRemOwnerDecisions(input: {
	configuration: RemOperationalConfiguration;
}): RemConfigurationDecision {
	const configuration = parseRemOperationalConfiguration(input.configuration);
	if (configuration.coverage.accuracyFloor === null) {
		return { decision: "refuse", reasonCode: "coverage.accuracyFloor" };
	}
	for (const key of [
		"minimumPublishableScoreEffect",
		"minimumTargetCount",
		"minimumTargetPercent",
	] as const) {
		if (configuration.calibration[key] === null) {
			return { decision: "refuse", reasonCode: `calibration.${key}` };
		}
	}
	return { decision: "allow", reasonCode: null };
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function declareRemCalibrationThreshold(input: {
	configuration: RemOperationalConfiguration;
	derivationStatement?: string;
}): RemConfigurationDecision {
	const configuration = parseRemOperationalConfiguration(input.configuration);
	for (const key of [
		"minimumPublishableScoreEffect",
		"minimumTargetCount",
		"minimumTargetPercent",
	] as const) {
		if (configuration.calibration[key] === null) {
			return { decision: "refuse", reasonCode: `calibration.${key}` };
		}
	}
	if (input.derivationStatement?.trim().length === 0 || input.derivationStatement === undefined) {
		return { decision: "refuse", reasonCode: "calibration.derivationStatement" };
	}
	return { decision: "allow", reasonCode: null };
}

export function validateRemGrammarChange(input: {
	beforeConfigurationSha256: string;
	before: RemOperationalConfiguration;
	beforeCorpusSha256: string;
	afterConfigurationSha256: string;
	after: RemOperationalConfiguration;
	abArtifact?: {
		beforeConfigurationSha256: string;
		afterConfigurationSha256: string;
		corpusSha256: string;
		metricDefinitions: readonly string[];
		result: "pass" | "fail";
	};
}): RemConfigurationDecision {
	const before = parseRemOperationalConfiguration(input.before);
	const after = parseRemOperationalConfiguration(input.after);
	if (
		deriveRemConfigurationSha256(before) !== input.beforeConfigurationSha256 ||
		deriveRemConfigurationSha256(after) !== input.afterConfigurationSha256 ||
		!sha256Schema.safeParse(input.beforeCorpusSha256).success
	) {
		return { decision: "refuse", reasonCode: "configuration_digest_mismatch" };
	}
	const grammarChanged =
		before.facetPolicy.aggregationGrammar !== after.facetPolicy.aggregationGrammar ||
		before.facetPolicy.historyGrammar !== after.facetPolicy.historyGrammar;
	if (!grammarChanged) return { decision: "allow", reasonCode: null };
	const artifact = input.abArtifact;
	if (
		artifact === undefined ||
		artifact.beforeConfigurationSha256 !== input.beforeConfigurationSha256 ||
		artifact.afterConfigurationSha256 !== input.afterConfigurationSha256 ||
		artifact.corpusSha256 !== input.beforeCorpusSha256 ||
		artifact.metricDefinitions.length === 0 ||
		artifact.result !== "pass"
	) {
		return { decision: "refuse", reasonCode: "grammar_ab_missing_or_failed" };
	}
	return { decision: "allow", reasonCode: null };
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("canonical JSON does not accept non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value !== "object") throw new Error("canonical JSON accepts JSON values only");
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

