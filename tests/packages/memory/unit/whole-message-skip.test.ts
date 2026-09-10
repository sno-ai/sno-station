/** @file whole-message-skip.test.ts
 * @purpose The single point the entire negative-pattern rule now rests on.
 * @boundary Pure predicate; no i18n load, no store, no model.
 */

import { describe, expect, it } from "vitest";
import { RESOURCES_BY_LOCALE } from "../../../../apps/mem-claw/src/i18n/all-resources.ts";
import {
	anyMatchesWholeMessage,
	matchesWholeMessage,
} from "../../../../apps/mem-claw/src/shared/whole-message-skip.ts";

describe("whole-message skip rule", () => {
	it("counts a pattern that accounts for the whole message", () => {
		expect(matchesWholeMessage(/^hi$/i, "hi")).toBe(true);
		// Trailing and leading whitespace is not content, so it must not defeat the rule.
		expect(matchesWholeMessage(/^hi$/i, "  hi  ")).toBe(true);
		expect(matchesWholeMessage(/^(hi|hello)(?=$|[^\p{L}\p{N}_])/iu, "hello")).toBe(true);
	});

	it("refuses a pattern that only accounts for a prefix", () => {
		// This is the entire point. Measured 2026-08-19, a greeting rule consuming just "Hi" out of
		// "Hi-Chew is the candy I always keep in the car" deleted the memory, and the same shape
		// destroyed a preference correction and four explicit deletion instructions on the Memora
		// corpus. A rule that cannot account for the whole message may not decide the whole message.
		const greeting = /^(hi|hello|hey|good morning|greetings)(?=$|[^\p{L}\p{N}_])/iu;
		for (const content of [
			"Hi-Chew is the candy I always keep in the car",
			"Hello Fresh is the meal kit I subscribe to",
			"Hey Arnold was my favourite cartoon growing up",
			"Good morning routine: gym at 6am, then coffee",
			"Greetings from Tokyo is what I wrote on the postcard",
		]) {
			// The pattern really does match — proving the refusal comes from the rule and not from
			// the pattern simply missing.
			expect(greeting.test(content)).toBe(true);
			expect(matchesWholeMessage(greeting, content)).toBe(false);
		}
	});

	it("refuses a substring match in the middle of a message", () => {
		const heartbeat = /\bHEARTBEAT\b/;
		expect(heartbeat.test("HEARTBEAT rate averaged 58 on my last run")).toBe(true);
		expect(matchesWholeMessage(heartbeat, "HEARTBEAT rate averaged 58 on my last run")).toBe(
			false,
		);
		expect(matchesWholeMessage(heartbeat, "HEARTBEAT")).toBe(true);
	});

	it("resets lastIndex so a /g pattern gives the same answer every call", () => {
		// A module-level /g regex carries lastIndex between calls. Without a reset the second call
		// starts mid-string and silently disagrees with the first — a shared pattern list is
		// exactly where that bites.
		const sticky = /marker/g;
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(matchesWholeMessage(sticky, "marker")).toBe(true);
			expect(sticky.lastIndex).toBe(0);
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			expect(matchesWholeMessage(sticky, "marker in a sentence")).toBe(false);
			expect(sticky.lastIndex).toBe(0);
		}
	});

	it("never counts empty or whitespace-only input as a match", () => {
		// An empty message carries nothing to skip, and a pattern that happens to match the empty
		// string would otherwise skip everything blank — including text that was blank only because
		// an upstream step failed.
		for (const blank of ["", "   ", "\n\t "]) {
			expect(matchesWholeMessage(/^.*$/, blank)).toBe(false);
			expect(anyMatchesWholeMessage([/^.*$/, /^$/], blank)).toBe(false);
		}
	});

	it("anyMatchesWholeMessage is true only when some pattern accounts for all of it", () => {
		const patterns = [/^ping$/i, /^(hi|hello)(?=$|[^\p{L}\p{N}_])/iu];
		expect(anyMatchesWholeMessage(patterns, "ping")).toBe(true);
		expect(anyMatchesWholeMessage(patterns, "hello")).toBe(true);
		expect(anyMatchesWholeMessage(patterns, "hello there, my name is Ada")).toBe(false);
		expect(anyMatchesWholeMessage([], "anything at all")).toBe(false);
	});

});
