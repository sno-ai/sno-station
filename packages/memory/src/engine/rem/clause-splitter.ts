export interface RemExactClause {
	value: string;
	start: number;
	end: number;
	separatorAfter: string;
}

/**
 * Produces the fixed, lossless clause list used by REM judgments. The text itself
 * remains the authority: clause values are exact source slices and separators are retained.
 */
export function splitExactClauses(text: string): RemExactClause[] {
	if (text.trim().length === 0) {
		throw new Error("REM clause splitter requires non-empty text");
	}

	const clauses: RemExactClause[] = [];
	let cursor = 0;
	for (const boundary of text.matchAll(/\n+|(?<=[.!?;])\s+|(?<=,)\s+(?=\p{Ll})/gu)) {
		const end = boundary.index;
		clauses.push({
			value: text.slice(cursor, end),
			start: cursor,
			end,
			separatorAfter: boundary[0],
		});
		cursor = end + boundary[0].length;
	}
	clauses.push({ value: text.slice(cursor), start: cursor, end: text.length, separatorAfter: "" });

	if (clauses.some((clause) => clause.value.trim().length === 0)) {
		throw new Error("REM clause splitter cannot delimit an empty clause");
	}
	if (clauses.map((clause) => `${clause.value}${clause.separatorAfter}`).join("") !== text) {
		throw new Error("REM clause splitter must preserve source bytes");
	}
	return clauses;
}
