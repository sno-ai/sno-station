import { z } from "zod";

import { extractJsonFromResponse } from "./adapter-a-conflict-adjudicator.js";

export type RemUpdateJudgmentRefusalReason =
	| "model_response_invalid"
	| "no_retired_fact"
	| "no_surviving_remainder";

export type RemUpdateJudgmentDecision =
	| { outcome: "verify"; proposedCurrent: string; retiredValues: string[] }
	| { outcome: "refuse"; reason: RemUpdateJudgmentRefusalReason };

export type RemUpdateVerificationDecision =
	| { outcome: "apply" }
	| {
			outcome: "refuse";
			reason:
				| "model_response_invalid"
				| "proposal_not_faithful"
				| "retired_value_survives"
				| "surviving_fact_lost";
	  };

export type RemClauseCarryDecision =
	| { outcome: "decided"; alreadyCurrent: boolean[] }
	| { outcome: "refuse"; reason: "model_response_invalid" };

const judgmentSchema = z
	.object({
		proposed_current: z.string(),
		retired_values: z.array(z.string()),
	})
	.strict();

const relationJudgmentSchema = z
	.object({
		supersedes: z.boolean(),
		retires_anything: z.boolean(),
		supersedes_everything: z.boolean(),
	})
	.strict();

const retirementTargetSchema = z
	.object({ target_row_ids: z.array(z.string().min(1)) })
	.strict();

const verificationSchema = z
	.object({
		faithful: z.boolean(),
		retired_absent: z.boolean(),
		all_facts_accounted: z.boolean(),
	})
	.strict();

export function renderRemUpdateJudgmentPrompt(input: {
	judgmentSkill: string;
	source: string;
	enumeratedMembers?: readonly string[];
	supersedingText?: string;
}): string {
	return [
		input.judgmentSkill,
		"Task: REM source rewrite.",
		'Return exactly one JSON object and no prose: {"proposed_current":"","retired_values":[]}.',
		"Use exactly those two fields and no additional fields.",
		"proposed_current must be a string.",
		"retired_values must be an array of strings.",
		`Source row: ${JSON.stringify(input.source)}`,
		...(input.enumeratedMembers === undefined
			? []
			: [`Code-enumerated members: ${JSON.stringify(input.enumeratedMembers)}`]),
		...(input.supersedingText === undefined
			? []
			: [`Newer record that supersedes part of this row: ${JSON.stringify(input.supersedingText)}`]),
	].join("\n\n");
}

export function renderRemUpdateRelationJudgmentPrompt(input: {
	judgmentSkill: string;
	rowText: string;
	predecessorTexts: readonly string[];
	successorTexts: readonly string[];
}): string {
	return [
		input.judgmentSkill,
		"Task: REM relation judgment.",
		'Return exactly one JSON object and no prose: {"supersedes":false,' +
			'"retires_anything":false,"supersedes_everything":false}.',
		"Use exactly those three fields and no additional fields.",
		"supersedes must be a boolean.",
		"retires_anything must be a boolean.",
		"supersedes_everything must be a boolean.",
		`Record under judgment: ${JSON.stringify(input.rowText)}`,
		`Older records: ${JSON.stringify(input.predecessorTexts)}`,
		`Other related records: ${JSON.stringify(input.successorTexts)}`,
	].join("\n\n");
}

export function renderRemRetirementTargetPrompt(input: {
	judgmentSkill: string;
	nominatedRow: { id: string; text: string };
	candidateRows: ReadonlyArray<{ id: string; text: string }>;
}): string {
	return [
		input.judgmentSkill,
		"Task: REM retirement target judgment.",
		'Return exactly one JSON object and no prose: {"target_row_ids":[]}.',
		"Use exactly that field and no additional fields.",
		"target_row_ids must contain only ids from Candidate rows and must not contain duplicates.",
		`Nominated row: ${JSON.stringify(input.nominatedRow)}`,
		`Candidate rows: ${JSON.stringify(input.candidateRows)}`,
	].join("\n\n");
}

export function renderRemUpdateVerificationPrompt(input: {
	judgmentSkill: string;
	source: string;
	proposedCurrent: string;
	retiredValues: readonly string[];
	retractionText?: string;
	supersedingText?: string;
}): string {
	return [
		input.judgmentSkill,
		"Task: REM rewrite verification.",
		'Return exactly one JSON object and no prose: {"faithful":false,' +
			'"retired_absent":false,"all_facts_accounted":false}.',
		"Use exactly those three fields and no additional fields.",
		...(input.retractionText === undefined
			? []
			: [
					"Judge whether the proposed rewrite follows from the relation between the original " +
						"row and the retraction row.",
				]),
		`Original row: ${JSON.stringify(input.source)}`,
		...(input.supersedingText === undefined
			? []
			: [`Newer record: ${JSON.stringify(input.supersedingText)}`]),
		...(input.retractionText === undefined
			? []
			: [`Retraction row: ${JSON.stringify(input.retractionText)}`]),
		`Proposed rewrite: ${JSON.stringify(input.proposedCurrent)}`,
		`Retired values: ${JSON.stringify(input.retiredValues)}`,
	].join("\n\n");
}

export function renderRemClauseCarryPrompt(input: {
	judgmentSkill: string;
	survivorText: string;
	clauses: readonly string[];
}): string {
	return [
		input.judgmentSkill,
		"Task: REM clause carry judgment.",
		"Return exactly one JSON object and no prose: {\"already_current\":[true,false]}.",
		"Use exactly that field and no additional fields.",
		"already_current must contain exactly one boolean per numbered clause, in the same order.",
		`Survivor text: ${JSON.stringify(input.survivorText)}`,
		...input.clauses.map(
			(clause, index) => `Clause ${index + 1}: ${JSON.stringify(clause)}`,
		),
	].join("\n\n");
}

export function decideRemUpdateRelationFromReply(
	reply: string,
):
	| { outcome: "allow"; supersedesEverything: boolean }
	| { outcome: "refuse"; reason: "no_retired_fact" | "model_response_invalid" } {
	const json = extractJsonFromResponse(reply);
	if (json === null) return { outcome: "refuse", reason: "model_response_invalid" };
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { outcome: "refuse", reason: "model_response_invalid" };
	}
	const parsed = relationJudgmentSchema.safeParse(value);
	if (!parsed.success) return { outcome: "refuse", reason: "model_response_invalid" };
	if (!parsed.data.supersedes || !parsed.data.retires_anything) {
		return { outcome: "refuse", reason: "no_retired_fact" };
	}
	return {
		outcome: "allow",
		supersedesEverything: parsed.data.supersedes_everything,
	};
}

export function decideRemRetirementTargetFromReply(
	reply: string,
	offeredRowIds: ReadonlySet<string>,
):
	| { outcome: "allow"; targetRowIds: string[] }
	| {
			outcome: "refuse";
			reason: "model_response_invalid" | "row_id_not_offered";
	  } {
	const json = extractJsonFromResponse(reply);
	if (json === null) return { outcome: "refuse", reason: "model_response_invalid" };
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { outcome: "refuse", reason: "model_response_invalid" };
	}
	const parsed = retirementTargetSchema.safeParse(value);
	if (!parsed.success) return { outcome: "refuse", reason: "model_response_invalid" };
	const targetRowIds = new Set(parsed.data.target_row_ids);
	if (targetRowIds.size !== parsed.data.target_row_ids.length) {
		return { outcome: "refuse", reason: "model_response_invalid" };
	}
	if ([...targetRowIds].some((rowId) => !offeredRowIds.has(rowId))) {
		return { outcome: "refuse", reason: "row_id_not_offered" };
	}
	return {
		outcome: "allow",
		targetRowIds: [...targetRowIds],
	};
}

export function decideRemUpdateFromReply(reply: string): RemUpdateJudgmentDecision {
	const parsed = parseJudgment(reply);
	if (parsed === undefined) return { outcome: "refuse", reason: "model_response_invalid" };
	if (parsed.retiredValues.length === 0) {
		return { outcome: "refuse", reason: "no_retired_fact" };
	}
	if (parsed.proposedCurrent.trim().length === 0) {
		return { outcome: "refuse", reason: "no_surviving_remainder" };
	}
	return { outcome: "verify", ...parsed };
}

export function decideRemUpdateVerification(reply: string): RemUpdateVerificationDecision {
	const json = extractJsonFromResponse(reply);
	if (json === null) return { outcome: "refuse", reason: "model_response_invalid" };
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { outcome: "refuse", reason: "model_response_invalid" };
	}
	const parsed = verificationSchema.safeParse(value);
	if (!parsed.success) return { outcome: "refuse", reason: "model_response_invalid" };
	if (!parsed.data.faithful) return { outcome: "refuse", reason: "proposal_not_faithful" };
	if (!parsed.data.retired_absent) {
		return { outcome: "refuse", reason: "retired_value_survives" };
	}
	if (!parsed.data.all_facts_accounted) {
		return { outcome: "refuse", reason: "surviving_fact_lost" };
	}
	return { outcome: "apply" };
}

export function decideRemClauseCarry(reply: string, clauseCount: number): RemClauseCarryDecision {
	if (!Number.isSafeInteger(clauseCount) || clauseCount < 0) {
		return { outcome: "refuse", reason: "model_response_invalid" };
	}
	const json = extractJsonFromResponse(reply);
	if (json === null) return { outcome: "refuse", reason: "model_response_invalid" };
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { outcome: "refuse", reason: "model_response_invalid" };
	}
	const parsed = z
		.object({
			already_current: z.array(z.boolean()).length(clauseCount),
		})
		.strict()
		.safeParse(value);
	if (!parsed.success) {
		return { outcome: "refuse", reason: "model_response_invalid" };
	}
	return { outcome: "decided", alreadyCurrent: parsed.data.already_current };
}

function parseJudgment(
	reply: string,
): { proposedCurrent: string; retiredValues: string[] } | undefined {
	const json = extractJsonFromResponse(reply);
	if (json === null) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	const parsed = judgmentSchema.safeParse(value);
	if (!parsed.success) return undefined;
	return {
		proposedCurrent: parsed.data.proposed_current,
		retiredValues: parsed.data.retired_values,
	};
}
