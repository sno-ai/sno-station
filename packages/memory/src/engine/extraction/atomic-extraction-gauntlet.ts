/** @file atomic-extraction-gauntlet.ts
 * @purpose Applies deterministic addressing, attribution, atomicity, and span checks.
 * @boundary Dark post-processing before profile keying, subject guard, suppression, and persistence.
 */

import { createLogger } from "@snoai/utils/logger";
import attributeDictionary from "../../../config/attribute-dictionary.json" with { type: "json" };
import type {
	AtomicExtractionRecord,
	AtomicExtractionSourceSpan,
	AtomicExtractionTurn,
} from "./atomic-extraction-reply";
import { normalizeAtomicTemporalRecord } from "./atomic-temporal-normalization";
import {
	restoreAtomicSanitizedSpan,
	sanitizeAtomicPromptValue,
	withAtomicSanitizerMatches,
} from "./atomic-replacement-sanitizer";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import {
	type MemoryRelationPredicate,
	normalizeMemoryRelationPredicate,
} from "../../store/store";

const log = createLogger("sno-station-mem:atomic-extraction-gauntlet");

// Spread copies preserve the link, but prompts and storage projections do not serialize it.
export const atomicCompoundSource: unique symbol = Symbol("atomicCompoundSource");

export type AtomicExtractionDispositionReason =
	| "compound"
	| "subject-unverified"
	| "subject-rejected";

export interface ResolvedAtomicExtractionSourceSpan extends AtomicExtractionSourceSpan {
	startOffset: number;
	endOffset: number;
}

export interface AtomicGauntletRelation {
	subject: string;
	predicate: MemoryRelationPredicate;
	object: string;
}

export interface AtomicGauntletRecord
	extends Omit<AtomicExtractionRecord, "subject" | "attribute" | "sourceSpan" | "relations"> {
	subject: string | null;
	attribute: string | null;
	sourceSpan: ResolvedAtomicExtractionSourceSpan | null;
	relations: AtomicGauntletRelation[];
	assertedBy?: "assistant";
	lane: "active" | "parked";
	dispositionReason: AtomicExtractionDispositionReason | null;
	[atomicCompoundSource]?: AtomicGauntletRecord;
	resplit: boolean;
	resplitFailure?: string;
	resolvedTimeInvalid?: boolean;
	/**
	 * The quote the model gave, kept ONLY when it could not be found in its turn.
	 *
	 * `sourceSpan` becomes null in that case and the quote is otherwise gone, so a parked row's
	 * replay record cannot say what failed to match — measured 2026-09-04, a dictated email
	 * produced seven well-formed records, all seven parked for an unresolved span, and every
	 * stored candidate read back as `QUOTE null`.
	 */
	unresolvedSourceSpan?: AtomicExtractionSourceSpan;
}

export interface AtomicResplitTransport {
	resplit(input: {
		records: readonly AtomicExtractionRecord[];
		turns: readonly AtomicExtractionTurn[];
	}): Promise<AtomicExtractionRecord[] | null>;
}

export interface RunAtomicExtractionGauntletInput {
	captureMode?: import("../../store/store").CaptureMode;
	records: readonly AtomicExtractionRecord[];
	turns: readonly AtomicExtractionTurn[];
	resplit?: boolean;
	resplitTransport?: AtomicResplitTransport;
	locale?: Locale;
	sessionDateTime?: string;
	sessionTimezone?: string;
}

const attributeTerms = attributeDictionary.slugs.map((entry) => ({
	slug: entry.slug,
	terms: [entry.slug, ...Object.values(entry.synonyms).flat()]
		.map((term) => term.normalize("NFKC").toLowerCase().trim())
		.filter((term) => term.length > 0),
}));

function containsTerm(content: string, term: string): boolean {
	if (![...term].every((character) => (character.codePointAt(0) ?? 128) <= 127)) {
		return content.includes(term);
	}
	let start = content.indexOf(term);
	while (start !== -1) {
		const before = start === 0 ? "" : content[start - 1] ?? "";
		const after = content[start + term.length] ?? "";
		if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
		start = content.indexOf(term, start + 1);
	}
	return false;
}

export function resolveAttributeKeysInContent(content: string): string[] {
	const normalized = content.normalize("NFKC").toLowerCase();
	return attributeTerms
		.filter(({ terms }) => terms.some((term) => containsTerm(normalized, term)))
		.map(({ slug }) => slug);
}

function isCompoundSuspect(record: AtomicExtractionRecord): boolean {
	return !record.singleClaim;
}

function resolveSpan(
	span: AtomicExtractionSourceSpan,
	turns: readonly AtomicExtractionTurn[],
	locale: Locale,
	work: boolean,
): ResolvedAtomicExtractionSourceSpan | null {
	if (!span.quote.trim()) return null;
	const turn = turns[span.turnIndex];
	if (!turn) return null;
	const startOffset = turn.content.indexOf(span.quote);
	if (startOffset !== -1) {
		return { ...span, startOffset, endOffset: startOffset + span.quote.length };
	}
	const restored = restoreAtomicSanitizedSpan(turn.content, span.quote, locale);
	if (restored !== null) return { ...span, ...restored };
	if (!work) return null;
	const quote = span.quote.replace(/`|\*\*|__/g, "");
	if (!quote.trim()) return null;
	const offsets: number[] = [];
	// Keep UTF-16 offsets, as used by indexOf and slice, while omitting only Markdown marks.
	const plain = turn.content.replace(/(`|\*\*|__)|[\s\S]/g,
		(character: string, mark: string | undefined, offset: number) => {
			if (mark !== undefined) return "";
			offsets.push(offset);
			return character;
		});
	const match = plain.indexOf(quote);
	if (match === -1) return null;
	const originalStart = offsets[match];
	const originalEnd = offsets[match + quote.length - 1];
	if (originalStart === undefined || originalEnd === undefined) return null;
	return { ...span, quote: turn.content.slice(originalStart, originalEnd + 1),
		startOffset: originalStart, endOffset: originalEnd + 1 };
}

function normalizeRelations(record: AtomicExtractionRecord): AtomicGauntletRelation[] {
	return record.relations.map((relation) => ({
		...relation,
		predicate: normalizeMemoryRelationPredicate(relation.predicate),
	}));
}

function parkCompound(record: AtomicGauntletRecord): AtomicGauntletRecord {
	return {
		...record,
		subject: record.subjectKind === "named_entity" ? record.subject : null,
		attribute: null,
		lane: "parked",
		dispositionReason: "compound",
	};
}

function processRecord(
	record: AtomicExtractionRecord,
	turns: readonly AtomicExtractionTurn[],
	locale: Locale,
	resplit: boolean,
	captureMode: import("../../store/store").CaptureMode = "chat",
	parkWhole = isCompoundSuspect(record),
	resplitFailure?: string,
): AtomicGauntletRecord {
	const span = resolveSpan(record.sourceSpan, turns, locale, captureMode === "work");
	const sourceRole = turns[record.sourceSpan.turnIndex]?.role;
	const assistantFact = captureMode === "work" && sourceRole !== "user"
		&& record.subjectKind !== "user";
	const subjectUnverified =
		record.kind === "standing" && ((!assistantFact && sourceRole !== "user") || span === null);
	const unkeyed = subjectUnverified || (record.kind === "occurrence" && span === null);
	const processed: AtomicGauntletRecord = {
		...record,
		...(assistantFact && record.kind === "standing" ? { assertedBy: "assistant" as const } : {}),
		subject: unkeyed && record.subjectKind !== "named_entity" ? null : record.subject,
		attribute: unkeyed || isCompoundSuspect(record) ? null : record.attribute,
		sourceSpan: span,
		...(span === null ? { unresolvedSourceSpan: record.sourceSpan } : {}),
		relations: normalizeRelations(record),
		lane: subjectUnverified ? "parked" : "active",
		dispositionReason: subjectUnverified ? "subject-unverified" : null,
		resplit,
		...(resplitFailure === undefined ? {} : { resplitFailure }),
	};
	return parkWhole ? parkCompound(processed) : processed;
}

export async function runAtomicExtractionGauntlet(
	input: RunAtomicExtractionGauntletInput,
): Promise<AtomicGauntletRecord[]> {
	const normalizeTemporal = (record: AtomicGauntletRecord): AtomicGauntletRecord =>
		normalizeAtomicTemporalRecord({
			record,
			...(input.locale ? { locale: input.locale } : {}),
			...(input.sessionDateTime ? { sessionDateTime: input.sessionDateTime } : {}),
			...(input.sessionTimezone ? { sessionTimezone: input.sessionTimezone } : {}),
		});
	const locale = input.locale ?? DEFAULT_LOCALE;
	const alreadyResplit = input.resplit === true;
	const ordinary: AtomicExtractionRecord[] = [];
	const suspects: AtomicExtractionRecord[] = [];
	for (const record of input.records) {
		if (isCompoundSuspect(record)) suspects.push(record);
		else ordinary.push(record);
	}
	const output = ordinary.map((record) =>
		normalizeTemporal(processRecord(record, input.turns, locale, alreadyResplit, input.captureMode)),
	);
	if (suspects.length === 0) return output;
	if (alreadyResplit || input.resplitTransport === undefined) {
		return [
			...output,
			...suspects.map((record) =>
				normalizeTemporal(processRecord(record, input.turns, locale, true, input.captureMode)),
			),
		];
	}

	let splitRecords: AtomicExtractionRecord[] | null = null;
	let resplitFailure: string | undefined;
	try {
		const sanitized = sanitizeAtomicPromptValue(
			{ records: suspects, turns: input.turns },
			locale,
		);
		const records = await input.resplitTransport.resplit(sanitized.value);
		splitRecords = records?.map((record) => withAtomicSanitizerMatches(record, sanitized.matched)) ?? null;
	} catch (error) {
		resplitFailure = error instanceof Error ? error.message : String(error);
		log.warn("atomic extraction re-split failed", { error, suspectCount: suspects.length }, { event_name: "memory.atomic_extraction_gauntlet.diagnostic", file: "packages/memory/src/engine/extraction/atomic-extraction-gauntlet.ts", function: "runAtomicExtractionGauntlet", site_id: "extraction.atomic-extraction-gauntlet.runAtomicExtractionGauntlet.365701f979" });
	}
	if (splitRecords === null) {
		resplitFailure ??= "resplit-unavailable";
	} else if (splitRecords.length === 0) {
		resplitFailure = "resplit-empty";
	}
	const wholeRecords = suspects.map((record) => ({
		sourceSpan: record.sourceSpan,
		whole: normalizeTemporal(
			processRecord(record, input.turns, locale, true, input.captureMode, false, resplitFailure),
		),
	}));
	const wholesWithActiveSplit = new Set<AtomicGauntletRecord>();
	const processedSplitRecords = (splitRecords ?? []).flatMap((record) => {
		const [match, ambiguous] = wholeRecords.filter(
			({ sourceSpan }) =>
				record.sourceSpan.turnIndex === sourceSpan.turnIndex &&
				sanitizeAtomicPromptValue(sourceSpan.quote, locale).value.includes(record.sourceSpan.quote),
		);
		if (match === undefined) return [];
		const { whole } = match;
		const splitRecord = {
			...record,
			...(whole.precisionKind === undefined ? {} : { precisionKind: whole.precisionKind }),
		};
		const processed = normalizeTemporal(
			processRecord(splitRecord, input.turns, locale, true, input.captureMode),
		);
		if (ambiguous !== undefined || processed.lane !== "active") return [processed];
		wholesWithActiveSplit.add(whole);
		return [{ ...processed, [atomicCompoundSource]: whole }];
	});
	return [
		...output,
		...processedSplitRecords,
		...wholeRecords.map(({ whole }) =>
			wholesWithActiveSplit.has(whole)
				? { ...parkCompound(whole), [atomicCompoundSource]: whole }
				: whole,
		),
	];
}
