import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { RemRepository } from "./repository.js";
import type { RemOwner, RemRowState } from "./types.js";

export const REM_TRANSITION_GRAMMAR_SHA256 =
	"8fd5439ec2b85ca27bfa462600869973f991a6f44f956c734596ee9c9d44153d";
export const REM_ADDITIONAL_TRANSITION_PATTERN_SHA256 =
	"cb42c6a25ccd51b16da6a3de7d931f1165af284a89cdc365860bd359ae84bd9f";
export const REM_CURRENT_PROGRESSIVE_PATTERN_SHA256 =
	"ddc1c0119c1f9c4e5178dc0e6eec9ca8a7594ed10e2dd8305646f5363e9d24ad";
export const REM_HISTORICAL_FACT_PATTERN_SHA256 =
	"c5a9cdc0bc2936e6c0252e7c785accf1e3cef646921b92e736d01811c92838ff";
export const REM_PURE_NEGATION_PATTERN_SHA256 =
	"610118ddf1ba956d7082b7f0b7e265f1fcbf81655a9f0e3f6ce753c0df2cbc1d";
export const REM_AMBIGUOUS_PATTERN_SHA256 =
	"ba3ac7245cd7c6d9178989b4d8f95b000467244b028308916354a0fa653f954a";

const REM_TRANSITION_PATTERN =
	"\\b(no longer|not longer|removed|remove[ds]?|deleted|dropped|used to|previously|formerly|past|already (?:done|completed|finished)|completed|finished|grew out of|grown out of|moved (?:(?:away|on) )?from|switched (?:from|away)|replaced|instead of|rather than|has been|was )\\b";
const REM_ADDITIONAL_TRANSITION_PATTERN =
	"(?:\\b(?:(?:shifted|switched|moved|changed|transitioned)\\b[\\s\\S]{0,120}?\\bfrom\\b[\\s\\S]{0,120}?\\bto\\b|(?:a|the)\\s+(?:shift|switch|move|change|transition)\\s+from\\b|(?:is|are|was|were)\\s+not\\s+included\\b|exclud(?:e|es|ed|ing)\\b|(?:updated|revised)\\s+from\\b|instead\\b|wechselte\\b[\\s\\S]{0,120}?\\bvon\\b[\\s\\S]{0,120}?\\bzu\\b)|cambió[\\s\\S]{0,120}?\\sde\\s[\\s\\S]{0,120}?\\sa\\s|est\\s+passé[\\s\\S]{0,120}?\\sdu\\s[\\s\\S]{0,120}?\\sau\\s|переш[её]л[\\s\\S]{0,120}?\\sс\\s[\\s\\S]{0,120}?\\sна\\s|从[\\s\\S]{0,120}?改为|從[\\s\\S]{0,120}?改為|から[\\s\\S]{0,120}?に切り替えた|에서[\\s\\S]{0,120}?로\\s+바꾸었다)";
const REM_CURRENT_PROGRESSIVE_PATTERN = "\\bhas\\s+been\\s+[a-z]+ing\\b";
const REM_HISTORICAL_FACT_PATTERN =
	"^\\s*On\\s+\\d{4}-\\d{2}-\\d{2}\\b[\\s\\S]*\\b(?:was|were)\\b";
const REM_PURE_NEGATION_PATTERN =
	"^\\s*(?![\\s\\S]*\\b(?:instead|rather\\s+than|(?:shift|switch|move|change|transition)(?:ed|es|ing)?\\s+(?:from|to|away\\s+from))\\b)(?![\\s\\S]*\\b(?:remove|delete|drop)\\b[\\s\\S]*\\b(?:from|in|on)\\b)(?:The user\\s+)?(?:(?:has\\s+)?(?:grown|grew)\\s+out\\s+of|no\\s+longer\\s+[^\\s.!?;,:]+|(?:does|do)\\s+not\\s+[^\\s.!?;,:]+|(?:gave|give)\\s+up|(?:stopped|stop)\\s+[^\\s.!?;,:]+)[\\s\\S]*$";
const REM_AMBIGUOUS_PATTERN =
	"\\b(?:no\\s+longer|(?:do|does|did)\\s+not|(?:gave|give)\\s+up|(?:stopped|stop)\\s+\\S+|(?:grew|grown)\\s+out\\s+of|(?:lost|lose)\\s+interest)\\b";

const classifierPopulationSchema = z
	.object({
		grammar: z
			.object({
				pattern: z.string().min(1),
				flags: z.literal("IGNORECASE"),
				sha256: z.string().regex(/^[0-9a-f]{64}$/),
			})
			.passthrough(),
		router: z
			.object({
				version: z.literal(2),
				flags: z.literal("IGNORECASE"),
				additionalTransitionPattern: z.string().min(1),
				additionalTransitionPatternSha256: z.string().regex(/^[0-9a-f]{64}$/),
				currentProgressivePattern: z.string().min(1),
				currentProgressivePatternSha256: z.string().regex(/^[0-9a-f]{64}$/),
				historicalFactPattern: z.string().min(1),
				historicalFactPatternSha256: z.string().regex(/^[0-9a-f]{64}$/),
				pureNegationPattern: z.string().min(1),
				pureNegationPatternSha256: z.string().regex(/^[0-9a-f]{64}$/),
				ambiguousPattern: z.string().min(1),
				ambiguousPatternSha256: z.string().regex(/^[0-9a-f]{64}$/),
			})
			.passthrough(),
		rows: z
			.array(
				z
					.object({
						rowId: z.string().min(1),
						text: z.string().min(1),
						contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
					})
					.passthrough(),
			)
			.min(1),
	})
	.passthrough();

export interface RemClassifiedRow {
	rowId: string;
	text: string;
	contentHash: string;
	state: RemRowState;
	owner: RemOwner;
	ambiguous: boolean;
}

/** Classifies one live database row with the same pinned router used by the conformance entry. */
export function classifyRemRow(row: {
	rowId: string;
	text: string;
	contentHash: string;
}): RemClassifiedRow {
	assertProductionPatternPins();
	return classifyRow(
		row,
		new RegExp(REM_TRANSITION_PATTERN, "i"),
		new RegExp(REM_ADDITIONAL_TRANSITION_PATTERN, "i"),
		new RegExp(REM_CURRENT_PROGRESSIVE_PATTERN, "i"),
		new RegExp(REM_HISTORICAL_FACT_PATTERN, "i"),
		new RegExp(REM_PURE_NEGATION_PATTERN, "i"),
		new RegExp(REM_AMBIGUOUS_PATTERN, "i"),
	);
}

export interface RemClassifierCounts {
	total: number;
	transition: number;
	staleCurrent: number;
	pureNegation: number;
	ambiguous: number;
}

export interface RemClassifierClaims {
	claimed: string[];
	skipped: string[];
	refused: Array<{
		rowId: string;
		reason: "content_changed" | "already_claimed" | "missing";
	}>;
}

export interface RemClassifierReport {
	counts: RemClassifierCounts;
	rows: RemClassifiedRow[];
	claims?: RemClassifierClaims;
}

export interface RemClassifierPersistence {
	repository: Pick<RemRepository, "recordClassification" | "claimRow">;
	classifiedAt: string;
	claimTs: string;
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function runVerdictClassifierEntry(
	populationValue: unknown,
	persistence?: RemClassifierPersistence,
): RemClassifierReport {
	return runClassifierEntry(populationValue, "verdict", persistence);
}

// Frozen, unwired, and kept in place by 60-rem-unbuilt-obligations-prd.md REQ-44; unfreezing is governed by REQ-45.
export function runRestateClassifierEntry(
	populationValue: unknown,
	persistence?: RemClassifierPersistence,
): RemClassifierReport {
	return runClassifierEntry(populationValue, "restate", persistence);
}

function runClassifierEntry(
	populationValue: unknown,
	actionOwner: Exclude<RemOwner, "none">,
	persistence: RemClassifierPersistence | undefined,
): RemClassifierReport {
	const population = classifierPopulationSchema.parse(populationValue);
	assertGrammarPin(population.grammar.pattern, population.grammar.sha256);
	assertRouterPin(population.router);
	assertUniqueRowIds(population.rows);
	const transitionPattern = new RegExp(population.grammar.pattern, "i");
	const additionalTransitionPattern = new RegExp(population.router.additionalTransitionPattern, "i");
	const currentProgressivePattern = new RegExp(population.router.currentProgressivePattern, "i");
	const historicalFactPattern = new RegExp(population.router.historicalFactPattern, "i");
	const pureNegationPattern = new RegExp(population.router.pureNegationPattern, "i");
	const ambiguousPattern = new RegExp(population.router.ambiguousPattern, "i");
	const rows = population.rows.map((row) =>
		classifyRow(
			row,
			transitionPattern,
			additionalTransitionPattern,
			currentProgressivePattern,
			historicalFactPattern,
			pureNegationPattern,
			ambiguousPattern,
		),
	);
	const report: RemClassifierReport = {
		counts: countRows(rows),
		rows,
	};
	if (!persistence) return report;
	if (population.rows.some((row) => row.contentHash === undefined)) {
		throw new Error("persisted classifier populations require stored contentHash values");
	}

	for (const row of rows) {
		persistence.repository.recordClassification({
			rowId: row.rowId,
			contentHash: row.contentHash,
			state: row.state,
			classifiedAt: persistence.classifiedAt,
		});
	}

	const claims: RemClassifierClaims = { claimed: [], skipped: [], refused: [] };
	for (const row of rows) {
		if (row.owner !== actionOwner) {
			claims.skipped.push(row.rowId);
			continue;
		}
		const result = persistence.repository.claimRow({
			rowId: row.rowId,
			contentHash: row.contentHash,
			owner: actionOwner,
			claimToken: randomUUID(),
			claimTs: persistence.claimTs,
			holderPid: process.pid,
		});
		if (result.claimed) claims.claimed.push(row.rowId);
		else claims.refused.push({ rowId: row.rowId, reason: result.reason });
	}
	return { ...report, claims };
}

function classifyRow(
	row: { rowId: string; text: string; contentHash?: string | undefined },
	transitionPattern: RegExp,
	additionalTransitionPattern: RegExp,
	currentProgressivePattern: RegExp,
	historicalFactPattern: RegExp,
	pureNegationPattern: RegExp,
	ambiguousPattern: RegExp,
): RemClassifiedRow {
	const isPureNegation = pureNegationPattern.test(row.text);
	const historicalCopulaIsOnlyTransition =
		historicalFactPattern.test(row.text) &&
		!withoutHistoricalCopulaBranch(transitionPattern).test(row.text);
	const isTransition =
		additionalTransitionPattern.test(row.text) ||
		(transitionPattern.test(row.text) &&
			!currentProgressivePattern.test(row.text) &&
			!historicalCopulaIsOnlyTransition);
	const ambiguous = !isPureNegation && !isTransition && ambiguousPattern.test(row.text);
	const state: RemRowState = isPureNegation
		? "pure-negation"
		: ambiguous
			? "ambiguous"
			: isTransition
				? "transition"
				: "stale-current";
	return {
		rowId: row.rowId,
		text: row.text,
		contentHash: row.contentHash ?? createHash("sha256").update(row.text).digest("hex"),
		state,
		owner: ownerForState(state),
		ambiguous,
	};
}

function assertProductionPatternPins(): void {
	assertPatternPin(
		REM_TRANSITION_PATTERN,
		REM_TRANSITION_GRAMMAR_SHA256,
		REM_TRANSITION_GRAMMAR_SHA256,
		"transition grammar",
	);
	assertPatternPin(
		REM_ADDITIONAL_TRANSITION_PATTERN,
		REM_ADDITIONAL_TRANSITION_PATTERN_SHA256,
		REM_ADDITIONAL_TRANSITION_PATTERN_SHA256,
		"additional transition pattern",
	);
	assertPatternPin(
		REM_CURRENT_PROGRESSIVE_PATTERN,
		REM_CURRENT_PROGRESSIVE_PATTERN_SHA256,
		REM_CURRENT_PROGRESSIVE_PATTERN_SHA256,
		"current-progressive pattern",
	);
	assertPatternPin(
		REM_HISTORICAL_FACT_PATTERN,
		REM_HISTORICAL_FACT_PATTERN_SHA256,
		REM_HISTORICAL_FACT_PATTERN_SHA256,
		"historical fact pattern",
	);
	assertPatternPin(
		REM_PURE_NEGATION_PATTERN,
		REM_PURE_NEGATION_PATTERN_SHA256,
		REM_PURE_NEGATION_PATTERN_SHA256,
		"pure-negation pattern",
	);
	assertPatternPin(
		REM_AMBIGUOUS_PATTERN,
		REM_AMBIGUOUS_PATTERN_SHA256,
		REM_AMBIGUOUS_PATTERN_SHA256,
		"ambiguous pattern",
	);
}

function ownerForState(state: RemRowState): RemOwner {
	if (state === "transition" || state === "ambiguous") return "restate";
	if (state === "stale-current") return "verdict";
	return "none";
}

function countRows(rows: readonly RemClassifiedRow[]): RemClassifierCounts {
	const counts: RemClassifierCounts = {
		total: rows.length,
		transition: 0,
		staleCurrent: 0,
		pureNegation: 0,
		ambiguous: 0,
	};
	for (const row of rows) {
		if (row.state === "transition") counts.transition += 1;
		else if (row.state === "stale-current") counts.staleCurrent += 1;
		else if (row.state === "pure-negation") counts.pureNegation += 1;
		if (row.ambiguous) counts.ambiguous += 1;
	}
	return counts;
}

function assertGrammarPin(pattern: string, declaredSha256: string): void {
	const observedSha256 = createHash("sha256").update(pattern).digest("hex");
	if (observedSha256 !== declaredSha256) {
		throw new Error(
			`transition grammar digest mismatch: declared ${declaredSha256}, observed ${observedSha256}`,
		);
	}
	if (observedSha256 !== REM_TRANSITION_GRAMMAR_SHA256) {
		throw new Error(
			`transition grammar is not pinned: expected ${REM_TRANSITION_GRAMMAR_SHA256}, observed ${observedSha256}`,
		);
	}
}

function assertRouterPin(router: {
	additionalTransitionPattern: string;
	additionalTransitionPatternSha256: string;
	currentProgressivePattern: string;
	currentProgressivePatternSha256: string;
	historicalFactPattern: string;
	historicalFactPatternSha256: string;
	pureNegationPattern: string;
	pureNegationPatternSha256: string;
	ambiguousPattern: string;
	ambiguousPatternSha256: string;
}): void {
	assertPatternPin(
		router.additionalTransitionPattern,
		router.additionalTransitionPatternSha256,
		REM_ADDITIONAL_TRANSITION_PATTERN_SHA256,
		"additional transition pattern",
	);
	assertPatternPin(
		router.currentProgressivePattern,
		router.currentProgressivePatternSha256,
		REM_CURRENT_PROGRESSIVE_PATTERN_SHA256,
		"current-progressive pattern",
	);
	assertPatternPin(
		router.historicalFactPattern,
		router.historicalFactPatternSha256,
		REM_HISTORICAL_FACT_PATTERN_SHA256,
		"historical fact pattern",
	);
	assertPatternPin(
		router.pureNegationPattern,
		router.pureNegationPatternSha256,
		REM_PURE_NEGATION_PATTERN_SHA256,
		"pure-negation pattern",
	);
	assertPatternPin(
		router.ambiguousPattern,
		router.ambiguousPatternSha256,
		REM_AMBIGUOUS_PATTERN_SHA256,
		"ambiguous pattern",
	);
}

function withoutHistoricalCopulaBranch(pattern: RegExp): RegExp {
	const source = pattern.source.replace("|was ", "");
	if (source === pattern.source) {
		throw new Error("transition grammar is missing the historical copula branch");
	}
	return new RegExp(source, pattern.flags);
}

function assertPatternPin(
	pattern: string,
	declaredSha256: string,
	expectedSha256: string,
	name: string,
): void {
	const observedSha256 = createHash("sha256").update(pattern).digest("hex");
	if (observedSha256 !== declaredSha256) {
		throw new Error(`${name} digest mismatch: declared ${declaredSha256}, observed ${observedSha256}`);
	}
	if (observedSha256 !== expectedSha256) {
		throw new Error(`${name} is not pinned: expected ${expectedSha256}, observed ${observedSha256}`);
	}
}

function assertUniqueRowIds(rows: ReadonlyArray<{ rowId: string }>): void {
	const seen = new Set<string>();
	for (const row of rows) {
		if (seen.has(row.rowId)) throw new Error(`duplicate classifier row id: ${row.rowId}`);
		seen.add(row.rowId);
	}
}
