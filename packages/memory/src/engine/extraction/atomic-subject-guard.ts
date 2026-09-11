/** @file atomic-subject-guard.ts
 * @purpose Repairs missing profile halves, then guards every user-subject profile in one batch.
 * @boundary Dark flow after profile keying only; no storage writes or live extraction routing.
 */

import { createLogger } from "@snoai/utils/logger";
import { z } from "zod";
import attributeDictionary from "../../../config/attribute-dictionary.json" with { type: "json" };
import stateVocabulary from "../../../config/state-vocabulary.json" with { type: "json" };
import {
	ATOMIC_EXTRACTION_RESPONSE_JSON_SCHEMA,
	type AtomicExtractionRecord,
	type AtomicExtractionTurn,
	parseAtomicExtractionReply,
} from "./atomic-extraction-reply";
import {
	type AtomicGauntletRecord,
	runAtomicExtractionGauntlet,
} from "./atomic-extraction-gauntlet";
import {
	ATOMIC_EXTRACTION_SKILL,
	atomicExtractionSkillReference,
} from "./atomic-extraction-skill";
import {
	sameFactIdentity,
	type AtomicKeyedRecord,
} from "./atomic-profile-keying";
import {
	numberAtomicTurns,
	renderAtomicPromptData,
	sanitizeAtomicPromptValue,
	withAtomicSanitizerMatches,
} from "./atomic-replacement-sanitizer";
import { isTerminalLlmFailure, type LlmClient } from "../../model/llm-client";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";

const log = createLogger("sno-station-mem:atomic-subject-guard");

const guardReplySchema = z
	.object({
		decisions: z.array(
			z
				.object({
					record_index: z.number().int().nonnegative(),
					durable_self_statement: z.boolean(),
				})
				.strict(),
		),
	})
	.strict();

export interface AtomicSubjectGuardTransport {
	repairMissingHalf(input: {
		episode: AtomicKeyedRecord;
		turn: AtomicExtractionTurn;
		turns: readonly AtomicExtractionTurn[];
		locale?: Locale;
	}): Promise<AtomicExtractionRecord[] | null>;
	guardUserSubjects(input: {
		records: readonly AtomicKeyedRecord[];
		locale?: Locale;
	}): Promise<readonly (boolean | null)[] | null>;
}

export interface RunAtomicSubjectGuardInput {
	records: readonly AtomicKeyedRecord[];
	turns: readonly AtomicExtractionTurn[];
	transport: AtomicSubjectGuardTransport;
	locale?: Locale;
	sessionDateTime?: string;
	sessionTimezone?: string;
}

function buildMissingHalfPrompt(
	episode: AtomicKeyedRecord,
	turn: AtomicExtractionTurn,
	turns: readonly AtomicExtractionTurn[],
	locale: Locale,
): { prompt: string; matched: string[] } {
	const data = renderAtomicPromptData(
		{ episode, turn, turns: numberAtomicTurns(turns) },
		locale,
	);
	return {
		prompt: [
		ATOMIC_EXTRACTION_SKILL,
		atomicExtractionSkillReference("missing-durable-half"),
		"Task: missing durable half.",
		`person_attribute_slugs: ${JSON.stringify(attributeDictionary.slugs.map(({ slug }) => slug))}`,
		`thing_attribute_slugs: ${JSON.stringify(stateVocabulary.slugs.map(({ slug }) => slug))}`,
		`input:\n${data.value}`,
		`response_schema: ${JSON.stringify(ATOMIC_EXTRACTION_RESPONSE_JSON_SCHEMA)}`,
		].join("\n\n"),
		matched: data.matched,
	};
}

function buildSubjectGuardPrompt(
	records: readonly AtomicKeyedRecord[],
	locale: Locale,
): { prompt: string; matched: string[] } {
	const evidence = records.map((record, recordIndex) => ({
		record_index: recordIndex,
		claim_text: record.claimText,
		subject: record.subject,
		attribute: record.attribute,
		value: record.value,
		source_quote: record.sourceSpan?.quote ?? null,
	}));
	const data = renderAtomicPromptData(evidence, locale);
	return {
		prompt: [
			ATOMIC_EXTRACTION_SKILL,
			atomicExtractionSkillReference("user-subject-guard"),
			"Task: user-subject guard.",
			`records:\n${data.value}`,
			'response_schema: {"decisions":[{"record_index":0,"durable_self_statement":true}]}',
		].join("\n\n"),
		matched: data.matched,
	};
}

export function createAtomicSubjectGuardTransport(llm: LlmClient): AtomicSubjectGuardTransport {
	return {
		async repairMissingHalf({ episode, turn, turns, locale }) {
			const built = buildMissingHalfPrompt(episode, turn, turns, locale ?? DEFAULT_LOCALE);
			const text = await llm.completeText({
				prompt: built.prompt,
				callLabel: "memory-extract-atomic-missing-half",
				adapterSlot: "memory-extract",
				emptyReplyAttempts: 1,
				enableThinking: false,
			});
			if (text === null) return null;
			const parsed = parseAtomicExtractionReply(text, turns.length);
			return parsed.ok
				? parsed.records.map((record) => withAtomicSanitizerMatches(record, built.matched))
				: null;
		},
		async guardUserSubjects({ records, locale }) {
			const built = buildSubjectGuardPrompt(records, locale ?? DEFAULT_LOCALE);
			const raw = await llm.completeJson<unknown>({
				prompt: built.prompt,
				callLabel: "memory-extract-atomic-subject-guard",
				adapterSlot: "memory-extract",
				emptyReplyAttempts: 1,
				enableThinking: false,
				accept: (value) => guardReplySchema.safeParse(value).success,
			});
			const parsed = guardReplySchema.safeParse(raw);
			if (!parsed.success) return null;
			// Match decisions to records by the index the model wrote back. A record the reply
			// skipped, or numbered twice, is undecided on its own; the rest of the batch keeps its
			// answers instead of the whole batch being parked (measured 2026-09-06: two whole batches
			// parked, and with them "enjoyed the book Freakonomics").
			const byIndex = new Map<number, boolean>();
			for (const decision of parsed.data.decisions) {
				if (byIndex.has(decision.record_index)) byIndex.set(decision.record_index, undefined as never);
				else byIndex.set(decision.record_index, decision.durable_self_statement);
			}
			return records.map((_, index) => byIndex.get(index) ?? null);
		},
	};
}

function parkSubject(
	record: AtomicKeyedRecord,
	reason: "subject-rejected" | "subject-unverified",
): AtomicKeyedRecord {
	return {
		...record,
		subject: null,
		attribute: null,
		lane: "parked",
		dispositionReason: reason,
	};
}

async function repairMissingHalves(
	input: RunAtomicSubjectGuardInput,
): Promise<AtomicKeyedRecord[]> {
	const profiles = input.records.filter(
		(record) => record.lane === "active" && record.category === "profile",
	);
	const candidates = input.records.filter(
		(record) =>
			record.lane === "active" &&
			record.category === "episodic" &&
			record.changesCurrentState &&
			record.sourceSpan !== null &&
			!profiles.some((profile) => sameFactIdentity(record, profile)),
	);
	const repaired = await Promise.all(
		candidates.map(async (episode): Promise<AtomicKeyedRecord[]> => {
			if (episode.sourceSpan === null) return [];
			const turn = input.turns[episode.sourceSpan.turnIndex];
			if (!turn) return [];
			let records: AtomicExtractionRecord[] | null;
			try {
				const locale = input.locale ?? DEFAULT_LOCALE;
				const sanitized = sanitizeAtomicPromptValue(
					{ episode, turn, turns: input.turns },
					locale,
				);
				records = await input.transport.repairMissingHalf({
					...sanitized.value,
					locale,
				});
				if (records !== null) {
					records = records.map((record) =>
						withAtomicSanitizerMatches(record, sanitized.matched),
					);
				}
			} catch (error) {
				if (isTerminalLlmFailure(error)) throw error;
				return [];
			}
			if (records === null || records.length === 0) return [];
			const repaired = await runAtomicExtractionGauntlet({
				records,
				turns: input.turns,
				resplit: true,
				...(input.locale ? { locale: input.locale } : {}),
				...(input.sessionDateTime ? { sessionDateTime: input.sessionDateTime } : {}),
				...(input.sessionTimezone ? { sessionTimezone: input.sessionTimezone } : {}),
			});
			return repaired
				.filter(
					(record) =>
						record.lane === "active" &&
						record.kind === "standing" &&
						record.subjectKind === "user" &&
						sameFactIdentity(episode, record),
				)
				.map((record): AtomicKeyedRecord => ({ ...record, category: "profile" }));
		}),
	);
	return [...input.records, ...repaired.flat()];
}

export async function runAtomicSubjectGuard(
	input: RunAtomicSubjectGuardInput,
): Promise<AtomicKeyedRecord[]> {
	const records = await repairMissingHalves(input);
	const guardedIndexes = records.flatMap((record, index) =>
		record.lane === "active" && record.category === "profile" && record.subjectKind === "user"
			? [index]
			: [],
	);
	if (guardedIndexes.length === 0) return records;
	const guardedRecords = guardedIndexes.flatMap((index) => {
		const record = records[index];
		return record === undefined ? [] : [record];
	});
	const locale = input.locale ?? DEFAULT_LOCALE;
	const sanitizedGuard = guardedRecords.map((record) =>
		sanitizeAtomicPromptValue(record, locale),
	);
	for (const [guardedIndex, index] of guardedIndexes.entries()) {
		const record = records[index];
		const sanitizerMatches = sanitizedGuard[guardedIndex]?.matched ?? [];
		if (record) records[index] = withAtomicSanitizerMatches(record, sanitizerMatches);
	}
	let decisions: readonly (boolean | null)[] | null;
	try {
		decisions = await input.transport.guardUserSubjects({
			records: sanitizedGuard.map(({ value }) => value),
			locale,
		});
	} catch (error) {
		if (isTerminalLlmFailure(error)) throw error;
		decisions = null;
	}
	if (decisions === null) {
		log.warn("subject guard gave no usable decision; parking the guarded records", {
			guardedRecordCount: guardedRecords.length,
		}, { event_name: "memory.atomic_subject_guard.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-subject-guard.ts", function: "runAtomicSubjectGuard", site_id: "extraction.atomic-subject-guard.runAtomicSubjectGuard.037dc017c1" });
		for (const index of guardedIndexes) {
			const record = records[index];
			if (record) records[index] = parkSubject(record, "subject-unverified");
		}
		return records;
	}
	let undecided = 0;
	for (const [decisionIndex, recordIndex] of guardedIndexes.entries()) {
		const decision = decisions[decisionIndex] ?? null;
		if (decision === true) continue;
		const record = records[recordIndex];
		if (!record) continue;
		if (decision === null) undecided += 1;
		records[recordIndex] = parkSubject(record, decision === false ? "subject-rejected" : "subject-unverified");
	}
	if (undecided > 0) {
		log.warn("subject guard left records undecided; parking those only", {
			undecided,
			guardedRecordCount: guardedRecords.length,
		}, { event_name: "memory.atomic_subject_guard.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-subject-guard.ts", function: "runAtomicSubjectGuard", site_id: "extraction.atomic-subject-guard.runAtomicSubjectGuard.7fbb9c4f6d" });
	}
	return records;
}
