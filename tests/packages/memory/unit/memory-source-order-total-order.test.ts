/** @file memory-source-order-total-order.test.ts
 * @purpose Proves `compareMemorySourceOrder` is a total order — transitive — across rows that mix
 *          a resolved event date with an unresolved one, the case that used to form a cycle.
 * @boundary The pure comparator; no store, no I/O.
 *
 * The old comparator read the date term only when BOTH rows carried a `valid_from`, so a row whose
 * time phrase the model could not resolve (`valid_from` null) tied on the date and fell through to
 * the session tie-breaks. Three rows of one session — one dated later, one undated, one dated
 * earlier — then ordered A < B < C < A, and `closeMemoryRow` uses this comparator as the guard
 * that decides which of two rows may close the other.
 */

import { describe, expect, it } from "vitest";

import {
	compareMemorySourceOrder,
	type MemorySourceOrder,
} from "@/storage/memory-source-order";

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);
const flip = (n: -1 | 0 | 1): -1 | 0 | 1 => (n === 0 ? 0 : ((-n) as -1 | 1));

/** Every ordered triple stays consistent: no cycle, and the relation is antisymmetric. */
function assertTotalOrder(rows: readonly MemorySourceOrder[]): void {
	for (const a of rows) {
		for (const b of rows) {
			expect(sign(compareMemorySourceOrder(a, b)), "not antisymmetric").toBe(
				flip(sign(compareMemorySourceOrder(b, a))),
			);
			for (const c of rows) {
				const ab = sign(compareMemorySourceOrder(a, b));
				const bc = sign(compareMemorySourceOrder(b, c));
				if (ab === bc && ab !== 0) {
					expect(sign(compareMemorySourceOrder(a, c)), "not transitive").toBe(ab);
				}
			}
		}
	}
}

describe("compareMemorySourceOrder is a total order", () => {
	it("does not cycle when one row of a session has an unresolved date", () => {
		// The measured cycle: A dated later, B undated, C dated earlier, one session in turn order.
		const a: MemorySourceOrder = {
			valid_from: 200,
			session_moment: 50,
			session_ordinal: 1,
			global_turn_index: 1,
			rowid: 1,
		};
		const b: MemorySourceOrder = {
			valid_from: null,
			session_moment: 50,
			session_ordinal: 1,
			global_turn_index: 2,
			rowid: 2,
		};
		const c: MemorySourceOrder = {
			valid_from: 100,
			session_moment: 50,
			session_ordinal: 1,
			global_turn_index: 3,
			rowid: 3,
		};
		assertTotalOrder([a, b, c]);
		// The undated row is ordered by its session moment (50), below both dated rows.
		expect(sign(compareMemorySourceOrder(b, c)), "undated row did not sort by its session moment")
			.toBe(-1);
		expect(sign(compareMemorySourceOrder(c, a)), "the two dated rows lost their date order").toBe(
			-1,
		);
	});

	it("orders two dated rows byte-identically to a plain valid_from compare", () => {
		const earlier: MemorySourceOrder = {
			valid_from: 100,
			session_moment: 999,
			session_ordinal: 9,
			global_turn_index: 9,
			rowid: 9,
		};
		const later: MemorySourceOrder = {
			valid_from: 200,
			session_moment: 1,
			session_ordinal: 1,
			global_turn_index: 1,
			rowid: 1,
		};
		// The date decides, and the session tie-breaks — pointed the other way — never get a vote.
		expect(sign(compareMemorySourceOrder(earlier, later))).toBe(-1);
	});

	it("ranks a later session's undated statement above an earlier dated one", () => {
		// A dated fact from week one, and a 'recently' from week five the model could not resolve.
		const earlyDated: MemorySourceOrder = {
			valid_from: 1_000,
			session_moment: 1_000,
			session_ordinal: 1,
			global_turn_index: 1,
			rowid: 1,
		};
		const laterUndated: MemorySourceOrder = {
			valid_from: null,
			session_moment: 5_000,
			session_ordinal: 5,
			global_turn_index: 1,
			rowid: 2,
		};
		expect(
			sign(compareMemorySourceOrder(earlyDated, laterUndated)),
			"the later undated statement did not outrank the earlier dated one",
		).toBe(-1);
	});
});
