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
	lane: "active" | "parked";
	dispositionReason: AtomicExtractionDispositionReason | null;
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
): ResolvedAtomicExtractionSourceSpan | null {
	if (!span.quote.trim()) return null;
	const turn = turns[span.turnIndex];
	if (!turn) return null;
	const startOffset = turn.content.indexOf(span.quote);
	if (startOffset !== -1) {
		return { ...span, startOffset, endOffset: startOffset + span.quote.length };
	}
	const restored = restoreAtomicSanitizedSpan(turn.content, span.quote, locale);
	return restored === null ? null : { ...span, ...restored };
}

function normalizeRelations(record: AtomicExtractionRecord): AtomicGauntletRelation[] {
	return record.relations.map((relation) => ({
		...relation,
		predicate: normalizeMemoryRelationPredicate(relation.predicate),
	}));
}

function processRecord(
	record: AtomicExtractionRecord,
	turns: readonly AtomicExtractionTurn[],
	locale: Locale,
	resplit: boolean,
	forceCompound = false,
	resplitFailure?: string,
): AtomicGauntletRecord {
	const span = resolveSpan(record.sourceSpan, turns, locale);
	const sourceRole = turns[record.sourceSpan.turnIndex]?.role;
	const subjectUnverified =
		record.kind === "standing" && (sourceRole !== "user" || span === null);
	const compound = forceCompound || isCompoundSuspect(record);
	const dispositionReason = compound
		? "compound"
		: subjectUnverified
			? "subject-unverified"
			: null;
	const unkeyed = compound || subjectUnverified || (record.kind === "occurrence" && span === null);
	return {
		...record,
		subject: unkeyed && record.subjectKind !== "named_entity" ? null : record.subject,
		attribute: unkeyed ? null : record.attribute,
		sourceSpan: span,
		...(span === null ? { unresolvedSourceSpan: record.sourceSpan } : {}),
		relations: normalizeRelations(record),
		lane: dispositionReason === null ? "active" : "parked",
		dispositionReason,
		resplit,
		...(resplitFailure === undefined ? {} : { resplitFailure }),
	};
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
		normalizeTemporal(processRecord(record, input.turns, locale, alreadyResplit)),
	);
	const keepSuspects = (failure?: string): AtomicGauntletRecord[] => [
		...output,
		...suspects.map((record) =>
			normalizeTemporal(processRecord(record, input.turns, locale, true, true, failure)),
		),
	];
	if (suspects.length === 0) return output;
	if (alreadyResplit || input.resplitTransport === undefined) {
		return keepSuspects();
	}

	let splitRecords: AtomicExtractionRecord[] | null;
	try {
		const sanitized = sanitizeAtomicPromptValue(
			{ records: suspects, turns: input.turns },
			locale,
		);
		splitRecords = await input.resplitTransport.resplit(sanitized.value);
		if (splitRecords !== null) {
			splitRecords = splitRecords.map((record) =>
				withAtomicSanitizerMatches(record, sanitized.matched),
			);
		}
	} catch (error) {
		const failure = error instanceof Error ? error.message : String(error);
		log.warn("atomic extraction re-split failed", { error, suspectCount: suspects.length }, { event_name: "memory.atomic_extraction_gauntlet.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet.ts", function: "runAtomicExtractionGauntlet", site_id: "extraction.atomic-extraction-gauntlet.runAtomicExtractionGauntlet.365701f979" });
		return keepSuspects(failure);
	}
	if (splitRecords === null) {
		return keepSuspects("resplit-unavailable");
	}
	if (splitRecords.length === 0) {
		return keepSuspects("resplit-empty");
	}
	const boundSplitRecords = splitRecords.filter((record) =>
		suspects.some(
			(suspect) =>
				record.sourceSpan.turnIndex === suspect.sourceSpan.turnIndex &&
				sanitizeAtomicPromptValue(suspect.sourceSpan.quote, locale).value.includes(
					record.sourceSpan.quote,
				),
		),
	);
	return [
		...output,
		...boundSplitRecords.map((record) =>
			normalizeTemporal(processRecord(record, input.turns, locale, true)),
		),
		...suspects.map((record) =>
			normalizeTemporal(processRecord(record, input.turns, locale, true, true)),
		),
	];
}
