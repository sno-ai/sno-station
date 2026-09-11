import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
	canonicalizeRemConfiguration,
	type RemOperationalConfiguration,
} from "./operational-config.js";
import type { RemDatabaseLike } from "./types.js";

type Decision =
	| { decision: "allow"; reasonCode: null }
	| { decision: "refuse"; reasonCode: string };

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function validateRemProspectiveIdentity(input: {
	writeIdentitySha256: string;
	candidateSetSha256: string;
}): Decision {
	if (input.writeIdentitySha256.includes(":")) {
		return { decision: "refuse", reasonCode: "scan_generation_identity" };
	}
	if (!isSha256(input.writeIdentitySha256) || !isSha256(input.candidateSetSha256)) {
		return { decision: "refuse", reasonCode: "identity_invalid" };
	}
	return { decision: "allow", reasonCode: null };
}

export function deriveRemWriteIdentity(input: {
	rowId: string;
	text: string;
	contentHash: string;
	timestamp: number;
}): string {
	return sha256(JSON.stringify([input.rowId, input.text, input.contentHash, input.timestamp]));
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export async function adjudicateRemCandidateSet(input: {
	database: RemDatabaseLike;
	orderedCandidateIds: readonly string[];
	generationId: string;
	baseUrl: string;
	model: string;
}): Promise<Decision> {
	const candidateSetSha256 = sha256(JSON.stringify(input.orderedCandidateIds));
	const upsert = input.database.prepare(
		`INSERT INTO nodix_rem_census_rows(row_id, candidate_set_sha256, generation_id)
		VALUES (?, ?, ?)
		ON CONFLICT(row_id) DO UPDATE SET
			candidate_set_sha256 = excluded.candidate_set_sha256,
			generation_id = excluded.generation_id`,
	);
	input.database.transaction(() => {
		for (const rowId of input.orderedCandidateIds) {
			upsert.run(rowId, candidateSetSha256, input.generationId);
		}
	}).immediate();
	const response = await fetch(`${input.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: input.model, messages: [] }),
	});
	if (!response.ok) return { decision: "refuse", reasonCode: "model_request_failed" };
	try {
		const body: unknown = await response.json();
		const content = readModelContent(body);
		JSON.parse(content);
		return { decision: "allow", reasonCode: null };
	} catch {
		return { decision: "refuse", reasonCode: "model_response_invalid" };
	}
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function deriveRemReplayArtifactIdentity(input: {
	corpusPath: string;
	embedderPath: string;
	toolPath: string;
	configuration: RemOperationalConfiguration;
	callerLabel?: string;
}): {
	replayIdentitySha256: string;
	corpusSha256: string;
	embedderSha256: string;
	toolSha256: string;
	configurationSha256: string;
} {
	const corpusSha256 = sha256(readFileSync(input.corpusPath));
	const embedderSha256 = sha256(readFileSync(input.embedderPath));
	const toolSha256 = sha256(readFileSync(input.toolPath));
	const configurationSha256 = sha256(canonicalizeRemConfiguration(input.configuration));
	return {
		corpusSha256,
		embedderSha256,
		toolSha256,
		configurationSha256,
		replayIdentitySha256: sha256(
			JSON.stringify([corpusSha256, embedderSha256, toolSha256, configurationSha256]),
		),
	};
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function validateRemReplayIdentityTuple(input: {
	corpusSha256: string;
	embedderSha256: string;
	configurationSha256: string;
}): Decision {
	return Object.values(input).every(isSha256)
		? { decision: "allow", reasonCode: null }
		: { decision: "refuse", reasonCode: "replay_identity_invalid" };
}

export function classifyRemCensusLabel(input: {
	label: string;
	observations: Record<string, unknown>;
}): string {
	const observations = input.observations;
	if (input.label === "reachability") {
		if (observations["similarityMet"] !== true) return "unknown";
		return observations["neighborEmitted"] === true ? "reachable" : "unreachable";
	}
	if (input.label === "contradiction") {
		if (observations["sameFactKey"] !== true) return "undetermined";
		return observations["valuesConflict"] === true ? "yes" : "no";
	}
	if (input.label === "coverageEligibility") {
		if (observations["retrievabilityComputed"] !== true) return "undetermined";
		return observations["referenceSetNonEmpty"] === true &&
			observations["retiringAtomsMatched"] === true
			? "eligible"
			: "ineligible";
	}
	throw new Error(`unknown REM census label: ${input.label}`);
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function classifyAllRemCensusLabels(input: {
	reachability: Record<string, unknown>;
	contradiction: Record<string, unknown>;
	coverageEligibility: Record<string, unknown>;
}): Record<string, string> {
	return {
		reachability: classifyRemCensusLabel({ label: "reachability", observations: input.reachability }),
		contradiction: classifyRemCensusLabel({ label: "contradiction", observations: input.contradiction }),
		coverageEligibility: classifyRemCensusLabel({
			label: "coverageEligibility",
			observations: input.coverageEligibility,
		}),
	};
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function validateRemCensusOracleProvenance(input: { authoredBy?: string }): Decision {
	return input.authoredBy === "product-classifier"
		? { decision: "refuse", reasonCode: "self_authored_oracle" }
		: { decision: "allow", reasonCode: null };
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function validateRemCensusLabelTuple(input: {
	reachability: string;
	contradiction: string;
	coverageEligibility: string;
}): Decision {
	const valid =
		["reachable", "unreachable", "unknown"].includes(input.reachability) &&
		["yes", "no", "undetermined"].includes(input.contradiction) &&
		["eligible", "ineligible", "undetermined"].includes(input.coverageEligibility);
	return valid
		? { decision: "allow", reasonCode: null }
		: { decision: "refuse", reasonCode: "label_enum_mismatch" };
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function readRetainedRemCensusArtifact(input: {
	artifactPath: string;
	generationId: string;
}): Decision & { artifactSha256?: string } {
	if (!existsSync(input.artifactPath)) return { decision: "refuse", reasonCode: "artifact_missing" };
	const bytes = readFileSync(input.artifactPath);
	try {
		JSON.parse(bytes.toString("utf8"));
	} catch {
		return { decision: "refuse", reasonCode: "artifact_invalid" };
	}
	return { decision: "allow", reasonCode: null, artifactSha256: sha256(bytes) };
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function produceRemCensusArtifact(input: {
	producer: string;
	outputPath: string;
}): void {
	if (input.producer !== "capture" && input.producer !== "replay") {
		throw new Error("REM census producer must be capture or replay");
	}
	writeFileSync(input.outputPath, `${JSON.stringify({ route: input.producer })}\n`);
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function validateRemCensusRouteCoverage(input: readonly { route: string }[]): Decision {
	const routes = new Set(input.map(({ route }) => route));
	return routes.has("capture") && routes.has("replay")
		? { decision: "allow", reasonCode: null }
		: { decision: "refuse", reasonCode: "route_coverage_incomplete" };
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function journalRemGenerationTransition(input: {
	database: RemDatabaseLike;
	outgoingGenerationId: string;
	incomingGenerationId: string;
}): Decision {
	if (input.outgoingGenerationId === input.incomingGenerationId) {
		return { decision: "refuse", reasonCode: "generation_identity_reused" };
	}
	input.database
		.prepare(
			`INSERT INTO nodix_rem_generation_transitions(
				outgoing_generation_id, incoming_generation_id, recorded_at
			) VALUES (?, ?, ?)`,
		)
		.run(input.outgoingGenerationId, input.incomingGenerationId, new Date().toISOString());
	return { decision: "allow", reasonCode: null };
}

interface BatchEvent {
	calls?: number;
	tokens?: number;
	verdict?: string;
	close?: number;
	refusal?: string | null;
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function summarizeRemBatchEvents(input: {
	database: RemDatabaseLike;
	batchId: string;
	generationId?: string;
	events: readonly BatchEvent[];
}): void {
	const distribution: Record<string, number> = {};
	let calls = 0;
	let tokens = 0;
	let closeCount = 0;
	let refusalCount = 0;
	for (const event of input.events) {
		calls += event.calls ?? 0;
		tokens += event.tokens ?? 0;
		closeCount += event.close ?? 0;
		if (event.refusal !== undefined && event.refusal !== null) refusalCount += 1;
		if (event.verdict !== undefined) distribution[event.verdict] = (distribution[event.verdict] ?? 0) + 1;
	}
	input.database
		.prepare(
			`INSERT INTO nodix_rem_batch_summaries(
				batch_id, generation_id, calls, tokens, pairCount, closeCount,
				refusalCount, verdict_distribution_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.batchId,
			input.generationId ?? null,
			calls,
			tokens,
			input.events.length,
			closeCount,
			refusalCount,
			JSON.stringify(distribution),
		);
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function recordRemObservedVerdict(input: {
	database: RemDatabaseLike;
	pairId: string;
	observed: string;
}): void {
	const verdicts = new Set(["replacement", "keep", "merge", "unrelated"]);
	const isVerdict = verdicts.has(input.observed);
	input.database
		.prepare(
			`INSERT INTO nodix_rem_verdict_observations(
				pair_id, audit_kind, persisted_verdict, raw_value
			) VALUES (?, ?, ?, ?)`,
		)
		.run(input.pairId, isVerdict ? "VERDICT" : "SAMPLE", isVerdict ? input.observed : null, input.observed);
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function recordRemCandidateCapCounts(input: {
	database: RemDatabaseLike;
	generationId: string;
	total: number;
	cap: number;
}): void {
	input.database
		.prepare(
			`INSERT INTO nodix_rem_batch_summaries(
				batch_id, generation_id, pre_truncation_count, emitted_count
			) VALUES (?, ?, ?, ?)`,
		)
		.run(`candidate-cap:${input.generationId}`, input.generationId, input.total, Math.min(input.total, input.cap));
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function reportRemSimilarityCalibration(input: {
	retainedArtifactPath: string;
	emittedPairIds: readonly string[];
	targetPairIds: readonly string[];
	rankedPairIds: readonly string[];
	modelCallBudget: number;
}): Record<string, unknown> {
	const bytes = readFileSync(input.retainedArtifactPath);
	JSON.parse(bytes.toString("utf8"));
	const emitted = new Set(input.emittedPairIds);
	const targets = new Set(input.targetPairIds);
	const emittedTargetCount = [...targets].filter((pairId) => emitted.has(pairId)).length;
	return {
		emittedFraction: targets.size === 0 ? 0 : emittedTargetCount / targets.size,
		targetRanks: input.targetPairIds.map((pairId) => input.rankedPairIds.indexOf(pairId) + 1),
		adjudicationReachability: input.targetPairIds.map((pairId) => emitted.has(pairId)),
		modelCallBudget: input.modelCallBudget,
		consumedArtifactSha256: sha256(bytes),
	};
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function validateRemCalibrationCrossCheck(input: { independent: unknown }): Decision {
	return input.independent === null || input.independent === undefined
		? { decision: "refuse", reasonCode: "independent_count_missing" }
		: { decision: "allow", reasonCode: null };
}

function isSha256(value: string): boolean {
	return /^[0-9a-f]{64}$/u.test(value);
}

function readModelContent(body: unknown): string {
	if (typeof body !== "object" || body === null) throw new Error("model response is invalid");
	const choices = (body as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) throw new Error("model response is invalid");
	const message = (choices[0] as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) throw new Error("model response is invalid");
	const content = (message as { content?: unknown }).content;
	if (typeof content !== "string") throw new Error("model response is invalid");
	return content;
}
