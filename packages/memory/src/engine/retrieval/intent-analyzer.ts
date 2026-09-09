/** @file intent-analyzer.ts
 * @purpose Renders a recalled memory as one line of text for context injection.
 * @boundary Pure formatting; no query parsing, no pattern banks, no locale rules.
 *
 * The name is historical. This file used to read the query's wording through nine locale rule
 * banks and return a category set plus a rendering depth: a match restricted which categories
 * were eligible and how much of each memory was shown, and a miss returned the shortest form.
 * All of it was deleted on 2026-08-21 — a keyword may hint at scoring, never decide the path or
 * shorten the answer. What survived is the renderer below.
 */

/**
 * Format a memory entry as one line for context injection.
 *
 * One form only: the complete text. The shorter tiers were chosen from the query's wording, so
 * a question phrased outside the pattern banks received the shortest one. Deleted 2026-08-21.
 */
export function formatAtDepth(
	entry: { text: string; category: string; projectId: string },
	score: number,
	_index: number,
	extra?: {
		bm25Hit?: boolean;
		reranked?: boolean;
		sanitize?: (text: string) => string;
		eventDate?: string;
	},
): string {
	const scoreStr = `${(score * 100).toFixed(0)}%`;
	const sourceSuffix = [extra?.bm25Hit ? "vector+BM25" : null, extra?.reranked ? "+reranked" : null]
		.filter(Boolean)
		.join("");
	const sourceTag = sourceSuffix ? `, ${sourceSuffix}` : "";

	// Apply sanitization if provided (prevents prompt injection from stored memories)
	const safe = extra?.sanitize ? extra.sanitize(entry.text) : entry.text;

	// Surface the episodic event date so the agent can reason about time-scoped
	// queries ("this week", "last month"); empty for non-episodic memories.
	const datePrefix = extra?.eventDate ? `[${extra.eventDate}] ` : "";

	return `- [${entry.category}:${entry.projectId}] ${datePrefix}${safe} (${scoreStr}${sourceTag})`;
}
