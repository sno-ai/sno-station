/** @file runtime-wrapper-sanitizer.test.ts
 * @purpose Guards the wrapper stripper against consuming the user's own words.
 * @boundary Pure text transform; no model, no store. Runs before any model call in production.
 */

import { describe, expect, it } from "vitest";
import {
	stripLeadingRuntimeWrappers,
	stripRuntimeWrapperBoilerplate,
} from "../../../../packages/memory/src/engine/extraction/runtime-wrapper-sanitizer.ts";

/**
 * This runs on BOTH the ambient-learning normalization path and the extraction envelope path, so
 * anything it eats is gone before the model is ever asked. That is what made its one unbounded
 * pattern expensive: `You are running as a subagent\b.*?(?:$|(?<=\.)\s+)` consumed to end of line
 * whenever the phrase was not followed by a full stop plus whitespace, and a colon, a comma or no
 * punctuation at all meant the user's fact went with the wrapper.
 */
describe("runtime wrapper sanitizer", () => {
	it("keeps the user's fact when the wrapper phrase has no sentence end", () => {
		// Measured 2026-08-19: both of these produced "" — not a damaged message, an empty one.
		expect(
			stripLeadingRuntimeWrappers(
				"[Subagent Task] You are running as a subagent to record this: I just spent 12.69 on breakfast this morning",
			),
		).toBe("to record this: I just spent 12.69 on breakfast this morning");
		expect(
			stripLeadingRuntimeWrappers(
				"[Subagent Task]\nYou are running as a subagent to record this: I moved to Munich on the 14th",
			),
		).toBe("to record this: I moved to Munich on the 14th");
	});

	it("does not stop at a decimal point", () => {
		// The obvious bound — "strip to the first full stop" — silently truncates every price,
		// version number and decimal a user ever states. The bound is a full stop followed by
		// WHITESPACE, which is a sentence end; "12.69" is not one.
		const stripped = stripLeadingRuntimeWrappers(
			"[Subagent Task] You are running as a subagent to log: I paid 12.69 for v1.2.3 of the plugin",
		);
		expect(stripped).toContain("12.69");
		expect(stripped).toContain("v1.2.3");
	});

	it("still takes the whole wrapper sentence when there really is one", () => {
		expect(
			stripLeadingRuntimeWrappers(
				"[Subagent Task] You are running as a subagent. I just spent 12.69 on breakfast this morning",
			),
		).toBe("I just spent 12.69 on breakfast this morning");
		// Several wrapper sentences in a row all go, and the user's line survives.
		expect(
			stripLeadingRuntimeWrappers(
				"[Subagent Task] You are running as a subagent. Results auto-announce to your requester. I moved to Munich",
			),
		).toBe("I moved to Munich");
	});

	it("still strips a wrapper that carries nothing else", () => {
		expect(stripLeadingRuntimeWrappers("[Subagent Task]")).toBe("");
		expect(stripLeadingRuntimeWrappers("[Subagent Context]\nYou are running as a subagent.")).toBe(
			"",
		);
	});

	it("leaves boilerplate-shaped user content alone when no wrapper preceded it", () => {
		// The existing invariant this file must not break: a user who happens to write one of these
		// phrases is stating a fact, not carrying an orchestration envelope.
		const userSaid = "Do not use any memory tools. That is my rule for this project.";
		expect(stripLeadingRuntimeWrappers(userSaid)).toBe(userSaid);
	});

	it("the probe regex still agrees with the stripper", () => {
		// They are a documented pair — the non-global probe decides whether to run the global
		// stripper — and a past bug came from letting them diverge. Anything the stripper changes,
		// the probe must have detected; anything it leaves alone, the probe must not claim.
		for (const phrase of [
			"You are running as a subagent",
			"Results auto-announce to your requester.",
			"do not busy-poll for status.",
			"Reply with a brief acknowledgment only.",
			"Do not use any memory tools.",
		]) {
			expect(stripRuntimeWrapperBoilerplate(phrase)).toBe("");
		}
		// And a line the stripper must not touch at all.
		const untouched = "I moved to Munich on the 14th";
		expect(stripRuntimeWrapperBoilerplate(untouched)).toBe(untouched);
	});
});
