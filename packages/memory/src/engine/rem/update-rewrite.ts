import { createHash } from "node:crypto";

import { splitExactClauses } from "./clause-splitter.js";
import {
	getRemUpdateLocaleResource,
	type RemUpdateLocale,
} from "./update-locale-resources.js";

export type RemUpdateTier = "list" | "prose";

export interface RemUpdateSpan {
	start: number;
	end: number;
}

export interface RemUpdateReferenceUnit extends RemUpdateSpan {
	id: string;
	atomId: string;
	kind: "clause" | "anchor" | "structured-member" | "structured-field";
	value: string;
	text: string;
	sourceTextSha256: string;
	startByte: number;
	endByte: number;
}

export function composeRemNegatedCurrent(input: {
	topic: string;
	priorRowId: string;
	retractionText: string;
}): {
	shape: "negated-current";
	topic: string;
	assertions: Array<{ polarity: "negative"; provenance: string }>;
	generatedRowId: string;
	consumedRowIds: string[];
} {
	const generatedRowId = `rem-negated-${createHash("sha256")
		.update(`${input.topic}\u0000${input.retractionText}`)
		.digest("hex")
		.slice(0, 24)}`;
	return {
		shape: "negated-current",
		topic: input.topic,
		assertions: [{ polarity: "negative", provenance: input.retractionText }],
		generatedRowId,
		consumedRowIds: [input.priorRowId],
	};
}

export function enumerateRemUpdateMembers(source: string): string[] {
	return extractListMemberSpans(source).map((span) => source.slice(span.start, span.end));
}

export function buildRemUpdateReferenceSet(input: {
	source: string;
	tier: RemUpdateTier;
	locale: RemUpdateLocale;
	enumeratedMembers?: readonly string[];
}): RemUpdateReferenceUnit[] {
	if (input.tier === "list") return buildMemberUnits(input.source, input.enumeratedMembers ?? []);
	const clauses = splitExactClauses(input.source).map((clause, index) =>
		toCoverageReference(input.source, `clause:${index}`, "clause", clause),
	);
	const anchors = extractAnchors(input.source, input.locale).map((anchor, index) =>
		toCoverageReference(input.source, `anchor:${index}`, "anchor", anchor),
	);
	return [...clauses, ...anchors];
}

function buildMemberUnits(source: string, members: readonly string[]): RemUpdateReferenceUnit[] {
	return members.map((value, index) => {
		const start = source.indexOf(value);
		return toCoverageReference(source, `member:${index}`, "structured-member", {
			value,
			start,
			end: start < 0 ? -1 : start + value.length,
		});
	});
}

function toCoverageReference(
	source: string,
	id: string,
	kind: RemUpdateReferenceUnit["kind"],
	span: RemUpdateSpanValue,
): RemUpdateReferenceUnit {
	const text = source.slice(span.start, span.end);
	return {
		id,
		atomId: `atom:${id}`,
		kind,
		value: span.value,
		text,
		sourceTextSha256: createHash("sha256").update(source).digest("hex"),
		start: span.start,
		end: span.end,
		startByte: Buffer.byteLength(source.slice(0, span.start)),
		endByte: Buffer.byteLength(source.slice(0, span.end)),
	};
}

function extractListMemberSpans(source: string): RemUpdateSpan[] {
	return [...source.matchAll(/^[ \t]*[-*•][ \t]+(.+)$/gmu)].flatMap((match) => {
		const member = match[1];
		if (member === undefined || match.index === undefined) return [];
		const start = match.index + match[0].indexOf(member);
		return [{ start, end: start + member.length }];
	});
}

function extractAnchors(source: string, locale: RemUpdateLocale): RemUpdateSpanValue[] {
	const anchors = [
		...matches(source, /["“‘][^"”’]+["”’]/gu),
		...matches(source, /\p{Sc}?\d[\d.,:/-]*/gu),
	];
	const resource = getRemUpdateLocaleResource(locale);
	if (resource.anchorMode === "capitalized-sequence") {
		anchors.push(...matches(source, /\b\p{Lu}[\p{L}\p{M}]*(?:\s+\p{Lu}[\p{L}\p{M}]*)+\b/gu));
	}
	return uniqueSpans(anchors);
}

interface RemUpdateSpanValue extends RemUpdateSpan {
	value: string;
}

function matches(source: string, pattern: RegExp): RemUpdateSpanValue[] {
	return [...source.matchAll(pattern)].flatMap((match) => {
		if (match.index === undefined || match[0].length === 0) return [];
		return [{ value: match[0], start: match.index, end: match.index + match[0].length }];
	});
}

function uniqueSpans(spans: readonly RemUpdateSpanValue[]): RemUpdateSpanValue[] {
	const seen = new Set<string>();
	return spans
		.filter((span) => {
			const key = `${span.start}:${span.end}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((left, right) => left.start - right.start || left.end - right.end);
}
