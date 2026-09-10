/** @file retrieval-gate.test.ts
 * @purpose Pins what is left of the retrieval gate after PRD 100: length, and nothing else.
 * @boundary The real `shouldSkipRetrieval`. No store, no model — the function is pure.
 */

import { describe, expect, it } from "vitest";
import { shouldSkipRetrieval } from "../../../../apps/mem-claw/src/retrieval/retrieval-gate.ts";

describe("retrieval gate", () => {
	it("searches on every turn that carries something to search for", () => {
		// Each of these matched a former skip pattern and was never searched. The banks are gone
		// (PRD 100), so wording no longer decides. Retrieval is local SQLite plus local embeddings.
		for (const query of [
			"thanks",
			"ok",
			"git status",
			"hi",
			"good morning",
			"go ahead",
			"ping",
			"你好",
			"Charlie Parker",
			"Berlin move",
			"ok thanks",
		]) {
			expect(shouldSkipRetrieval(query), `"${query}" must reach the store`).toBe(false);
		}
	});

	it("still skips when there is genuinely nothing to search for", () => {
		// The mechanical floor, not a judgement about the words. Default is 2.
		for (const nothing of ["", " ", "\n\n", "a", " a "]) {
			expect(shouldSkipRetrieval(nothing), `${JSON.stringify(nothing)} has nothing to search`).toBe(
				true,
			);
		}
	});

	it("compares strictly, so a query exactly at the floor is searched", () => {
		// The disposition table says `length < effectiveMinLength`. Two characters is not less
		// than two. Written as its own case because an off-by-one here silently stops searching
		// every two-character query in the product.
		expect(shouldSkipRetrieval("hi")).toBe(false);
		expect(shouldSkipRetrieval("嗨嗨")).toBe(false);
		expect(shouldSkipRetrieval("a", 1)).toBe(false);
	});

	it("honours a caller that raises the floor, which is the one released knob", () => {
		// `autoRecallMinLength` is declared in the plugin manifest; the gate must keep obeying it.
		expect(shouldSkipRetrieval("hello", 6)).toBe(true);
		expect(shouldSkipRetrieval("hello!", 6)).toBe(false);
		expect(shouldSkipRetrieval("Lisbon")).toBe(false);
		expect(shouldSkipRetrieval("Lisbon", 20)).toBe(true);
	});

	it("treats a question mark as content even below the floor", () => {
		// Surviving behaviour, unchanged by PRD 100 and pinned so a later edit cannot drop it.
		expect(shouldSkipRetrieval("?", 20)).toBe(false);
		expect(shouldSkipRetrieval("？", 20)).toBe(false);
	});

	it("strips transport wrappers before measuring, and measures only what is left", () => {
		// `normalizeQuery` survives PRD 100 because it cannot drop a request, only clean one.
		// A cron wrapper around nothing is nothing; a wrapper around a real question is a question.
		expect(shouldSkipRetrieval("[cron:daily] ")).toBe(true);
		expect(shouldSkipRetrieval("[cron:daily] where do I live?")).toBe(false);
		expect(shouldSkipRetrieval("[Mon 2026-03-02 04:21 GMT+8] Berlin")).toBe(false);
	});
});
