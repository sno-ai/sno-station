import { splitExactClauses } from "./clause-splitter.js";

export type ReplaceClauseVerdict = "replacement" | "keep" | "uncertain";

export interface ReplaceEligibleClause {
	origin: "older" | "newer";
	value: string;
	start: number;
	end: number;
	separatorAfter: string;
}

export interface UsableReplaceClauseVerdict {
	parseState: "valid" | "invalid";
	verdict: ReplaceClauseVerdict;
	retiringClauseIndices: number[];
}

export type ReplaceArbitration =
	| { outcome: "proceed"; retiringClauseIndices: number[] }
	| { outcome: "no-action" }
	| {
			outcome: "refused";
			reason:
				| "clause_keep"
				| "clause_parse_failed"
				| "clause_uncertain"
				| "empty_retiring_set";
	  };

export function buildReplaceEligibleClauses(
	older: string,
	newer: string,
): ReplaceEligibleClause[] {
	return [
		...splitExactClauses(older).map((clause) => ({ origin: "older" as const, ...clause })),
		...splitExactClauses(newer).map((clause) => ({ origin: "newer" as const, ...clause })),
	];
}

export function renderReplaceClauseVerdictPrompt(
	clauses: readonly ReplaceEligibleClause[],
): string {
	return [
		"Judge whether the newer memory replaces the older memory.",
		"replacement: the newer memory supersedes the older memory, so one or more older clauses should retire.",
		"keep: the two memories should remain independently active because they are compatible, describe different facts, or the newer memory does not establish a replacement.",
		"uncertain: you cannot determine whether the newer memory replaces the older memory from the supplied content; take no action.",
		'Return JSON only: {"verdict":"replacement|keep|uncertain","retiring_clause_indices":[0]}.',
		"Use only the zero-based indices in the supplied eligible clauses.",
		"A retiring clause must originate from the older memory. Do not produce text or explanations.",
		`Eligible clauses: ${JSON.stringify(clauses)}`,
	].join("\n\n");
}

export function parseReplaceClauseVerdict(
	response: unknown,
	clauses: readonly ReplaceEligibleClause[],
): UsableReplaceClauseVerdict {
	if (!isRecord(response)) return invalidVerdict();
	if (!hasOnlyKeys(response, ["verdict", "retiring_clause_indices"])) {
		return invalidVerdict();
	}
	const verdict = response["verdict"];
	const indices = response["retiring_clause_indices"];
	if (
		(verdict !== "replacement" && verdict !== "keep" && verdict !== "uncertain") ||
		!Array.isArray(indices) ||
		!indices.every((index) => Number.isInteger(index) && index >= 0 && index < clauses.length) ||
		new Set(indices).size !== indices.length ||
		indices.some((index) => clauses[index]?.origin !== "older")
	) {
		return invalidVerdict();
	}
	return { parseState: "valid", verdict, retiringClauseIndices: indices };
}

export function arbitrateReplaceVerdicts(
	pairVerdict: ReplaceClauseVerdict,
	clauseVerdict: UsableReplaceClauseVerdict,
): ReplaceArbitration {
	if (pairVerdict !== "replacement") return { outcome: "no-action" };
	if (clauseVerdict.parseState === "invalid") {
		return { outcome: "refused", reason: "clause_parse_failed" };
	}
	// DELETED as refusals, owner ruling 2026-08-11 — `clause_keep` and `clause_uncertain`. The pair
	// stage has already judged this pair a replacement; asking a second model the same question and
	// letting its answer veto the first is not a safety check, it is the same question twice with a
	// tie broken toward doing nothing. What the clause stage is FOR is naming which clauses retire,
	// and that answer is still required: an empty retiring set below still refuses, so a clause
	// verdict of keep or uncertain that names nothing stops here exactly as it did before. One that
	// names a retiring set now proceeds on it.
	if (clauseVerdict.retiringClauseIndices.length === 0) {
		return { outcome: "refused", reason: "empty_retiring_set" };
	}
	return { outcome: "proceed", retiringClauseIndices: clauseVerdict.retiringClauseIndices };
}

function invalidVerdict(): UsableReplaceClauseVerdict {
	return { parseState: "invalid", verdict: "uncertain", retiringClauseIndices: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && expected.every((key) => key in value);
}
