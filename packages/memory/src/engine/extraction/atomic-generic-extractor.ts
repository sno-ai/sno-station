import { dirname } from "node:path";
import { appendAuditEntry } from "../operations/runtime-audit-log";
import { redactSecrets } from "../security/redact";
import extractionSchema from "../../../config/atomic-extraction-response.schema.json" with { type: "json" };
import { ATOMIC_ENRICHMENT_OUTPUT_TOKEN_BUDGET } from "../../../config/index";
import { FIXED_MEMORY_SNO_EXTRACT_CHAT } from "../../model/signed-registry-constants";
/** @file atomic-generic-extractor.ts
 * @purpose Runs the dark generic atomic extraction pass over complete transcript windows.
 * @boundary Capture and serial enrichment batches with retries; no writes or gauntlet stages.
 */

import { createLogger } from "@snoai/utils/logger";
import attributeDictionary from "../../../config/attribute-dictionary.json" with { type: "json" };
import relationDictionary from "../../../config/relation-dictionary.json" with { type: "json" };
import stateVocabulary from "../../../config/state-vocabulary.json" with { type: "json" };
import {
	ATOMIC_EXTRACTION_SKILL,
	ATOMIC_EXTRACTION_SKILL_HASH,
	atomicExtractionSkillReference,
} from "./atomic-extraction-skill";
import {
	type AtomicExtractionRecord,
	type AtomicExtractionTurn,
	type AtomicCapturedFact,
	ATOMIC_CAPTURE_RESPONSE_JSON_SCHEMA,
	ATOMIC_ENRICHMENT_RESPONSE_JSON_SCHEMA,
	fallbackAtomicCapturedFact,
	parseAtomicCaptureReply,
	parseAtomicEnrichmentReply,
	parseAtomicExtractionReply,
} from "./atomic-extraction-reply";
import {
	numberAtomicTurns,
	renderAtomicPromptData,
	restoreAtomicSanitizedSpan,
	sanitizeAtomicPromptValue,
	withAtomicSanitizerMatches,
} from "./atomic-replacement-sanitizer";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import type { LlmClient, LlmClientConfig } from "../../model/llm-client";
import { createLlmClient } from "../../model/llm-client";
import type {
	AtomicExtractionLedgerKey,
	AtomicExtractionReprocessReason,
	AtomicExtractionRunParameters,
	BeginAtomicExtractionChunkResult,
	MemoryStore,
} from "../../store/store";

const log = createLogger("sno-station-mem:atomic-extraction");
const ATOMIC_REPROCESS_ATTEMPT_CAP = 1;
const GENERIC_RESPONSE_SCHEMA = {
	...extractionSchema,
	required: [...extractionSchema.required, "decisions"],
	properties: {
		...extractionSchema.properties,
		decisions: {
			type: "array",
			items: {
				type: "object", required: ["turn_index", "progress_only"], additionalProperties: false,
				properties: { turn_index: { type: "integer", minimum: 0 }, progress_only: { type: "boolean" } },
			},
		},
	},
};

export interface AtomicGenericExtractionRequest {
	prompt: string;
	maxTokens: number;
	requestId?: string;
}

export interface AtomicGenericExtractionCompletion {
	text: string;
	truncated: boolean;
	outputTokens?: number;
}

export interface AtomicGenericExtractionTransport {
	complete(request: AtomicGenericExtractionRequest): Promise<AtomicGenericExtractionCompletion | null>;
}

export interface AtomicGenericExtractionInput {
	diagnostics?: { proposed: number; parseRejected: number };
	store: MemoryStore;
	ledgerKey: AtomicExtractionLedgerKey;
	turns: readonly AtomicExtractionTurn[];
	contextTurns?: readonly AtomicExtractionTurn[];
	followingTurns?: readonly AtomicExtractionTurn[];
	rawChunk: string;
	routingSnapshotId: string;
	runParameters: AtomicExtractionRunParameters;
	sessionDateTime?: string;
	estimatedInputTokens: number;
	nowMs: () => number;
	transport: AtomicGenericExtractionTransport;
	requestId?: string;
	locale?: Locale;
}

export type AtomicGenericExtractionResult =
	| { status: "complete"; records: AtomicExtractionRecord[]; progressTurns: ReadonlySet<number> }
	| { status: "pending"; reason: AtomicExtractionReprocessReason }
	| { status: "skip"; entry: BeginAtomicExtractionChunkResult["entry"] }
	| { status: "off" };

export function buildAtomicExtractionWindows(
	turns: readonly AtomicExtractionTurn[],
	maxTurns?: number,
): AtomicExtractionTurn[][] {
	if (maxTurns !== undefined) {
		if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error("maxTurns must be a positive integer");
		const windows: AtomicExtractionTurn[][] = [];
		for (let start = 0; start < turns.length; start += maxTurns) {
			windows.push(turns.slice(start, start + maxTurns));
		}
		return windows;
	}
	if (turns.length === 0) return [];
	const userIndexes = turns.flatMap((turn, index) => (turn.role === "user" ? [index] : []));
	if (userIndexes.length <= 2) return [[...turns]];
	const windows: AtomicExtractionTurn[][] = [];
	for (let first = 0; first + 2 <= userIndexes.length; first += 1) {
		const start = first === 0 ? 0 : (userIndexes[first] ?? 0);
		const end = userIndexes[first + 2] ?? turns.length;
		windows.push(turns.slice(start, end));
	}
	return windows;
}

export function buildAtomicGenericExtractionPrompt(
	turns: readonly AtomicExtractionTurn[],
	sessionDateTime?: string,
	locale: Locale = DEFAULT_LOCALE,
	turnIndexesToAccountFor: readonly number[] = [],
	contextTurns: readonly AtomicExtractionTurn[] = [],
	followingTurns: readonly AtomicExtractionTurn[] = [],
): string {
	const transcript = renderAtomicPromptData(numberAtomicTurns(turns), locale);
	return [
		ATOMIC_EXTRACTION_SKILL,
		atomicExtractionSkillReference("progress-classification"),
		`session_date_time: ${sessionDateTime ?? "unknown"}`,
		`person_attribute_slugs: ${JSON.stringify(attributeDictionary.slugs.map(({ slug }) => slug))}`,
		`thing_attribute_slugs: ${JSON.stringify(stateVocabulary.slugs.map(({ slug }) => slug))}`,
		`relation_dictionary: ${JSON.stringify(relationDictionary.relations)}`,
		`response_schema: ${JSON.stringify(GENERIC_RESPONSE_SCHEMA)}`,
		...(contextTurns.length === 0 && followingTurns.length === 0 ? [] : [
			atomicExtractionSkillReference("surrounding-context"),
			`preceding_context: ${renderAtomicPromptData(contextTurns, locale).value}`,
			`following_context: ${renderAtomicPromptData(followingTurns, locale).value}`,
		]),
		...(turnIndexesToAccountFor.length === 0
			? []
			: [
					atomicExtractionSkillReference("account-for-turns"),
					`turn_indexes_to_account_for: ${JSON.stringify([...turnIndexesToAccountFor])}`,
				]),
		`transcript:\n${transcript.value}`,
	].join("\n\n");
}

function renderAtomicLaneContext(input: AtomicGenericExtractionInput): string {
	const locale = input.locale ?? DEFAULT_LOCALE;
	return [
		`session_date_time: ${input.sessionDateTime ?? "unknown"}`,
		atomicExtractionSkillReference("surrounding-context"),
		`preceding_context: ${renderAtomicPromptData(input.contextTurns ?? [], locale).value}`,
		`following_context: ${renderAtomicPromptData(input.followingTurns ?? [], locale).value}`,
		`transcript:\n${renderAtomicPromptData(numberAtomicTurns(input.turns), locale).value}`,
	].join("\n\n");
}

export function buildAtomicCapturePrompt(input: AtomicGenericExtractionInput): string {
	return [
		atomicExtractionSkillReference("capture"),
		`response_schema: ${JSON.stringify(ATOMIC_CAPTURE_RESPONSE_JSON_SCHEMA)}`,
		renderAtomicLaneContext(input),
	].join("\n\n");
}

export function buildAtomicEnrichmentPrompt(
	input: AtomicGenericExtractionInput,
	facts: readonly AtomicCapturedFact[],
): string {
	return [
		atomicExtractionSkillReference("calendar-meaning"),
		atomicExtractionSkillReference("enrichment"),
		`person_attribute_slugs: ${JSON.stringify(attributeDictionary.slugs.map(({ slug }) => slug))}`,
		`thing_attribute_slugs: ${JSON.stringify(stateVocabulary.slugs.map(({ slug }) => slug))}`,
		`relation_dictionary: ${JSON.stringify(relationDictionary.relations)}`,
		`response_schema: ${JSON.stringify(ATOMIC_ENRICHMENT_RESPONSE_JSON_SCHEMA)}`,
		renderAtomicLaneContext(input),
		`facts:\n${renderAtomicPromptData(facts, input.locale ?? DEFAULT_LOCALE).value}`,
	].join("\n\n");
}

function estimatedEnrichmentTokens(fact: AtomicCapturedFact): number {
	return 78 + Math.ceil((fact.fact.length / 4) * 0.3);
}

export function chunkAtomicCapturedFacts(
	facts: readonly AtomicCapturedFact[],
): AtomicCapturedFact[][] {
	const batches: AtomicCapturedFact[][] = [];
	let batch: AtomicCapturedFact[] = [];
	let tokens = 0;
	for (const fact of facts) {
		const estimate = estimatedEnrichmentTokens(fact);
		if (batch.length > 0 && tokens + estimate > ATOMIC_ENRICHMENT_OUTPUT_TOKEN_BUDGET) {
			batches.push(batch);
			batch = [];
			tokens = 0;
		}
		batch.push(fact);
		tokens += estimate;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

async function enrichAtomicBatch(
	input: AtomicGenericExtractionInput,
	facts: readonly AtomicCapturedFact[],
	outputTokenBudget: number,
): Promise<AtomicExtractionRecord[]> {
	const prompt = buildAtomicEnrichmentPrompt(input, facts);
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		const completion = await input.transport.complete({
			prompt, maxTokens: outputTokenBudget,
			...(input.requestId ? { requestId: input.requestId } : {}),
		});
		if (completion !== null) input.store.recordAtomicExtractionCalls(input.ledgerKey, input.nowMs());
		const records = completion === null || completion.truncated ? undefined
			: parseAtomicEnrichmentReply(completion.text, facts, input.sessionDateTime);
		log.info("atomic_enrichment_batch", {
			attempt, factIds: facts.map((fact) => fact.id),
			predictedOutputTokens: facts.reduce((sum, fact) => sum + estimatedEnrichmentTokens(fact), 0),
			actualOutputTokens: completion?.outputTokens ?? null,
			truncated: completion?.truncated ?? false, accepted: records !== undefined,
		}, { event_name: "memory.atomic_generic_extractor.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor.ts", function: "enrichAtomicBatch", site_id: "extraction.atomic-generic-extractor.enrichAtomicBatch" });
		if (records !== undefined) return records;
		if (input.diagnostics) input.diagnostics.parseRejected += 1;
	}
	if (facts.length <= 1) return facts.map(fallbackAtomicCapturedFact);
	const middle = Math.ceil(facts.length / 2);
	return [
		...await enrichAtomicBatch(input, facts.slice(0, middle), outputTokenBudget),
		...await enrichAtomicBatch(input, facts.slice(middle), outputTokenBudget),
	];
}

export function excludeContextOnlyRecords<T extends {
	sourceSpan: { quote: string } | null;
	unresolvedSourceSpan?: { quote: string };
}>(
	records: readonly T[],
	turns: readonly AtomicExtractionTurn[],
	contextTurns: readonly AtomicExtractionTurn[],
	locale: Locale = DEFAULT_LOCALE,
): T[] {
	return records.filter((record) => {
		const quote = (record.sourceSpan ?? record.unresolvedSourceSpan)?.quote;
		if (!quote?.trim()) return true;
		const matches = (turn: AtomicExtractionTurn): boolean =>
			turn.content.includes(quote) || restoreAtomicSanitizedSpan(turn.content, quote, locale) !== null;
		return turns.some(matches) || !contextTurns.some(matches);
	});
}

/**
 * Turns whose own text carries a figure: any currency symbol or any digit at all. Deliberately
 * crude — it decides only WHICH turns are worth asking about a second time, never what the fact
 * is, and a turn it flags by accident costs one model call that returns no record.
 *
 * Any digit, not three: "I bought 12 coffees" and "I ran 5 km" are facts a total depends on just
 * as much as a four-digit step count. Measured over the three scored personas, widening this from
 * three digits to one moves the share of user turns it flags from 3.6% to 4.5% of 3,500 — so the
 * narrower rule bought almost nothing and silently dropped every small number.
 */
const NUMERIC_CLAIM_PATTERN = /(?:\p{Sc}\s*)?\d+(?:[,.]\d+)*|\p{Sc}/u;

function numericTokens(text: string): string[] {
	return [...text.matchAll(new RegExp(NUMERIC_CLAIM_PATTERN, "gu"))].map(([token]) =>
		token.replace(/[\p{Sc},\s]/gu, ""),
	);
}

function numericTokenCounts(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of numericTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

/**
 * How many times a turn's figures are actually stated by its records — counted, not set-tested.
 *
 * Three things a set got wrong, each of which loses a whole fact and none of which is visible
 * downstream. "I spent $5 on coffee and $5 on parking" states the figure twice; a set holds one
 * `5`, so a first pass that captured only the coffee looked complete and the parking fact was
 * never asked about again. `sourceSpan.quote` is the evidence the model READ, so pooling it made
 * "the number was in front of the model" count as "the model extracted it" — a record about
 * something else whose quote spans the whole turn covered every figure in it. And a record is one
 * atomic claim, so it may account for a figure ONCE however many of its own words repeat it:
 * counting "Coffee cost $5, a $5 expense" as two covered fives hides the parking fact just as
 * completely.
 */
function recordsCaptureEveryNumericToken(
	records: readonly AtomicExtractionRecord[],
	turnIndex: number,
	turnContent: string,
): boolean {
	const captured = new Map<string, number>();
	for (const record of records) {
		if (record.sourceSpan.turnIndex !== turnIndex) continue;
		const stated = new Set([...numericTokens(record.claimText), ...numericTokens(record.value)]);
		for (const token of stated) captured.set(token, (captured.get(token) ?? 0) + 1);
	}
	for (const [token, count] of numericTokenCounts(turnContent)) {
		if ((captured.get(token) ?? 0) < count) return false;
	}
	return true;
}

function normalizedAtomicText(text: string): string {
	return text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function quotesOverlap(left: string, right: string): boolean {
	return left.includes(right) || right.includes(left);
}

/**
 * Where in the turn each figure inside a record's quote sits, or null when the quote cannot be
 * placed in the turn at all (a sanitizer replacement, or a quote the model did not copy verbatim).
 */
function figureOffsetsInTurn(turnContent: string, quote: string): number[] | null {
	const start = turnContent.indexOf(quote);
	if (start === -1) return null;
	const offsets: number[] = [];
	for (const match of quote.matchAll(new RegExp(NUMERIC_CLAIM_PATTERN, "gu"))) {
		if (match.index !== undefined) offsets.push(start + match.index);
	}
	return offsets;
}

/**
 * Whether a sweep record restates a fact the first pass already made — judged on which figure in
 * the turn each record points at, not on wording and not on one quote containing the other.
 *
 * The sweep is asked about the whole turn, so it restates what the first pass already got. Its
 * wording is regenerated, so matching on `claim_text` catches nothing the moment the model
 * rephrases; matching on the figure alone would throw away "$5 on parking" as a repeat of "$5 on
 * coffee". Quote containment fails in both directions at once: a first-pass quote spanning the
 * whole sentence contains the parking quote and would swallow a genuinely new fact, while two
 * quotes of the SAME fact that merely overlap ("spent $5 on coffee" and "$5 on coffee at work")
 * contain neither and would be written twice.
 *
 * The figure's POSITION in the turn settles both: two records of one fact point at the same
 * occurrence, and a wide quote covering two fives is not the record that states either one of
 * them. Containment stays as the fallback for records carrying no figure and for a quote that
 * cannot be placed in the turn.
 *
 * Deliberately blind to `attribute`: the sweep may key the same fact differently, and that is
 * still the same fact.
 */
function restatesSameFact(
	base: AtomicExtractionRecord,
	sweep: AtomicExtractionRecord,
	turnContent: string,
): boolean {
	if (base.sourceSpan.turnIndex !== sweep.sourceSpan.turnIndex) return false;
	if (normalizedAtomicText(base.subject) !== normalizedAtomicText(sweep.subject)) return false;
	if (normalizedAtomicText(base.value) !== normalizedAtomicText(sweep.value)) return false;
	const baseFigures = figureOffsetsInTurn(turnContent, base.sourceSpan.quote);
	const sweepFigures = figureOffsetsInTurn(turnContent, sweep.sourceSpan.quote);
	if (baseFigures !== null && sweepFigures !== null && baseFigures.length > 0 && sweepFigures.length > 0) {
		if (baseFigures.length === sweepFigures.length) {
			return baseFigures.every((offset, index) => offset === sweepFigures[index]);
		}
		// One quote is wide (several figures) and the other names one of them, so position cannot
		// say which figure the wide record states. "$5 on coffee and $5 on parking" quoted whole,
		// then swept narrowly, wrote three fives under a strict rule and lost one under a loose one.
		// The key is the one signal left: the same key restates the fact, a different key is the
		// other one.
		const narrow = baseFigures.length === 1 ? baseFigures : sweepFigures;
		const wide = baseFigures.length === 1 ? sweepFigures : baseFigures;
		if (narrow.length !== 1 || !wide.includes(narrow[0] ?? -1)) return false;
		return (
			base.attribute !== null &&
			sweep.attribute !== null &&
			normalizedAtomicText(base.attribute) === normalizedAtomicText(sweep.attribute)
		);
	}
	return quotesOverlap(base.sourceSpan.quote, sweep.sourceSpan.quote);
}

export interface AtomicNumericTurnSweepInput {
	diagnostics?: { proposed: number; parseRejected: number };
	store: MemoryStore;
	ledgerKey: AtomicExtractionLedgerKey;
	turns: readonly AtomicExtractionTurn[];
	contextTurns?: readonly AtomicExtractionTurn[];
	followingTurns?: readonly AtomicExtractionTurn[];
	sessionDateTime?: string;
	/** Records the ordinary pass returned, whatever lane they will end up in. */
	records: readonly AtomicExtractionRecord[];
	/** Local turn indexes this window owns; every other turn belongs to a different window. */
	eligibleTurnIndexes?: ReadonlySet<number>;
	outputTokenBudget: number;
	transport: AtomicGenericExtractionTransport;
	locale: Locale;
	nowMs: () => number;
	requestId?: string;
}

/**
 * Asks once more about user turns whose stated figures are not all present in their records.
 *
 * A turn reaches exactly one extraction window, so a figure the first pass skips is lost for good
 * and nothing downstream can notice: the row count still looks ordinary. Measured 2026-09-04 on
 * one scored persona-week, 38 of 41 stated figures were captured — and because an aggregation
 * answer is scored on the exact total, eleven coffee purchases surviving together was a coin flip.
 * Replaying the three lost turns, two came back on every attempt and one came back on one attempt
 * in three, with the other two returning no record at all for the whole window.
 *
 * One call, no retry, no recursion, and one caller — so a window can sweep at most once.
 */
export async function runAtomicNumericTurnSweep(
	input: AtomicNumericTurnSweepInput,
): Promise<AtomicExtractionRecord[]> {
	const uncited = input.turns.flatMap((turn, index) =>
		turn.role === "user" &&
		!recordsCaptureEveryNumericToken(input.records, index, turn.content) &&
		(input.eligibleTurnIndexes?.has(index) ?? true) &&
		NUMERIC_CLAIM_PATTERN.test(turn.content)
			? [index]
			: [],
	);
	if (uncited.length === 0) return [];
	const sanitizedInput = sanitizeAtomicPromptValue(input.turns, input.locale);
	let completion: Awaited<ReturnType<AtomicGenericExtractionTransport["complete"]>>;
	try {
		completion = await input.transport.complete({
			prompt: buildAtomicGenericExtractionPrompt(
				input.turns,
				input.sessionDateTime,
				input.locale,
				uncited,
				input.contextTurns,
				input.followingTurns,
			),
			maxTokens: input.outputTokenBudget,
			...(input.requestId ? { requestId: input.requestId } : {}),
		});
	} catch (error) {
		// The throw still ends the window's extraction the way it did before; the line is so the
		// swept turns are named on this path too, not only on the paths that return.
		log.warn("atomic numeric turn sweep call threw", {
			sweptTurnCount: uncited.length,
			sweptTurnIndexes: uncited,
			error,
		}, { event_name: "memory.atomic_generic_extractor.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor.ts", function: "runAtomicNumericTurnSweep", site_id: "extraction.atomic-generic-extractor.runAtomicNumericTurnSweep.7456414b06" });
		throw error;
	}
	if (completion === null) {
		log.warn("atomic numeric turn sweep call returned empty after client retries", {
			sweptTurnCount: uncited.length,
			sweptTurnIndexes: uncited,
		}, { event_name: "memory.atomic_generic_extractor.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor.ts", function: "runAtomicNumericTurnSweep", site_id: "extraction.atomic-generic-extractor.runAtomicNumericTurnSweep.a373dfa454" });
		return [];
	}
	// Counted before the reply is judged: a truncated answer still cost a call, and leaving it out
	// understates the run's own call volume.
	input.store.recordAtomicExtractionCalls(input.ledgerKey, input.nowMs());
	// A failed sweep leaves the window exactly as the first pass left it — the fact it was meant
	// to recover is still missing, and the window is still written. That is deliberate: the sweep
	// is a second chance, and marking a whole window pending because the extra attempt failed
	// would re-run a successful first pass on every such session. It must not be silent, though,
	// so each way it can fail says so.
	if (completion.truncated) {
		log.warn("atomic numeric turn sweep reply rejected: truncated", {
			sweptTurnCount: uncited.length,
			outputTokenBudget: input.outputTokenBudget,
		}, { event_name: "memory.atomic_generic_extractor.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor.ts", function: "runAtomicNumericTurnSweep", site_id: "extraction.atomic-generic-extractor.runAtomicNumericTurnSweep.dc917b09a1" });
		return [];
	}
	const parsed = parseAtomicExtractionReply(completion.text, input.turns.length);
	if (!parsed.ok) {
		if (input.diagnostics) input.diagnostics.parseRejected += parsed.malformedCandidateCount;
		log.warn("atomic numeric turn sweep reply rejected: parse", {
			reason: parsed.ok ? "missing-turn-classification" : parsed.reason,
			sweptTurnCount: uncited.length,
		}, { event_name: "memory.atomic_generic_extractor.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor.ts", function: "runAtomicNumericTurnSweep", site_id: "extraction.atomic-generic-extractor.runAtomicNumericTurnSweep.5264647de8" });
		return [];
	}
	if (input.diagnostics) input.diagnostics.proposed += parsed.records.length;
	// Only records for the swept turns: the sweep sees the whole transcript so it can resolve
	// "this morning", and a claim belonging to a turn this window already settled is not the
	// sweep's to restate.
	const kept = parsed.records.filter((record) => uncited.includes(record.sourceSpan.turnIndex));
	const dropped = parsed.records.filter((record) => !uncited.includes(record.sourceSpan.turnIndex));
	// Nothing downstream removes a repeat — the gauntlet does not dedupe and neither does the
	// writer — so without this the ordinary partial recovery writes the first pass's own fact a
	// second time and quietly doubles a total. The pairing is one-to-one: each first-pass record
	// accounts for at most one sweep record, so a sweep that returns two facts where the first
	// pass has one can never lose both.
	const accountedFor = new Set<number>();
	const fresh: AtomicExtractionRecord[] = [];
	let firstPassRepeatCount = 0;
	let selfRepeatCount = 0;
	for (const [index, record] of kept.entries()) {
		const turnContent = input.turns[record.sourceSpan.turnIndex]?.content ?? "";
		const pairIndex = input.records.findIndex(
			(base, index) => !accountedFor.has(index) && restatesSameFact(base, record, turnContent),
		);
		if (pairIndex !== -1) {
			accountedFor.add(pairIndex);
			firstPassRepeatCount += 1;
			continue;
		}
		// The sweep can also repeat itself within one reply; those pair against what it just said.
		// Counted apart from the repeats above: restating the first pass is expected on every
		// partial recovery, while restating itself in one reply is the model misbehaving.
		if (kept.slice(0, index).some((earlier) =>
			normalizedAtomicText(earlier.claimText) === normalizedAtomicText(record.claimText) &&
			restatesSameFact(earlier, record, turnContent),
		)) {
			selfRepeatCount += 1;
			continue;
		}
		fresh.push(record);
	}
	const merged = [...input.records, ...fresh];
	const recoveredTurnIndexes = uncited.filter((index) => {
		const turn = input.turns[index];
		return turn !== undefined && recordsCaptureEveryNumericToken(merged, index, turn.content);
	});
	const outcome = {
		sweptTurnIndexes: uncited,
		recoveredTurnIndexes,
		unrecoveredTurnIndexes: uncited.filter((index) => !recoveredTurnIndexes.includes(index)),
		returnedRecordCount: parsed.records.length,
		keptRecordCount: kept.length,
		freshRecordCount: fresh.length,
		firstPassRepeatCount,
		selfRepeatCount,
		droppedTurnIndexes: dropped.map((record) => record.sourceSpan.turnIndex),
	};
	if (dropped.length > 0) {
		log.warn("atomic numeric turn sweep dropped records outside the swept turns", outcome, { event_name: "memory.atomic_generic_extractor.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor.ts", function: "runAtomicNumericTurnSweep", site_id: "extraction.atomic-generic-extractor.runAtomicNumericTurnSweep.5f797c1175" });
	} else {
		log.info("atomic numeric turn sweep completed", outcome, { event_name: "memory.atomic_generic_extractor.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor.ts", function: "runAtomicNumericTurnSweep", site_id: "extraction.atomic-generic-extractor.runAtomicNumericTurnSweep.fdcb677e24" });
	}
	return fresh.map((record) => withAtomicSanitizerMatches(record, sanitizedInput.matched));
}

function rejectionPreview(raw: string): { chars: number; preview: string } {
	return { chars: raw.length, preview: redactSecrets(raw).slice(0, 512) };
}

function markPending(
	input: AtomicGenericExtractionInput,
	reason: AtomicExtractionReprocessReason,
	failedReply: string | null,
	attemptCount: number,
): AtomicGenericExtractionResult {
	input.store.markAtomicExtractionPending(
		input.ledgerKey,
		reason,
		failedReply,
		input.nowMs(),
	);
	appendAuditEntry(dirname(input.store.dbPath), {
		event: "error", errorCode: "atomic_capture_window_pending",
		scope: input.ledgerKey.conversationId, resultStatus: "error",
		details: {
			reason, session_key: input.ledgerKey.conversationId,
			chunk_hash: input.ledgerKey.chunkHash, pipeline_version: input.ledgerKey.pipelineVersion,
			turn_count: input.turns.length, attempt_count: attemptCount,
		},
	});
	return { status: "pending", reason };
}

export function createAtomicGenericExtractionTransport(
	client: LlmClient,
): AtomicGenericExtractionTransport {
	return {
		async complete(request): Promise<AtomicGenericExtractionCompletion | null> {
			const text = await client.completeText({
				prompt: request.prompt,
				extractionSkillHash: ATOMIC_EXTRACTION_SKILL_HASH,
				callLabel: "memory-extract-atomic-generic",
				adapterSlot: "memory-extract",
				maxTokens: request.maxTokens,
				emptyReplyAttempts: 1,
				enableThinking: false,
				...(request.requestId ? { requestId: request.requestId } : {}),
			});
			if (text === null) {
				const error = client.getLastError();
				if (error !== null) throw new Error(error);
				return null;
			}
			const usage = client.getLastUsage();
			return {
				text,
				truncated: usage !== null && usage.outputTokens >= request.maxTokens,
				...(usage === null ? {} : { outputTokens: usage.outputTokens }),
			};
		},
	};
}

export function createSignedAtomicGenericExtractionTransport(
	config: Omit<LlmClientConfig, "preset">,
): AtomicGenericExtractionTransport {
	return createAtomicGenericExtractionTransport(
		createLlmClient({ ...config, preset: FIXED_MEMORY_SNO_EXTRACT_CHAT }),
	);
}

export async function runAtomicGenericExtractionPass(
	input: AtomicGenericExtractionInput,
): Promise<AtomicGenericExtractionResult> {
	if (!Number.isSafeInteger(input.estimatedInputTokens) || input.estimatedInputTokens < 0) {
		throw new Error("estimatedInputTokens must be a non-negative safe integer");
	}
	const begin = input.store.beginAtomicExtractionChunk({
		...input.ledgerKey,
		rawChunk: input.rawChunk,
		routingSnapshotId: input.routingSnapshotId,
		runParameters: input.runParameters,
		nowMs: input.nowMs(),
	});
	if (begin.action === "skip") return { status: "skip", entry: begin.entry };
	if (begin.action === "pending") {
		if (begin.entry.reprocessReason === null) {
			throw new Error("Pending atomic extraction ledger row has no reprocess reason");
		}
		const reopened = input.store.reopenAtomicExtractionChunk(
			input.ledgerKey,
			ATOMIC_REPROCESS_ATTEMPT_CAP,
			{
				maxOutputTokenBudget: Math.max(
					begin.entry.runParameters.outputTokenBudget,
					input.runParameters.outputTokenBudget,
				) * 2,
				requiredInputTokens: input.estimatedInputTokens,
			},
			input.nowMs(),
		);
		if (reopened.status === "stuck") {
			return { status: "pending", reason: begin.entry.reprocessReason };
		}
		return runAtomicGenericExtractionPass(input);
	}
	const attempts = { count: 0 };
	const outputTokenBudget = Math.min(
		begin.entry.runParameters.outputTokenBudget, input.runParameters.outputTokenBudget,
	);
	const inputOverflow = input.estimatedInputTokens > begin.entry.runParameters.maxInputTokens;
	// One turn over the input budget is split the same way as one whose reply overflows: a long
	// replayed transcript is a single turn, and giving up on it unasked lost whole sessions.
	if (inputOverflow && !(input.turns.length === 1 && splitTurnContent(input.turns[0]?.content ?? "") !== undefined)) {
		input.store.recordAtomicExtractionCalls(input.ledgerKey, input.nowMs());
		return markPending(input, "input-overflow", null, 0);
	}
	const result = inputOverflow
		? await splitAtomicCaptureTurn(input, outputTokenBudget, attempts, "")
		: await captureAtomicWindow(input, outputTokenBudget, attempts);
	if (result.status === "pending") {
		return markPending(input, result.reason, result.failedReply, attempts.count);
	}
	return result;
}

type CaptureWindowResult =
	| Extract<AtomicGenericExtractionResult, { status: "complete" | "off" }>
	| { status: "pending"; reason: AtomicExtractionReprocessReason; failedReply: string };

async function splitAtomicCaptureWindow(
	input: AtomicGenericExtractionInput,
	outputTokenBudget: number,
	attempts: { count: number },
): Promise<CaptureWindowResult> {
	const records: AtomicExtractionRecord[] = [];
	const progressTurns = new Set<number>();
	let offset = 0;
	for (const turns of buildAtomicExtractionWindows(input.turns, Math.ceil(input.turns.length / 2))) {
		const result = await captureAtomicWindow({
			...input, turns,
			contextTurns: [...(input.contextTurns ?? []), ...input.turns.slice(0, offset)],
			followingTurns: [...input.turns.slice(offset + turns.length), ...(input.followingTurns ?? [])],
		}, outputTokenBudget, attempts);
		if (result.status !== "complete") return result;
		for (const record of result.records) {
			records.push({ ...record, sourceSpan: { ...record.sourceSpan, turnIndex: record.sourceSpan.turnIndex + offset } });
		}
		for (const index of result.progressTurns) progressTurns.add(index + offset);
		offset += turns.length;
	}
	return { status: "complete", records, progressTurns };
}

const ATOMIC_CAPTURE_ATTEMPTS = 3;

/**
 * Halves of one turn's content, cut at the paragraph break nearest its middle. A pasted or
 * replayed transcript arrives as a single turn, so when its capture reply overflows the output
 * budget there is no turn boundary to split at; the content itself still has paragraph breaks.
 * A turn with no break away from its edges cannot be split.
 */
function splitTurnContent(content: string): [string, string] | undefined {
	const middle = Math.floor(content.length / 2);
	const nearestInRange = (pattern: RegExp): number | undefined => {
		let best: number | undefined;
		for (const { index } of content.matchAll(pattern)) {
			if (index < content.length * 0.2 || index > content.length * 0.8) continue;
			if (best === undefined || Math.abs(index - middle) < Math.abs(best - middle)) best = index;
		}
		return best;
	};
	// A paragraph break first; a transcript whose blank lines all sit in its header still has a
	// line break near its middle.
	const best = nearestInRange(/\n\s*\n/g) ?? nearestInRange(/\n/g);
	if (best === undefined) return undefined;
	return [content.slice(0, best).trimEnd(), content.slice(best).trimStart()];
}

async function splitAtomicCaptureTurn(
	input: AtomicGenericExtractionInput,
	outputTokenBudget: number,
	attempts: { count: number },
	failedReply: string,
): Promise<CaptureWindowResult> {
	const [turn] = input.turns;
	const halves = turn === undefined ? undefined : splitTurnContent(turn.content);
	if (turn === undefined || halves === undefined) {
		return { status: "pending", reason: "truncation-exhaustion", failedReply };
	}
	const records: AtomicExtractionRecord[] = [];
	const progressTurns = new Set<number>();
	for (const [half, content] of halves.entries()) {
		const result = await captureAtomicWindow({
			...input,
			turns: [{ ...turn, content }],
			contextTurns: [...(input.contextTurns ?? []), ...(half === 1 ? [{ ...turn, content: halves[0] }] : [])],
			followingTurns: [...(half === 0 ? [{ ...turn, content: halves[1] }] : []), ...(input.followingTurns ?? [])],
		}, outputTokenBudget, attempts);
		if (result.status !== "complete") return result;
		// Both halves are the same turn: source turn indexes and progress decisions stay at 0.
		records.push(...result.records);
		for (const index of result.progressTurns) progressTurns.add(index);
	}
	return { status: "complete", records, progressTurns };
}

async function captureAtomicWindow(
	input: AtomicGenericExtractionInput,
	outputTokenBudget: number,
	attempts: { count: number },
): Promise<CaptureWindowResult> {
	const sanitizedInput = sanitizeAtomicPromptValue(input.turns, input.locale ?? DEFAULT_LOCALE);
	const prompt = buildAtomicCapturePrompt(input);
	let lastReply = "";
	for (let attempt = 1; attempt <= ATOMIC_CAPTURE_ATTEMPTS; attempt += 1) {
		attempts.count += 1;
		const completion = await input.transport.complete({
			prompt, maxTokens: outputTokenBudget,
			...(input.requestId ? { requestId: input.requestId } : {}),
		});
		if (completion === null) return { status: "off" };
		lastReply = completion.text;
		const preview = rejectionPreview(completion.text);
		input.store.recordAtomicExtractionCalls(input.ledgerKey, input.nowMs());
		if (completion.truncated) {
			log.warn(`atomic extraction reply rejected: truncated; preview: ${preview.preview}`, {
				attempt, outputTokenBudget, turnCount: input.turns.length,
				chars: preview.chars,
			}, { event_name: "memory.atomic_generic_extractor.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor.ts", function: "captureAtomicWindow", site_id: "extraction.atomic-generic-extractor.runAtomicGenericExtractionPass.cce4a719a3" });
			if (input.turns.length > 1) return splitAtomicCaptureWindow(input, outputTokenBudget, attempts);
			// A single turn that overflows the budget does not shrink by asking again.
			return splitAtomicCaptureTurn(input, outputTokenBudget, attempts, lastReply);
		}
		let gate = "unreadable-json";
		const parsed = parseAtomicCaptureReply(completion.text, input.turns, {
			salvage: attempt >= 2, onReject: (reason) => { gate = reason; },
		});
		if (parsed !== undefined) {
			const records: AtomicExtractionRecord[] = [];
			for (const batch of chunkAtomicCapturedFacts(parsed.facts)) {
				records.push(...await enrichAtomicBatch(input, batch, outputTokenBudget));
			}
			if (input.diagnostics) input.diagnostics.proposed += records.length;
			return {
				status: "complete", progressTurns: parsed.progressTurns,
				records: records.map((record) => withAtomicSanitizerMatches(record, sanitizedInput.matched)),
			};
		}
		if (input.diagnostics) input.diagnostics.parseRejected += 1;
		log.warn(`atomic extraction reply rejected: parse; preview: ${preview.preview}`, {
			attempt, reason: "invalid-capture-reply", rejection_reason: gate,
			chars: preview.chars,
		}, { event_name: "memory.atomic_generic_extractor.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor.ts", function: "captureAtomicWindow", site_id: "extraction.atomic-generic-extractor.runAtomicGenericExtractionPass.98a701bd95" });
	}
	return { status: "pending", reason: "parse-exhaustion", failedReply: lastReply };
}
