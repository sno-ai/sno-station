/** @file runtime-wrapper-sanitizer.ts
 * @purpose Single source of truth for stripping `[Subagent Context|Task]` wrappers
 *          and the boilerplate that follows them from the lead-in of captured text.
 * @boundary Used by both `memory-extraction-pipeline.ts` (envelope path) and
 *           `ambient-learning-text-normalizer.ts` (ambient-learning normalization path) so the same
 *           input always produces the same stripped output regardless of entry point.
 * @see memory-extraction-pipeline.ts, ambient-learning-text-normalizer.ts.
 */

// LH: consolidated from two divergent in-file copies (insight-distill + ambient-learning-cleanup)
// LH: to fix Bug #2 — same input must produce same output regardless of which path runs.
// LH: host-review 2026-04-26.

const RUNTIME_WRAPPER_LINE_RE = /^\[(?:Subagent Context|Subagent Task)\]\s*/i;
const RUNTIME_WRAPPER_PREFIX_RE = /^\[(?:Subagent Context|Subagent Task)\]/i;
// EVERY alternative here strips its own fixed text and nothing more. The first one did not: it
// read `You are running as a subagent\b.*?(?:$|(?<=\.)\s+)`, and the `$` let it run to end of
// line whenever the phrase was not followed by a full stop plus whitespace. Measured 2026-08-19:
//   "[Subagent Task] You are running as a subagent to record this: I just spent 12.69 on
//    breakfast this morning"  ->  ""
// Not a damaged message — an empty one. The user's fact was consumed with the wrapper, before the
// model was ever asked, on both the ambient path and the extraction envelope path.
//
// The fix is not a smarter bound, because there is no string rule that can tell where a wrapper
// stops and a person starts. It strips the fixed phrase plus whatever punctuation is glued to it
// and stops there. A few words of envelope preamble may survive — "to record this:" — and the
// model can ignore those. Nothing a person wrote can be eaten, which is the property that matters.
//
// Note the bound must not be "up to the first full stop" either: that truncates every price,
// version number and decimal a user ever states.
const RUNTIME_WRAPPER_BOILERPLATE_RE =
	/(?:You are running as a subagent\b[.,;:!?]*\s*|Results auto-announce to your requester\.?\s*|do not busy-poll for status\.?\s*|Reply with a brief acknowledgment only\.?\s*|Do not use any memory tools\.?\s*)/gi;
// Non-global twin used purely as a `.test()` predicate inside the lead-in loop
// (global regexes carry lastIndex state that breaks repeated `.test()` calls).
const RUNTIME_WRAPPER_BOILERPLATE_PROBE_RE =
	/(?:You are running as a subagent\b|Results auto-announce to your requester|do not busy-poll for status|Reply with a brief acknowledgment only|Do not use any memory tools)/i;

/**
 * Strip every occurrence of runtime-wrapper boilerplate phrases from a single
 * text fragment, collapse internal whitespace, and trim. Used both for cleaning
 * the remainder of a wrapper line and for cleaning post-wrapper content lines
 * whose prefix looks like boilerplate but whose tail is real user content.
 */
export function stripRuntimeWrapperBoilerplate(text: string): string {
	return text
		.replace(RUNTIME_WRAPPER_BOILERPLATE_RE, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/**
 * Strip `[Subagent Context|Task]` wrapper lines and the boilerplate noise that
 * follows them from the leading edge of `text`. Anything past the first real
 * user content line is preserved untouched.
 *
 * Algorithm (single canonical impl):
 *   1. Skip leading blank lines.
 *   2. If the first non-blank line is a wrapper marker, strip its prefix and
 *      any inline boilerplate. Mark wrapper-encountered. Push only the cleaned
 *      remainder if non-empty; either way exit the leading wrapper region.
 *   3. After a wrapper has been seen, while still in the lead-in:
 *        - If the line contains boilerplate (full or prefix), strip it.
 *          - If the result is empty → drop the whole line.
 *          - If non-empty → push the cleaned text, exit lead-in.
 *        - If no boilerplate matches, push the line unchanged, exit lead-in.
 *   4. All subsequent lines pass through unchanged.
 */
export function stripLeadingRuntimeWrappers(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;

	const lines = trimmed.split("\n");
	const cleanedLines: string[] = [];
	let strippingLeadIn = true;
	// Track whether a wrapper marker was already seen — boilerplate-shaped
	// content before any wrapper is legitimate user text and must survive.
	let encounteredWrapperYet = false;

	for (const line of lines) {
		const current = line.trim();

		if (strippingLeadIn && current === "") {
			continue;
		}

		if (strippingLeadIn && RUNTIME_WRAPPER_PREFIX_RE.test(current)) {
			encounteredWrapperYet = true;
			const remainder = current.replace(RUNTIME_WRAPPER_LINE_RE, "").trim();
			const cleaned = remainder ? stripRuntimeWrapperBoilerplate(remainder) : "";
			if (cleaned) {
				cleanedLines.push(cleaned);
				strippingLeadIn = false;
			}
			continue;
		}

		// LH: fix asymmetric boilerplate stripping (Bug #1, host-review 2026-04-26).
		// Previously this branch only matched FULL-line boilerplate via an anchored
		// regex, so a line like "Results auto-announce to your requester. And X."
		// kept its boilerplate prefix when the wrapper was on its own line above.
		// Detect any boilerplate hit with a non-global probe regex, then run the
		// global stripper so prefix-with-content lines collapse the same way as
		// bare-boilerplate lines.
		if (
			strippingLeadIn &&
			encounteredWrapperYet &&
			RUNTIME_WRAPPER_BOILERPLATE_PROBE_RE.test(line)
		) {
			const cleaned = stripRuntimeWrapperBoilerplate(line);
			if (cleaned) {
				cleanedLines.push(cleaned);
				strippingLeadIn = false;
			}
			continue;
		}

		strippingLeadIn = false;
		cleanedLines.push(line);
	}

	return cleanedLines.join("\n").trim();
}
