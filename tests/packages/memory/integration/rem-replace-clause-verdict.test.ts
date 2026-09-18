import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	arbitrateReplaceVerdicts,
	buildReplaceEligibleClauses,
	parseReplaceClauseVerdict,
	renderReplaceClauseVerdictPrompt,
	type ReplaceClauseVerdict,
	type UsableReplaceClauseVerdict,
} from "../../../../packages/sno-station-mem/src/engine/rem/index.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const fixturePath = join(
	repoRoot,
	"packages/sno-station-mem/fixtures/replace-clause-verdict-gold/corpus.json",
);

interface GoldCase {
	id: string;
	older: string;
	newer: string;
	response: unknown;
	expected: { verdict: ReplaceClauseVerdict; retiring_clause_indices: number[] };
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	schema_version: number;
	measurement_scope: string;
	cases: GoldCase[];
};

describe("REM replace clause verdict", () => {
	it("uses lossless fixed clauses and independently hand-labelled gold cases", () => {
		expect(fixture.schema_version).toBe(1);
		expect(fixture.measurement_scope).toContain("no live model call");
		expect(fixture.cases.some((testCase) => testCase.id === "oov-argon-schedule")).toBe(true);
		for (const testCase of fixture.cases) {
			const clauses = buildReplaceEligibleClauses(testCase.older, testCase.newer);
			expect(
				clauses
					.filter((clause) => clause.origin === "older")
					.map((clause) => `${clause.value}${clause.separatorAfter}`)
					.join(""),
			).toBe(testCase.older);
			expect(
				clauses
					.filter((clause) => clause.origin === "newer")
					.map((clause) => `${clause.value}${clause.separatorAfter}`)
					.join(""),
			).toBe(testCase.newer);
			expect(parseReplaceClauseVerdict(testCase.response, clauses)).toEqual({
				parseState: "valid",
				verdict: testCase.expected.verdict,
				retiringClauseIndices: testCase.expected.retiring_clause_indices,
			});
			const prompt = renderReplaceClauseVerdictPrompt(clauses);
			expect(prompt).toContain(JSON.stringify(clauses));
			expect(prompt).toContain("replacement: the newer memory supersedes the older memory");
			expect(prompt).toContain("keep: the two memories should remain independently active");
			expect(prompt).toContain(
				"uncertain: you cannot determine whether the newer memory replaces the older memory",
			);
		}
	});

	it("marks malformed, fabricated, duplicate, newer-side, and off-enum output as parse failures", () => {
		const clauses = buildReplaceEligibleClauses("Old value.", "New value.");
		for (const response of [
			null,
			{ verdict: "close", retiring_clause_indices: [0] },
			{ verdict: "replacement", retiring_clause_indices: [0, 0] },
			{ verdict: "replacement", retiring_clause_indices: [1] },
			{ verdict: "replacement", retiring_clause_indices: [9] },
			{ verdict: "replacement", retiring_clause_indices: [0], fabricated: true },
		]) {
			expect(parseReplaceClauseVerdict(response, clauses)).toEqual({
				parseState: "invalid",
				verdict: "uncertain",
				retiringClauseIndices: [],
			});
		}
		expect(
			parseReplaceClauseVerdict({ verdict: "keep", retiring_clause_indices: [0] }, clauses),
		).toEqual({ parseState: "valid", verdict: "keep", retiringClauseIndices: [0] });
		expect(
			arbitrateReplaceVerdicts("replacement", {
				parseState: "valid",
				verdict: "keep",
				retiringClauseIndices: [0],
			}),
		).toEqual({ outcome: "proceed", retiringClauseIndices: [0] });
	});

	it("requires both judges to authorize a non-empty retiring side", () => {
		const clauseVerdicts: UsableReplaceClauseVerdict[] = [
			{ parseState: "valid", verdict: "replacement", retiringClauseIndices: [0] },
			{ parseState: "valid", verdict: "replacement", retiringClauseIndices: [] },
			{ parseState: "valid", verdict: "keep", retiringClauseIndices: [] },
			{ parseState: "valid", verdict: "uncertain", retiringClauseIndices: [] },
		];
		for (const pairVerdict of ["replacement", "keep", "uncertain"] as const) {
			for (const clauseVerdict of clauseVerdicts) {
				const result = arbitrateReplaceVerdicts(pairVerdict, clauseVerdict);
				if (pairVerdict !== "replacement") {
					expect(result).toEqual({ outcome: "no-action" });
				} else if (
					clauseVerdict.verdict === "replacement" &&
					clauseVerdict.retiringClauseIndices.length
				) {
					expect(result).toEqual({ outcome: "proceed", retiringClauseIndices: [0] });
				} else {
					expect(result.outcome).toBe("refused");
				}
			}
		}
	});

	it("refuses an invalid clause response under a distinct durable reason", () => {
		expect(
			arbitrateReplaceVerdicts("replacement", {
				parseState: "invalid",
				verdict: "uncertain",
				retiringClauseIndices: [],
			}),
		).toEqual({ outcome: "refused", reason: "clause_parse_failed" });
	});
});
