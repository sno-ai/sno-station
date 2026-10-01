/** @file whole-message-skip.ts
 * @purpose The one rule that decides when a string pattern is allowed to skip a message.
 * @boundary Pure predicate over a pattern list and a text; no i18n load, no I/O, no model call.
 */

/**
 * A negative pattern — one whose match causes a message to be SKIPPED, dropped or not captured —
 * only counts when its match accounts for the WHOLE message.
 *
 * This repo's law is that keyword rules filter and MODELS score. A prefix or substring rule
 * standing in for a judgement about a whole sentence breaks it, and the breakage is not
 * theoretical. Measured 2026-08-19 against the 24,201 Memora user turns the corpus itself marks
 * as facts that should be remembered, prefix matching destroyed the most valuable kinds outright:
 *
 *   "Hey, I know I said Charlie Parker was my favorite artist, but I've really been enjoying
 *    Chopin's music lately. Can you update my preferred artist to Chopin?"   read as a greeting
 *   "Hey, I've got a new fitness goal! I want to walk 6,500 steps per day."  read as a greeting
 *   "Hi-Chew is the candy I always keep in the car."                         read as a greeting
 *   "Please remove 'Migrate from Redis to Memcached' from the key decisions." read as chatter
 *
 * A message that IS "hi" is noise. A message that STARTS with "Hi-Chew" is content, and no
 * amount of tightening a prefix rule can tell the two apart — the difference is meaning, and
 * meaning is the model's to read. Requiring the whole message keeps the cheap job these patterns
 * exist for, which is not spending a model call on a bare acknowledgement, and gives up the
 * expensive one they were never able to do.
 *
 * POSITIVE patterns are the opposite polarity and must NOT use this: a trigger that turns capture
 * ON, or a force-retrieve pattern, is legitimately looking for a signal anywhere in the text.
 */
export function matchesWholeMessage(pattern: RegExp, text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	pattern.lastIndex = 0;
	const match = pattern.exec(trimmed);
	pattern.lastIndex = 0;
	// `match[0]` is what the pattern actually consumed. Several of these patterns end in a
	// lookahead, so a greeting rule consumes only "Hi" out of "Hi-Chew is the candy" — which is
	// exactly the case this comparison is here to reject.
	return match !== null && match[0].trim() === trimmed;
}

/** True when any negative pattern in the list accounts for the whole message. */
export function anyMatchesWholeMessage(patterns: readonly RegExp[], text: string): boolean {
	return patterns.some((pattern) => matchesWholeMessage(pattern, text));
}
