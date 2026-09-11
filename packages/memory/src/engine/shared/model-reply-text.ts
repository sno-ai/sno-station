/** @file model-reply-text.ts
 * @purpose Turns one raw model reply into the ordered JSON payload candidates a caller may accept.
 * @boundary Response-text normalization only; the caller owns every schema decision.
 */

import { repairCommonJson } from "../../model/llm-json-utils";

interface BalancedSpan {
	start: number;
	end: number;
}

/**
 * Balanced container starting at `start`, or undefined when it never closes.
 *
 * String state is tracked so a brace inside a string value does not close the container.
 */
function balancedEnd(text: string, start: number): number | undefined {
	let inString = false;
	let escaped = false;
	const stack: string[] = [];
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") stack.push(char);
		else if (char === "}" || char === "]") {
			const opening = stack.at(-1);
			if ((opening === "{" && char !== "}") || (opening === "[" && char !== "]")) return undefined;
			stack.pop();
			if (stack.length === 0) return index + 1;
		}
	}
	return undefined;
}

/**
 * Every top-level balanced container, NON-OVERLAPPING.
 *
 * Resuming after each container instead of scanning from every index is what keeps the scan out of
 * string values. Measured 2026-09-04 on a live reply that echoed the transcript back —
 * `[{"role":"assistant","content":"{\"records\":[]}"}]` — the per-index scan offered the escaped
 * inner `{"records":[]}` as a candidate and it passed the caller's schema, so an echoed turn was
 * about to be recorded as "nothing to record" and its real content lost.
 */
function balancedSpans(text: string): BalancedSpan[] {
	const spans: BalancedSpan[] = [];
	let start = 0;
	while (start < text.length) {
		const char = text[start];
		if (char !== "{" && char !== "[") {
			start += 1;
			continue;
		}
		const end = balancedEnd(text, start);
		if (end === undefined) {
			start += 1;
			continue;
		}
		spans.push({ start, end });
		start = end;
	}
	return spans;
}

/**
 * Spans of every JSON string literal in `text`, so a tag the user typed can be told apart from a
 * tag the model wrote. Unterminated strings are ignored: only closed literals are protected.
 */
function stringSpans(text: string): BalancedSpan[] {
	const spans: BalancedSpan[] = [];
	let start = -1;
	let escaped = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (start === -1) {
			if (char === '"') start = index;
			continue;
		}
		if (escaped) escaped = false;
		else if (char === "\\") escaped = true;
		else if (char === '"') {
			spans.push({ start, end: index + 1 });
			start = -1;
		}
	}
	return spans;
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>|<think>[\s\S]*$/giu;

/**
 * Removes think blocks unless they start inside a JSON string literal.
 *
 * The rule is "is this tag part of someone's data", not "does this block contain JSON". Keying on
 * whether the block overlapped a balanced container kept exactly the dangerous case: a model that
 * drafts a wrong payload inside `<think>` and writes the right one after it — measured, the draft
 * was returned as candidate 0 and won. A `<think>` inside a string value is user content and is
 * left byte-identical.
 */
function stripThinkOutsideCandidates(raw: string): string {
	const protectedSpans = stringSpans(raw);
	const inString = (index: number): boolean =>
		protectedSpans.some((span) => index >= span.start && index < span.end);
	let out = "";
	let cursor = 0;
	THINK_BLOCK.lastIndex = 0;
	for (const match = { value: THINK_BLOCK.exec(raw) }; match.value !== null; match.value = THINK_BLOCK.exec(raw)) {
		const at = match.value.index;
		if (inString(at)) continue;
		out += raw.slice(cursor, at);
		cursor = at + match.value[0].length;
	}
	return out + raw.slice(cursor);
}

function fencedBlocks(text: string): string[] {
	return [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gu)]
		.map((match) => (match[1] ?? "").trim())
		.filter((body) => body.length > 0);
}

/**
 * The JSON payload candidates in one reply, in the order a caller should try them.
 *
 * Fenced blocks first: a model that fences its answer fences the answer, not its commentary.
 * Then the non-overlapping balanced containers. Each candidate appears as written and, when it
 * does not parse, once more repaired.
 */
export function modelReplyJsonCandidates(raw: string): string[] {
	const text = stripThinkOutsideCandidates(raw).trim();
	const ordered = [
		...fencedBlocks(text),
		...balancedSpans(text).map((span) => text.slice(span.start, span.end)),
	];
	const candidates: string[] = [];
	for (const candidate of ordered) {
		if (!candidates.includes(candidate)) candidates.push(candidate);
		const repaired = repairCommonJson(candidate);
		if (repaired !== candidate && !candidates.includes(repaired)) candidates.push(repaired);
	}
	return candidates;
}

/**
 * The first candidate `accept` admits, or undefined when none does.
 *
 * The caller decides what a payload is. Handing back a single "best" candidate instead let a
 * syntactically valid but wrong-shaped example consume the caller's only chance while the real
 * payload sat behind it.
 */
export function readModelReplyJson<T>(
	raw: string,
	accept: (value: unknown) => T | undefined,
): T | undefined {
	for (const candidate of modelReplyJsonCandidates(raw)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		const admitted = accept(parsed);
		if (admitted !== undefined) return admitted;
	}
	return undefined;
}
