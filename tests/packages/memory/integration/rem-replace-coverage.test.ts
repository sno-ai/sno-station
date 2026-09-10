import { describe, expect, it } from "vitest";

import { decideReplaceCoverage } from "../../../../packages/sno-station-mem/src/engine/rem/index.ts";

describe("REM replace coverage", () => {
	it.each([
		{
			name: "refuses an omitted current fact",
			input: {
				older: "The user preferred coffee. The user works late.", newer: "The user now prefers tea.",
				retiringClauseIndices: [0],
				atoms: [{ clauseIndex: 0, class: "retired-fact", status: "covered" }, { clauseIndex: 1, class: "current-fact", status: "uncovered" }],
			}, reason: "atom_uncovered",
		},
		{
			name: "refuses an event when the retrievability port is absent",
			input: { older: "The user attended the June review.", newer: "The user attended the July review.", retiringClauseIndices: [], atoms: [{ clauseIndex: 0, class: "event-fact", status: "covered" }] }, reason: "event_retrievability_port_missing",
		},
		{
			name: "refuses an undetermined atom whatever else is wrong with the accounting",
			input: { older: "First fact. Second fact.", newer: "Replacement.", retiringClauseIndices: [], atoms: [{ clauseIndex: 0, class: "current-fact", status: "undetermined" }] }, reason: "atom_undetermined",
		},
	] as const)("$name", async ({ input, reason }) => {
		expect(await decideReplaceCoverage(input)).toMatchObject({ decision: "refuse", reason });
	});

	// The two rows this replaces asserted `retiring_side_mismatch` and
	// `incomplete_clause_accounting` still refuse. Both were deleted as refusals on 2026-08-11 —
	// neither says a fact is being lost, and both abandoned work two verdict stages had authorized.
	// A test that they still bite would now pin the defect, so what has to hold instead is that the
	// close proceeds AND the condition is still counted. Both halves are asserted: an allow with the
	// observation dropped would pass a weaker reading while making the deletion unmeasurable, which
	// is the whole reason the observation exists.
	it.each([
		{
			name: "a retiring fact the clause stage did not name",
			input: { older: "The user preferred coffee.", newer: "The user now prefers tea.", retiringClauseIndices: [], atoms: [{ clauseIndex: 0, class: "retired-fact", status: "covered" }] },
			code: "retiring_side_mismatch",
		},
		{
			name: "an atom list that does not enumerate every older clause",
			input: { older: "First fact. Second fact.", newer: "Replacement.", retiringClauseIndices: [], atoms: [{ clauseIndex: 0, class: "current-fact", status: "covered" }] },
			code: "incomplete_clause_accounting",
		},
	] as const)("allows and counts: $name", async ({ input, code }) => {
		const decision = await decideReplaceCoverage(input);
		expect(decision).toMatchObject({ decision: "allow" });
		expect(
			decision.decision === "allow" ? (decision.observations ?? []).map((o) => o.code) : [],
		).toContain(code);
	});

	// ACC-42 / REQ-44, owner ruling 2026-08-13: the count is of conditions DETECTED, not of
	// conditions that let a close through. Until today an observation rode only on an `allow`, so a
	// condition a refusing pair exhibited was seen and then discarded — leaving exactly the
	// unmeasurable state the deletions were supposed to end. Every case below refuses AND has already
	// seen a condition, and asserts the condition survives the refusal by field name. `reason` is
	// asserted too: carrying the observation must not change which refusal was raised.
	it.each([
		{
			name: "an atom list short of the older clause set, then an uncovered atom",
			input: {
				older: "First fact. Second fact.",
				newer: "Replacement.",
				retiringClauseIndices: [],
				atoms: [{ clauseIndex: 0, class: "current-fact", status: "uncovered" }],
			},
			reason: "atom_uncovered",
			codes: ["incomplete_clause_accounting"],
		},
		{
			name: "a retiring fact the clause stage did not name, then an uncovered atom",
			input: {
				older: "The user preferred coffee. The user works late.",
				newer: "The user now prefers tea.",
				retiringClauseIndices: [],
				atoms: [
					{ clauseIndex: 0, class: "retired-fact", status: "covered" },
					{ clauseIndex: 1, class: "current-fact", status: "uncovered" },
				],
			},
			reason: "atom_uncovered",
			codes: ["retiring_side_mismatch"],
		},
		{
			// One pair exhibiting both. A refusal that carried only the condition it happened to see
			// first would pass either single-condition case above and still lose half the count.
			name: "both deleted conditions on one pair, then an uncovered atom",
			input: {
				older: "First fact. Second fact. Third fact.",
				newer: "Replacement.",
				retiringClauseIndices: [],
				atoms: [
					{ clauseIndex: 0, class: "retired-fact", status: "covered" },
					{ clauseIndex: 1, class: "current-fact", status: "uncovered" },
				],
			},
			reason: "atom_uncovered",
			codes: ["incomplete_clause_accounting", "retiring_side_mismatch"],
		},
	] as const)("refuses and still counts: $name", async ({ input, reason, codes }) => {
		const decision = await decideReplaceCoverage(input);
		expect(decision).toMatchObject({ decision: "refuse", reason });
		expect(
			decision.decision === "refuse"
				? (decision.observations ?? []).map((observation) => observation.code).sort()
				: [],
		).toEqual([...codes].sort());
	});

	it("allows only complete covered clauses with retrieval retained", async () => {
		expect(await decideReplaceCoverage({
		older: "The user preferred coffee. The user works late.",
		newer: "The user now prefers tea. The user works late.",
		retiringClauseIndices: [0],
		atoms: [
			{ clauseIndex: 0, class: "retired-fact", status: "covered" },
			{ clauseIndex: 1, class: "current-fact", status: "covered" },
		],
	})).toMatchObject({ decision: "allow" });
	});
});

// The close demotes every chunk of the older row to history, so a clause the survivor does not
// already carry stops reaching an answer the moment the close lands. Deleting the accounting
// refusal is what lets a short or empty atom list through, so the clauses it never mentioned are
// what the caller must carry forward. This asserts the decision hands them over; the executor's own
// carry-forward write is covered where that write lives.
describe("clauses no atom certified", () => {
	it("names every older clause when the model returns no atoms at all", async () => {
		const decision = await decideReplaceCoverage({
			older: "The user preferred coffee. The user works late.",
			newer: "The user now prefers tea.",
			retiringClauseIndices: [0],
			atoms: [],
		});
		expect(decision).toMatchObject({ decision: "allow" });
		const uncertified = decision.decision === "allow" ? (decision.uncertifiedClauses ?? []) : [];
		// Punctuation does not create deterministic meaning units. The empty atom list hands the
		// model's one older unit to the carry-forward path.
		expect(uncertified).toHaveLength(1);
		expect(uncertified.join(" ")).toContain("works late");
	});

	it("names only the clause the model skipped", async () => {
		const decision = await decideReplaceCoverage({
			older: "The user preferred coffee. The user works late.",
			newer: "The user now prefers tea. The user works late.",
			retiringClauseIndices: [0],
			atoms: [{ clauseIndex: 0, class: "retired-fact", status: "covered" }],
		});
		expect(decision).toMatchObject({ decision: "allow" });
		const uncertified = decision.decision === "allow" ? (decision.uncertifiedClauses ?? []) : [];
		expect(uncertified).toHaveLength(1);
		expect(uncertified[0]).toContain("works late");
	});

	it("names nothing when every clause was certified", async () => {
		const decision = await decideReplaceCoverage({
			older: "The user preferred coffee. The user works late.",
			newer: "The user now prefers tea. The user works late.",
			retiringClauseIndices: [0],
			atoms: [
				{ clauseIndex: 0, class: "retired-fact", status: "covered" },
				{ clauseIndex: 1, class: "current-fact", status: "covered" },
			],
		});
		expect(decision).toMatchObject({ decision: "allow" });
		expect(decision.decision === "allow" ? decision.uncertifiedClauses : "unset").toBeUndefined();
	});
});
