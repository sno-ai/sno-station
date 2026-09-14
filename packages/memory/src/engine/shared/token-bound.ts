/** @file token-bound.ts
 * @purpose Cuts text to a token budget under any monotonic token counter.
 * @boundary Pure text function; the caller supplies the counter.
 */

/**
 * Longest prefix of `text` costing at most `maxTokens` under `countTokens`. Bounding by
 * token cost rather than character count keeps the budget honest across scripts: a
 * character bound buys several times more prompt for Latin text than for CJK.
 *
 * Binary search is safe because every counter used here never decreases as the
 * substring is extended, and searching over code points rather than UTF-16 units means
 * a cut can never split a surrogate pair. The result is right-trimmed, which can only
 * lower the token count, so the budget still holds.
 */
export function truncateToTokens(
	text: string,
	maxTokens: number,
	countTokens: (text: string) => number,
): string {
	if (countTokens(text) <= maxTokens) return text;
	const codePoints = Array.from(text);
	let low = 0;
	let high = codePoints.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (countTokens(codePoints.slice(0, mid).join("")) <= maxTokens) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return codePoints.slice(0, low).join("").trimEnd();
}
