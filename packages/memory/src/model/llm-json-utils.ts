/** @file llm-json-utils.ts
 * @purpose Extracts and repairs JSON returned by LLM providers.
 * @boundary Response-text normalization only; schema validation remains with callers.
 */

/**
 * Extract JSON from an LLM response that may be wrapped in markdown fences
 * or contain surrounding text.
 */
export function extractJsonFromResponse(text: string): string | null {
	// Try every fenced block in order, and only accept valid or repairable JSON. Taking the FIRST
	// fence unchecked let an explanatory block win over the real payload behind it — the same
	// mistake as stopping at the first bracket below, and the half that a container-scan fix
	// alone leaves unrepaired.
	for (const fence of text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)) {
		const body = (fence[1] ?? "").trim();
		if (isRecoverableJson(body)) return body;
	}

	// Balance from whichever container opens first, object OR array, and keep looking when the
	// first balanced slice is neither valid nor repairable JSON. Scanning only for "{" silently rewrote a
	// top-level array into its own first element (measured 2026-08-17: 43 of 47 rejected gate
	// replies were a complete array read as one malformed object). Accepting the first slice
	// unchecked has the mirror failure: `Here is [JSON]: {"verdicts":[...]}` returns the literal
	// `[JSON]` and the real payload behind it is never read. Both are the same mistake — deciding
	// on the wrapper instead of the value.
	let searchFrom = 0;
	while (searchFrom < text.length) {
		const slice = balancedSliceFrom(text, searchFrom);
		if (slice === null || slice.text === null) return null;
		if (isRecoverableJson(slice.text)) return slice.text;
		searchFrom = slice.start + 1;
	}
	return null;
}

/** True when the slice is JSON or the existing repair pass can make it JSON. */
function isRecoverableJson(candidate: string): boolean {
	try {
		JSON.parse(candidate);
		return true;
	} catch {
		const repaired = repairCommonJson(candidate);
		if (repaired === candidate) return false;
		try {
			JSON.parse(repaired);
			return true;
		} catch {
			return false;
		}
	}
}

/** The first balanced `{...}` or `[...]` at or after `from`, with the index it started at. */
function balancedSliceFrom(
	text: string,
	from: number,
): { text: string | null; start: number } | null {
	const start = firstContainerIndex(text, from);
	if (start === -1) return null;
	const opener = text[start];
	const closer = opener === "[" ? "]" : "}";

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === undefined) continue;

		if (escaped) {
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			escaped = inString;
			continue;
		}

		if (ch === '"') {
			inString = !inString;
			continue;
		}

		if (inString) continue;
		if (ch === opener) depth++;
		else if (ch === closer) {
			depth--;
			if (depth === 0) return { text: text.substring(start, i + 1), start };
		}
	}
	return { text: null, start };
}

/** First `{` or `[` that is not inside a string, or -1. */
function firstContainerIndex(text: string, from = 0): number {
	let inString = false;
	let escaped = false;
	for (let i = from; i < text.length; i++) {
		const ch = text[i];
		if (ch === undefined) continue;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = inString;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{" || ch === "[") return i;
	}
	return -1;
}

/** Implements preview text as the local LLM transport operation. */
export function previewText(value: string, maxLen = 200): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLen) return normalized;
	return `${normalized.slice(0, maxLen - 3)}...`;
}

/** Implements next non whitespace char as the local LLM transport operation. */
function nextNonWhitespaceChar(text: string, start: number): string | undefined {
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch !== undefined && !/\s/.test(ch)) return ch;
	}
	return undefined;
}

/**
 * Best-effort repair for common LLM JSON issues:
 * - unescaped quotes inside string values
 * - raw newlines / tabs inside strings
 * - trailing commas before } or ]
 */
export function repairCommonJson(text: string): string {
	let result = "";
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === undefined) continue;

		if (escaped) {
			result += ch;
			escaped = false;
			continue;
		}

		if (inString) {
			if (ch === "\\") {
				result += ch;
				escaped = true;
				continue;
			}

			if (ch === '"') {
				const nextCh = nextNonWhitespaceChar(text, i + 1);
				if (
					nextCh === undefined ||
					nextCh === "," ||
					nextCh === "}" ||
					nextCh === "]" ||
					nextCh === ":"
				) {
					result += ch;
					inString = false;
				} else {
					result += '\\"';
				}
				continue;
			}

			if (ch === "\n") {
				result += "\\n";
				continue;
			}
			if (ch === "\r") {
				result += "\\r";
				continue;
			}
			if (ch === "\t") {
				result += "\\t";
				continue;
			}

			result += ch;
			continue;
		}

		if (ch === '"') {
			result += ch;
			inString = true;
			continue;
		}

		if (ch === ",") {
			const nextCh = nextNonWhitespaceChar(text, i + 1);
			if (nextCh === "}" || nextCh === "]") {
				continue;
			}
		}

		result += ch;
	}

	return result;
}
