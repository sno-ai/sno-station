/** @file atomic-profile-keying.ts
 * @purpose Runs the profile adapter once per user turn and lets it fill a base record's missing key.
 * @boundary Dark call-2 flow only; no storage writes or live extraction routing.
 */

import { z } from "zod";
import attributeDictionaryResource from "../../../config/attribute-dictionary.json" with {
	type: "json",
};
import {
	type AtomicGauntletRecord,
	runAtomicExtractionGauntlet,
} from "./atomic-extraction-gauntlet";
import {
	buildAttributeSlugIndex,
	parseAttributeDictionary,
	resolveAttributeSlug,
} from "./attribute-slug-matcher";
import { extractBProfileCandidatesFromChunk } from "./b-profile-extraction";
import type {
	AtomicExtractionRecord,
	AtomicExtractionTurn,
} from "./atomic-extraction-reply";
import {
	sanitizeAtomicPromptValue,
	sanitizeAtomicText,
	withAtomicSanitizerMatches,
} from "./atomic-replacement-sanitizer";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import { isTerminalLlmFailure, type LlmClient } from "../../model/llm-client";
import { escapeTranscriptRoleContinuations } from "../shared/transcript-role-codec";
import type { CandidateMemory } from "../shared/types";

const ENHANCEMENT_BATCH_SIZE = 4;

export interface AtomicProfileKeyingTransport {
	keyTurn(input: {
		turnIndex: number;
		turn: AtomicExtractionTurn;
		locale?: Locale;
	}): Promise<AtomicExtractionRecord[] | null>;
}

export interface AtomicKeyedRecord extends AtomicGauntletRecord {
	category: "episodic" | "profile" | "state";
	keyingNote?:
		| "keying-unmatched"
		| "bare-base-grounded"
		| "keying-failed"
		| "keying-skipped:span-unresolvable";
	baseProvenance?: Array<{
		claimText: string;
		sourceSpan: AtomicGauntletRecord["sourceSpan"];
		relations: AtomicGauntletRecord["relations"];
	}>;
}

export interface RunAtomicProfileKeyingInput {
	baseRecords: readonly AtomicKeyedRecord[];
	turns: readonly AtomicExtractionTurn[];
	projectId: string;
	transport: AtomicProfileKeyingTransport;
	locale?: Locale;
	sessionDateTime?: string;
	sessionTimezone?: string;
}

const attributeIndex = buildAttributeSlugIndex(parseAttributeDictionary(attributeDictionaryResource));

const atomicValueNotesPayloadSchema = z
	.object({ value: z.string(), notes: z.string().nullable() })
	.strict();
const atomicLikesDislikesPayloadSchema = z
	.object({ likes: z.array(z.string()), dislikes: z.array(z.string()) })
	.strict();
const atomicRawCandidateSchema = z.object({ payload: z.record(z.string(), z.unknown()) }).passthrough();

function readCandidateAttribute(rawCandidateJson?: string): string | null {
	if (!rawCandidateJson) return null;
	try {
		const raw = JSON.parse(rawCandidateJson) as { slug?: unknown };
		if (typeof raw.slug !== "string") return null;
		return resolveAttributeSlug(attributeIndex, raw.slug)?.slug ?? null;
	} catch {
		return null;
	}
}

interface AtomicCandidateClaim {
	claimText: string;
	value: string;
}

function decodeAtomicCandidatePayload(candidate: CandidateMemory): Record<string, unknown> {
	let decoded: unknown;
	try {
		decoded = JSON.parse(candidate.rawCandidateJson ?? "");
	} catch {
		throw new Error("Atomic profile keying candidate has no readable payload");
	}
	const parsed = atomicRawCandidateSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new Error("Atomic profile keying candidate has no readable payload");
	}
	return parsed.data.payload;
}

/**
 * One claim per independently mutable item. A likes/dislikes payload used to be joined into
 * "The user likes A and B. The user dislikes C." and stamped single_claim — measured 2026-09-04
 * on the live route, that sentence reached the store as a compound memory and never paired with
 * its base record, so the same fact was stored twice under one key.
 */
function readAtomicCandidateClaims(candidate: CandidateMemory): AtomicCandidateClaim[] {
	const payload = decodeAtomicCandidatePayload(candidate);
	const valueNotes = atomicValueNotesPayloadSchema.safeParse(payload);
	if (valueNotes.success) {
		const value = valueNotes.data.value.trim();
		const notes = valueNotes.data.notes?.trim();
		if (!value) throw new Error("Atomic profile keying candidate payload is empty");
		const claimText = notes ? `${value} (${notes})` : value;
		return [{ claimText, value: claimText }];
	}
	const likesDislikes = atomicLikesDislikesPayloadSchema.safeParse(payload);
	if (!likesDislikes.success) {
		throw new Error("Atomic profile keying candidate payload has no supported shape");
	}
	const claims = [
		...likesDislikes.data.likes.map((item) => ({ verb: "likes", item: item.trim() })),
		...likesDislikes.data.dislikes.map((item) => ({ verb: "dislikes", item: item.trim() })),
	]
		.filter(({ item }) => item.length > 0)
		.map(({ verb, item }) => ({ claimText: `The user ${verb} ${item}.`, value: item }));
	if (claims.length === 0) throw new Error("Atomic profile keying candidate payload is empty");
	return claims;
}

export function createBProfileKeyingTransport(
	llm: LlmClient,
): AtomicProfileKeyingTransport {
	return {
		async keyTurn({ turnIndex, turn, locale }): Promise<AtomicExtractionRecord[] | null> {
			// The adapter was trained on one prompt shape, `user: <turn>`, and nothing else. Wrapping
			// the turn in the data-instruction line and `<take>` fence puts it off that shape, and the
			// model answers with an immediate end token: measured 2026-09-04, 683 of 874 completions
			// returned one token and every persona logged ~500 empty replies. Plain sanitized text only.
			const sanitizedTurn = sanitizeAtomicText(turn.content, locale ?? DEFAULT_LOCALE);
			const result = await extractBProfileCandidatesFromChunk({
				conversationText: `user: ${escapeTranscriptRoleContinuations(sanitizedTurn.value)}`,
				llm,
			});
			if (result.cleanEmptyModelResult) return [];
			return result.candidates.flatMap((candidate) => {
				const attribute = readCandidateAttribute(candidate.rawCandidateJson);
				return readAtomicCandidateClaims(candidate).map(({ claimText, value }) =>
					withAtomicSanitizerMatches<AtomicExtractionRecord>(
						{
							kind: "standing",
							claimText,
							subject: "user",
							subjectKind: "user",
							attribute,
							value,
							temporalPhrase: null,
							time: { kind: "none" },
							endedTime: { kind: "none" },
							resolvedTime: null,
							endsCurrent: false,
							endedAtPhrase: null,
							endedAt: null,
							importance: "medium",
							changesCurrentState: false,
							todo: "none",
							closeReason: null,
							sourceSpan: { turnIndex, quote: sanitizedTurn.value },
							relations: [],
							singleClaim: true,
						},
						sanitizedTurn.matched,
					),
				);
			});
		},
	};
}

function normalizedValue(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function evidenceSubsumes(
	left: AtomicGauntletRecord["sourceSpan"],
	right: AtomicGauntletRecord["sourceSpan"],
): boolean {
	if (left === null || right === null || left.turnIndex !== right.turnIndex) return false;
	return left.quote.includes(right.quote) || right.quote.includes(left.quote);
}

function sameFactExceptAttribute(
	base: AtomicGauntletRecord,
	adapterRecord: AtomicGauntletRecord,
): boolean {
	return (
		base.sourceSpan?.turnIndex === adapterRecord.sourceSpan?.turnIndex &&
		base.subject === adapterRecord.subject &&
		normalizedValue(base.value) === normalizedValue(adapterRecord.value) &&
		evidenceSubsumes(base.sourceSpan, adapterRecord.sourceSpan)
	);
}

export function sameFactIdentity(
	base: AtomicGauntletRecord,
	adapterRecord: AtomicGauntletRecord,
): boolean {
	return base.attribute === adapterRecord.attribute && sameFactExceptAttribute(base, adapterRecord);
}

/**
 * Pairing for the keying stage, where a base record with no key yet matches any adapter key.
 *
 * This stage exists to fill a base record's missing key, and requiring the two keys to be equal
 * first made that unreachable: a base record with no key never paired with the adapter record
 * carrying the key for the same fact, so the adapter record was dropped and the base record came
 * back `keying-unmatched` with its key still missing. Every other field still has to match, and
 * an ambiguous pairing is still discarded by the one-to-one rule below.
 *
 * The wildcard is one-directional on purpose. A base record that already HAS a key must match the
 * adapter's key exactly: an adapter record whose own slug failed to resolve carries `null`, and
 * letting that pair with anything would merge its relations onto a keyed record that may mean
 * something else, with no failure signal anywhere.
 *
 * And the wildcard is refused when the turn states the same value twice. The adapter cites the
 * WHOLE turn as its evidence — it has no fact-specific span to give, because the deployed adapter
 * answered "1" to 60 of 60 position probes — so evidence cannot separate two facts that share a
 * value inside one turn. "I live in Austin, and Austin is also my favourite destination" gives a
 * keyless residence record and a destination key that pair on subject, value and whole-turn
 * evidence alike, and the residence fact would be filed under the destination key with nothing
 * anywhere reporting it. A second occurrence of the value is the one deterministic sign that the
 * turn can carry two such facts, so the record stays `keying-unmatched` instead: no key is
 * recoverable, a wrong key corrupts the group it lands in.
 */
function valueStatedOnceInTurn(turnContent: string, value: string): boolean {
	const haystack = turnContent.normalize("NFKC").toLowerCase();
	const needle = value.normalize("NFKC").trim().toLowerCase();
	if (needle.length === 0) return false;
	const first = haystack.indexOf(needle);
	return first !== -1 && haystack.indexOf(needle, first + needle.length) === -1;
}

function sameProfileIdentity(
	base: AtomicKeyedRecord,
	adapterRecord: AtomicGauntletRecord,
	turnContent: string,
): boolean {
	const keyMatches =
		base.attribute === null
			? valueStatedOnceInTurn(turnContent, base.value)
			: base.attribute === adapterRecord.attribute;
	return (
		base.category === "profile" &&
		adapterRecord.kind === "standing" &&
		keyMatches &&
		sameFactExceptAttribute(base, adapterRecord)
	);
}

function withNote(
	record: AtomicKeyedRecord,
	keyingNote: AtomicKeyedRecord["keyingNote"],
): AtomicKeyedRecord {
	return { ...record, keyingNote };
}

function reconcileTurn(
	baseRecords: readonly AtomicKeyedRecord[],
	adapterRecords: readonly AtomicGauntletRecord[],
	turnContent: string,
): AtomicKeyedRecord[] {
	const baseMatches = baseRecords.map((base) =>
		adapterRecords.flatMap((adapterRecord, index) =>
			sameProfileIdentity(base, adapterRecord, turnContent) ? [index] : [],
		),
	);
	const adapterMatches = adapterRecords.map((adapterRecord) =>
		baseRecords.flatMap((base, index) =>
			sameProfileIdentity(base, adapterRecord, turnContent) ? [index] : [],
		),
	);
	const replacedBase = new Set<number>();
	const output: AtomicKeyedRecord[] = [];
	for (const [adapterIndex, adapterRecord] of adapterRecords.entries()) {
		const candidates = adapterMatches[adapterIndex] ?? [];
		const baseIndex = candidates.length === 1 ? candidates[0] : undefined;
		if (baseIndex !== undefined && (baseMatches[baseIndex]?.length ?? 0) === 1) {
			const base = baseRecords[baseIndex];
			if (!base) continue;
			replacedBase.add(baseIndex);
			const relations = [...adapterRecord.relations];
			for (const relation of base.relations) {
				if (
					!relations.some(
						(item) =>
							item.subject === relation.subject &&
							item.predicate === relation.predicate &&
							item.object === relation.object,
					)
				) {
					relations.push(relation);
				}
			}
			// The base record's sentence stays (owner ruling 2026-09-04). Measured on the live
			// route: letting the adapter's value replace it left memory text "peanuts" / "Austin",
			// and turned "primary editor is Emacs" into "likes Emacs", which the subject guard
			// then parked. The adapter may only fill a missing key and add relations.
			output.push({
				...base,
				attribute: base.attribute ?? adapterRecord.attribute,
				relations,
			});
		}
		// An adapter record that pairs with no base record is dropped (owner ruling 2026-09-04).
		// Measured on the live route: every such extra was either the adapter's own inference
		// ("dislikes Vim" from "switched to Emacs") or a list item under the list's single slug
		// ("jazz" under preference.food), and each one landed as a wrong-key duplicate or a park.
	}
	for (const [baseIndex, base] of baseRecords.entries()) {
		if (!replacedBase.has(baseIndex)) output.push(withNote(base, "keying-unmatched"));
	}
	return output;
}

function recordsForTurn(
	records: readonly AtomicKeyedRecord[],
	turnIndex: number,
): AtomicKeyedRecord[] {
	return records.filter((record) => record.sourceSpan?.turnIndex === turnIndex);
}

export async function runAtomicProfileKeying(
	input: RunAtomicProfileKeyingInput,
): Promise<AtomicKeyedRecord[]> {
	if (!input.projectId.trim()) throw new Error("Atomic profile keying requires projectId");
	const profileRecords = input.baseRecords.filter(
		(record) => record.category === "profile" && record.subjectKind === "user",
	);
	const passthrough = input.baseRecords.filter((record) => !profileRecords.includes(record));
	const unresolved = profileRecords.filter((record) => record.sourceSpan === null);
	const nonUserRecords = profileRecords.filter(
		(record) =>
			record.sourceSpan !== null && input.turns[record.sourceSpan.turnIndex]?.role !== "user",
	);
	const resolvableTurnIndexes = [
		...new Set(
			profileRecords.flatMap((record) =>
				record.sourceSpan === null || input.turns[record.sourceSpan.turnIndex]?.role !== "user"
					? []
					: [record.sourceSpan.turnIndex],
			),
		),
	];
	const output: AtomicKeyedRecord[] = [
		...passthrough,
		...unresolved.map((record) => withNote(record, "keying-skipped:span-unresolvable")),
		...nonUserRecords.map((record) => withNote(record, "bare-base-grounded")),
	];

	for (let start = 0; start < resolvableTurnIndexes.length; start += ENHANCEMENT_BATCH_SIZE) {
		const batch = resolvableTurnIndexes.slice(start, start + ENHANCEMENT_BATCH_SIZE);
		const results = await Promise.all(
			batch.map(async (turnIndex) => {
				const baseRecords = recordsForTurn(profileRecords, turnIndex);
				const turn = input.turns[turnIndex];
				if (!turn) return baseRecords.map((record) => withNote(record, "keying-failed"));
				let adapterRecord: AtomicExtractionRecord[] | null;
				try {
					const locale = input.locale ?? DEFAULT_LOCALE;
					const sanitizedTurn = sanitizeAtomicPromptValue(turn, locale);
					adapterRecord = await input.transport.keyTurn({
						turnIndex,
						turn: sanitizedTurn.value,
						locale,
					});
					if (adapterRecord !== null) {
						adapterRecord = adapterRecord.map((record) =>
							withAtomicSanitizerMatches(record, sanitizedTurn.matched),
						);
					}
				} catch (error) {
					if (isTerminalLlmFailure(error)) throw error;
					return baseRecords.map((record) => withNote(record, "keying-failed"));
				}
				if (adapterRecord === null) {
					return baseRecords.map((record) => withNote(record, "keying-failed"));
				}
				if (adapterRecord.length === 0) {
					return baseRecords.map((record) => withNote(record, "bare-base-grounded"));
				}
				const processed = await runAtomicExtractionGauntlet({
					records: adapterRecord,
					turns: input.turns,
					resplit: true,
					...(input.locale ? { locale: input.locale } : {}),
					...(input.sessionDateTime ? { sessionDateTime: input.sessionDateTime } : {}),
					...(input.sessionTimezone ? { sessionTimezone: input.sessionTimezone } : {}),
				});
				return reconcileTurn(baseRecords, processed, turn.content);
			}),
		);
		for (const records of results) output.push(...records);
	}
	return output;
}
