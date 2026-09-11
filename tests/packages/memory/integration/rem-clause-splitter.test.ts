import { describe, expect, it } from "vitest";

import { splitExactClauses } from "../../../../packages/sno-station-mem/src/engine/rem/index.ts";

describe("REM exact clause splitter", () => {
	it("preserves every source byte while exposing deterministic sentence, list, and clause boundaries", () => {
		const text = "First fact. Second fact; third fact,\nand fourth fact.";
		const clauses = splitExactClauses(text);

		expect(clauses.map((clause) => clause.value)).toEqual([
			"First fact.",
			"Second fact;",
			"third fact,",
			"and fourth fact.",
		]);
		expect(clauses.map((clause) => text.slice(clause.start, clause.end))).toEqual(
			clauses.map((clause) => clause.value),
		);
		expect(clauses.map((clause) => `${clause.value}${clause.separatorAfter}`).join("")).toBe(text);
	});

	it("keeps an undivided sentence as one exact clause instead of inventing a boundary", () => {
		expect(splitExactClauses("A compact statement without punctuation")).toEqual([
			{
				value: "A compact statement without punctuation",
				start: 0,
				end: 39,
				separatorAfter: "",
			},
		]);
	});

	it("refuses empty source text", () => {
		expect(() => splitExactClauses(" \n ")).toThrow("requires non-empty text");
	});
});
