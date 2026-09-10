/** @file Proves the recall packer's budget arithmetic, its skip-and-count rule, and its floor. */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_RECALL_TOKEN_BUDGET,
	estimateRecallRowTokens,
	MIN_RECALL_TOKEN_BUDGET,
	packRecallRows,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/recall-token-packer";

/** A row the size real recall serves: one atomic claim, a sentence or two. */
function memoryRow(id: string, chars: number): { id: string; text: string } {
	const body =
		"The user's project proposal records a decision, a figure and the person who owns it. ";
	return { id, text: body.repeat(Math.ceil(chars / body.length)).slice(0, chars) };
}

const text = (row: { text: string }): string => row.text;

describe("recall token packer", () => {
	it("uses the decided budget and the decided estimator", () => {
		expect(DEFAULT_RECALL_TOKEN_BUDGET).toBe(7_000);
		expect(MIN_RECALL_TOKEN_BUDGET).toBe(5_000);
		expect(estimateRecallRowTokens(0)).toBe(0);
		expect(estimateRecallRowTokens(1)).toBe(1);
		expect(estimateRecallRowTokens(4)).toBe(1);
		expect(estimateRecallRowTokens(5)).toBe(2);
		expect(estimateRecallRowTokens(20_141)).toBe(5_036);
	});

	it("serves every row that fits and reports the tokens it spent", () => {
		const rows = [memoryRow("a", 800), memoryRow("b", 1_200), memoryRow("c", 400)];
		const packed = packRecallRows(rows, text);
		expect(packed.rows).toHaveLength(3);
		expect(packed.dropped_count).toBe(0);
		expect(packed.budget_used).toBe(200 + 300 + 100);
	});

	it("skips an oversize row, counts it, and keeps packing the rows after it", () => {
		// The oversize row alone exceeds the whole budget; the small rows on either side must
		// still be served. A packer that stops at the first row it cannot fit loses them all.
		const rows = [
			memoryRow("small-first", 1_000),
			memoryRow("oversize", 40_000),
			memoryRow("small-last", 2_000),
		];
		const packed = packRecallRows(rows, text);
		expect(packed.rows.map((row) => row.id)).toEqual(["small-first", "small-last"]);
		expect(packed.dropped_count).toBe(1);
		expect(packed.budget_used).toBe(250 + 500);
	});

	it("drops only what does not fit once the budget is nearly spent", () => {
		// 6,800 tokens of head rows, then a 400-token row that cannot fit and a 100-token row
		// that can. Both later rows are judged against the REMAINING budget, not the whole one.
		const rows = [
			memoryRow("head", 27_200),
			memoryRow("too-big-now", 1_600),
			memoryRow("still-fits", 400),
		];
		const packed = packRecallRows(rows, text);
		expect(packed.rows.map((row) => row.id)).toEqual(["head", "still-fits"]);
		expect(packed.dropped_count).toBe(1);
		expect(packed.budget_used).toBe(6_800 + 100);
	});

	it("preserves the retrieval rank order it was given", () => {
		const rows = ["r1", "r2", "r3", "r4", "r5"].map((id, index) => memoryRow(id, 600 + index));
		const packed = packRecallRows(rows, text);
		expect(packed.rows.map((row) => row.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
	});

	it("refuses a budget below the floor instead of serving a thin context", () => {
		const rows = [memoryRow("a", 800)];
		expect(() => packRecallRows(rows, text, MIN_RECALL_TOKEN_BUDGET - 1)).toThrow(RangeError);
		expect(() => packRecallRows(rows, text, 0)).toThrow(RangeError);
		expect(() => packRecallRows(rows, text, Number.NaN)).toThrow(RangeError);
		expect(packRecallRows(rows, text, MIN_RECALL_TOKEN_BUDGET).rows).toHaveLength(1);
	});

	it("reports zeros for an empty result rather than failing", () => {
		const packed = packRecallRows([], text);
		expect(packed.rows).toEqual([]);
		expect(packed.budget_used).toBe(0);
		expect(packed.dropped_count).toBe(0);
	});

	it("suppresses a whole group once its newest member does not fit", () => {
		// A group's members arrive newest-first. The newest is oversize; a packer without group
		// awareness would drop it and then serve the smaller older sibling, presenting the group's
		// stale state with no current member. With the group key it drops the whole group.
		const rows = [
			{ ...memoryRow("newest", 40_000), group: "g" },
			{ ...memoryRow("older", 1_000), group: "g" },
			{ ...memoryRow("solo", 800), group: undefined },
		];
		const packed = packRecallRows(rows, text, DEFAULT_RECALL_TOKEN_BUDGET, (row) => row.group);
		expect(
			packed.rows.map((row) => row.id),
			"the older sibling was served without its group's newest member",
		).toEqual(["solo"]);
		expect(packed.dropped_count).toBe(2);
	});

	it("keeps an ungrouped row that fits even after a group is suppressed", () => {
		// The suppression is scoped to the group key: a row with no group, or a different group,
		// is packed on its own budget as always.
		const rows = [
			{ ...memoryRow("g1-newest", 40_000), group: "g1" },
			{ ...memoryRow("g1-older", 1_000), group: "g1" },
			{ ...memoryRow("g2-newest", 900), group: "g2" },
			{ ...memoryRow("loose", 700), group: undefined },
		];
		const packed = packRecallRows(rows, text, DEFAULT_RECALL_TOKEN_BUDGET, (row) => row.group);
		expect(packed.rows.map((row) => row.id)).toEqual(["g2-newest", "loose"]);
		expect(packed.dropped_count).toBe(2);
	});

	it("packs group members normally when the newest fits", () => {
		// Budget is ample: group awareness must not change the ordinary result.
		const rows = [
			{ ...memoryRow("newest", 600), group: "g" },
			{ ...memoryRow("older", 600), group: "g" },
			{ ...memoryRow("solo", 600), group: undefined },
		];
		const packed = packRecallRows(rows, text, DEFAULT_RECALL_TOKEN_BUDGET, (row) => row.group);
		expect(packed.rows.map((row) => row.id)).toEqual(["newest", "older", "solo"]);
		expect(packed.dropped_count).toBe(0);
	});
});
