/** @file i18n-text.ts
 * @purpose Shared Unicode-aware text helpers for multilingual memory paths.
 * @boundary Pure string/RegExp helpers only; no locale detection or persistence.
 */

const REGEXP_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const CJK_CHAR_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER_OR_NUMBER = String.raw`[\p{L}\p{N}]`;
const HTML_TAG_PATTERN = /<\/?[A-Za-z][^>]*>/g;
const ROLE_LABEL_PREFIX_PATTERN =
	/(^|\n)([ \t]*)(system|assistant|user|developer|tool|function)\s*:/giu;

function withUnicodeFlag(flags: string): string {
	return flags.includes("u") ? flags : `${flags}u`;
}

function escapeRegExp(term: string): string {
	return term.replace(REGEXP_SPECIAL_CHARS, "\\$&");
}

function splitGraphemes(text: string): string[] {
	if (typeof Intl.Segmenter !== "function") return [...text];
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	return [...segmenter.segment(text)].map((segment) => segment.segment);
}

/** Builds a Unicode-aware left/right token-boundary regex around a regex body. */
export function unicodeBoundaryRegex(body: string, flags = "i"): RegExp {
	return new RegExp(
		`(?<!${LETTER_OR_NUMBER})(?:${body})(?!${LETTER_OR_NUMBER})`,
		withUnicodeFlag(flags),
	);
}

/** Matches CJK terms by substring and alphabetic terms by Unicode token boundaries. */
export function boundaryAwareRegex(term: string, flags = "i"): RegExp {
	const trimmed = term.trim();
	if (!trimmed) return /(?!)/u;
	const escaped = escapeRegExp(trimmed);
	if (CJK_CHAR_PATTERN.test(trimmed)) {
		return new RegExp(escaped, withUnicodeFlag(flags));
	}
	return unicodeBoundaryRegex(escaped, flags);
}

export function stripHtmlTags(text: string): string {
	return text.replace(HTML_TAG_PATTERN, "");
}

export function stripRoleLabelPrefix(text: string): string {
	return text.replace(ROLE_LABEL_PREFIX_PATTERN, "$1$2[$3]:");
}

export function normalizeForCompare(text: string): string {
	return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

export function truncateGraphemes(text: string, maxGraphemes: number, suffix = ""): string {
	if (maxGraphemes <= 0) return "";
	const graphemes = splitGraphemes(text);
	if (graphemes.length <= maxGraphemes) return text;
	return `${graphemes.slice(0, maxGraphemes).join("").trimEnd()}${suffix}`;
}

export function tokenizeForFts(rawQuery: string): string[] {
	const normalized = normalizeForCompare(rawQuery)
		.replace(/["']/gu, " ")
		.replace(/[^\p{L}\p{N}\s_-]/gu, " ")
		.trim();
	if (!normalized) return [];

	if (typeof Intl.Segmenter === "function") {
		const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
		const tokens = [...segmenter.segment(normalized)]
			.filter((segment) => segment.isWordLike)
			.map((segment) => segment.segment);
		if (tokens.length > 0) return tokens;
	}

	return normalized.split(/\s+/u).filter(Boolean);
}
