/** @file retrieval-gate.ts
 * @purpose Decides whether a query needs memory retrieval at all (skip vs proceed).
 * @boundary Intent analysis, temporal classification, and retrieval configuration.
 * @see intent-analyzer.ts, memory-temporality-classifier.ts, retriever.ts.
 */

/**
 * Retrieval Gate
 * Determines whether a query needs memory retrieval at all.
 * Skips retrieval for greetings, commands, simple instructions, and system messages.
 * Saves embedding API calls and reduces noise injection.
 */

/**
 * Strip SnoStationMem metadata headers, cron wrappers, and timestamp prefixes
 * so that the raw user intent is what gets evaluated by skip/force patterns.
 */
export function normalizeQuery(raw: string): string {
	// Compute the normalized q once so later retrieval scoring checks use one value.
	let q = raw;

	// SnoStationMem metadata headers — "(Conversation info|Sender) (untrusted metadata):"
	q = q.replace(/^(Conversation info|Sender) \(untrusted metadata\):[\s\S]*?\n\s*\n/gim, "");

	// Cron wrappers — "[cron:...]"
	q = q.replace(/\[cron:[^\]]*\]\s*/gi, "");

	// Timestamp prefixes — "[Mon 2026-03-02 04:21 GMT+8]"
	q = q.replace(/\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?:\s+[\w/+-]+)?\]\s*/g, "");

	// Centralize the retrieval scoring fallback value at the boundary of this helper.
	return q.trim();
}

/**
 * The floor below which there is nothing to search FOR — not a judgement about whether a query
 * deserves a search. Mirrors the `autoRecallMinLength` default in the plugin config schema; the
 * two must not drift.
 */
const RETRIEVAL_MIN_QUERY_CHARS = 2;

/**
 * Decide whether a query is too short to search on. Length only.
 *
 * There is deliberately NO pattern list here. Until 2026-08-21 this function also read 118 skip
 * and force-retrieve regexes across nine locale bundles, and a match on a negative one meant the
 * turn was never searched at all — a keyword deciding the control flow, which is the shape this
 * repository forbids. Retrieval is a local SQLite plus local-embedding search; the cost argument
 * that justified a gate does not hold, and whether a result is relevant belongs to scoring.
 *
 * @param minLength - Override minimum length threshold (for autoRecallMinLength support).
 */
export function shouldSkipRetrieval(query: string, minLength?: number): boolean {
	const trimmed = normalizeQuery(query);
	const effectiveMinLength = minLength ?? RETRIEVAL_MIN_QUERY_CHARS;
	// Centralize the retrieval scoring fallback value at the boundary of this helper.
	return (
		trimmed.length < effectiveMinLength && !trimmed.includes("?") && !trimmed.includes("？")
	);
}
