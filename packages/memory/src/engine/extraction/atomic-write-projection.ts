/** @file atomic-write-projection.ts
 * @purpose Projects guarded atomic records into the mechanical storage-door contract.
 * @boundary Deterministic axes and metadata only; no model calls, suppression, or persistence.
 */

import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import atomicWriteConfigResource from "../../../config/atomic-memory-write.json" with { type: "json" };
import type { AtomicKeyedRecord } from "./atomic-profile-keying";
import { sanitizeAtomicPromptValue } from "./atomic-replacement-sanitizer";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import type { AtomicExtractionWriteCard } from "../../store/store";

export interface AtomicMemoryWriteConfig {
	importance: Record<"high" | "medium" | "low", number>;
}

const atomicWriteConfigSchema: z.ZodType<AtomicMemoryWriteConfig> = z
	.object({
		importance: z
			.object({
				high: z.number().min(0).max(1),
				medium: z.number().min(0).max(1),
				low: z.number().min(0).max(1),
			})
			.strict(),
	})
	.strict();

export const ATOMIC_MEMORY_WRITE_CONFIG: AtomicMemoryWriteConfig =
	atomicWriteConfigSchema.parse(atomicWriteConfigResource);

export interface BuildAtomicWriteCardsInput {
	records: readonly AtomicKeyedRecord[];
	idempotencyKeys: readonly string[];
	sourceTurnOffset: number;
	sessionTimestampMs: number;
	timezone: string;
	locale?: Locale;
}

function sourceTurnIndex(record: AtomicKeyedRecord): number {
	const turnIndex = record.sourceSpan?.turnIndex ?? record.unresolvedSourceSpan?.turnIndex;
	if (turnIndex === undefined) {
		throw new Error("Atomic write projection requires a source turn index");
	}
	return turnIndex;
}

function resolvedEpochMs(
	resolvedTime: AtomicKeyedRecord["resolvedTime"],
	timezone: string,
): number | null {
	if (resolvedTime === null) return null;
	try {
		return Temporal.ZonedDateTime.from(
			{
				timeZone: timezone,
				year: resolvedTime.year,
				month: resolvedTime.month,
				day: resolvedTime.day,
				hour: resolvedTime.hour ?? 0,
				minute: resolvedTime.minute ?? 0,
			},
			{ overflow: "reject" },
		).epochMilliseconds;
	} catch {
		return null;
	}
}

function validTime(
	record: AtomicKeyedRecord,
	sessionTimestampMs: number,
	timezone: string,
): { validFrom: number | null; validUntil: number | null } {
	if (record.resolvedTimeInvalid) return { validFrom: null, validUntil: null };
	const resolved = resolvedEpochMs(record.resolvedTime, timezone);
	if (resolved !== null) {
		const timeKnown =
			record.resolvedTime?.hour !== undefined || record.resolvedTime?.minute !== undefined;
		if (record.category !== "episodic") {
			// "Today" resolved to a bare day sits at midnight, below every undated statement of the
			// same session, so a same-day revision lost its order. A day-only time on the session's
			// own day means the session moment.
			const sameDay =
				!timeKnown &&
				Temporal.Instant.fromEpochMilliseconds(resolved)
					.toZonedDateTimeISO(timezone)
					.toPlainDate()
					.equals(
						Temporal.Instant.fromEpochMilliseconds(sessionTimestampMs)
							.toZonedDateTimeISO(timezone)
							.toPlainDate(),
					);
			return { validFrom: sameDay ? sessionTimestampMs : resolved, validUntil: null };
		}
		if (timeKnown) return { validFrom: resolved, validUntil: resolved + 1 };
		const nextDay = Temporal.Instant.fromEpochMilliseconds(resolved)
			.toZonedDateTimeISO(timezone)
			.add({ days: 1 }).epochMilliseconds;
		return { validFrom: resolved, validUntil: nextDay };
	}
	if (record.category !== "episodic" && record.temporalPhrase === null) {
		return { validFrom: sessionTimestampMs, validUntil: null };
	}
	return { validFrom: null, validUntil: null };
}

/**
 * The row's own clock: when the remembered thing happened, plus the window it holds over.
 *
 * `timestamp` falls back to the session rather than to the write clock. A row the model gave no
 * resolvable time still happened during this conversation, and dating it "now" is what broke
 * recency — measured 2026-09-04, an eval replaying a June week wrote every row with September's
 * date. The write path may not decide this: it holds only the write clock.
 */
function eventTime(
	record: AtomicKeyedRecord,
	sessionTimestampMs: number,
	timezone: string,
): { timestamp: number; validFrom: number | null; validUntil: number | null } {
	const window = validTime(record, sessionTimestampMs, timezone);
	return { timestamp: window.validFrom ?? sessionTimestampMs, ...window };
}

function metadataForRecord(
	record: AtomicKeyedRecord,
	sanitizerMatches: readonly string[],
	when: { timestamp: number; validFrom: number | null; validUntil: number | null },
): Record<string, unknown> {
	return {
		// Both keys, because the metadata codec resolves a row's category from `kind` first and
		// `memory_category` second, and the path this one replaced wrote both. Omitting them made
		// every read of a row's metadata throw "missing memory category/kind" — measured
		// 2026-09-04, a whole evaluation round stored 158 sessions and then scored nothing,
		// because retrieval is one of those readers. `record.category` here is the card's own
		// category, already adjusted for a to-do, so the metadata cannot disagree with the column.
		kind: record.category,
		memory_category: record.category,
		// The write door reads both: an ended profile claim that is not a to-do closure stays live,
		// and a later positive claim on the same group is judged against it (see closeEndedCardAtCreate).
		ends_current: record.endsCurrent,
		todo: record.todo,
		// When the remembered thing happened, in the row's own metadata, because every reader of a
		// dated event reads it from here and not from the column. The recall renderer puts it in
		// front of the memory as `[YYYY-MM-DD]`, and a reader told nothing treats the row as a
		// standing fact rather than an event on a day — measured 2026-09-04, an answer listing nine
		// coffee purchases said in its own words that it was "excluding three undated coffee
		// entries", and the week's total came out $21.77 short. Episodic rows only: stamping a day
		// on a standing preference is the same mistake in the other direction.
		// A phrase the resolver could not place ("last summer") must not be dated to the session:
		// the row keeps its phrase and no date, rather than reading as an event of today.
		...(record.category === "episodic" &&
		(when.validFrom !== null || record.temporalPhrase === null)
			? {
					event_at: new Date(when.timestamp).toISOString(),
					valid_from: when.validFrom ?? when.timestamp,
					...(when.validUntil === null ? {} : { valid_until: when.validUntil }),
				}
			: {}),
		value: record.value,
		importance_label: record.importance,
		source_span: record.sourceSpan,
		...(record.category === "profile"
			? { section_name: record.attribute ?? "unkeyed.profile" }
			: {}),
		...(record.temporalPhrase === null ? {} : { temporal_phrase: record.temporalPhrase }),
		...(record.keyingNote ? { keying_note: record.keyingNote } : {}),
		...(record.baseProvenance ? { base_provenance: record.baseProvenance } : {}),
		...(sanitizerMatches.length === 0
			? {}
			: { replacement_sanitizer_matches: sanitizerMatches }),
	};
}

export function buildAtomicWriteCards(
	input: BuildAtomicWriteCardsInput,
): AtomicExtractionWriteCard[] {
	if (input.records.length !== input.idempotencyKeys.length) {
		throw new Error("Atomic write projection requires one idempotency key per record");
	}
	if (!Number.isSafeInteger(input.sessionTimestampMs) || input.sessionTimestampMs < 0) {
		throw new Error("Atomic write projection requires a non-negative session timestamp");
	}
	if (!Number.isSafeInteger(input.sourceTurnOffset) || input.sourceTurnOffset < 0) {
		throw new Error("Atomic write projection requires a non-negative source turn offset");
	}
	if (!input.timezone.trim()) throw new Error("Atomic write projection requires timezone");
	const locale = input.locale ?? DEFAULT_LOCALE;
	return input.records.map((record, index) => {
		const idempotencyKey = input.idempotencyKeys[index];
		if (!idempotencyKey?.trim()) {
			throw new Error(`Atomic write projection has no idempotency key at index ${index}`);
		}
		const sanitized = sanitizeAtomicPromptValue(record, locale);
		const sanitizedRecord = sanitized.value;
		const sanitizerMatches = [
			...new Set([
				...(record.atomicSanitizerMatches ?? []),
				...sanitized.matched,
			]),
		];
		const when = eventTime(sanitizedRecord, input.sessionTimestampMs, input.timezone);
		return {
			idempotencyKey,
			...(record.refusedAttribute === undefined
				? {}
				: { refusedAttribute: record.refusedAttribute }),
			globalTurnIndex: input.sourceTurnOffset + sourceTurnIndex(sanitizedRecord),
			endsCurrent: sanitizedRecord.endsCurrent,
			endedAt: resolvedEpochMs(sanitizedRecord.endedAt, input.timezone),
			text: sanitizedRecord.claimText,
			category: sanitizedRecord.category,
			// Parked rows only. Parking nulls subject and attribute, so without this the reason a
			// candidate was rejected is unrecoverable, and the migration refuses to move the row.
			// An active row keeps null: REM reads this column as replace evidence and matches
			// clause values as plain substrings.
			rawCandidateJson: sanitizedRecord.lane === "active" ? null : JSON.stringify({
				claimText: sanitizedRecord.claimText,
				kind: sanitizedRecord.kind,
				category: sanitizedRecord.category,
				subject: sanitizedRecord.subject,
				subjectKind: sanitizedRecord.subjectKind,
				attribute: sanitizedRecord.attribute,
				value: sanitizedRecord.value,
				singleClaim: sanitizedRecord.singleClaim,
				lane: sanitizedRecord.lane,
				dispositionReason: sanitizedRecord.dispositionReason,
				sourceSpan: sanitizedRecord.sourceSpan,
				// Present only when the span could not be resolved — the quote that failed to match,
				// without which a parked row says it was rejected but never says on what evidence.
				...(sanitizedRecord.unresolvedSourceSpan === undefined
					? {}
					: { unresolvedSourceSpan: sanitizedRecord.unresolvedSourceSpan }),
				atomicSanitizerMatches: sanitizerMatches,
			}),
			subject: sanitizedRecord.subject,
			attribute: sanitizedRecord.attribute,
			...when,
			importance: ATOMIC_MEMORY_WRITE_CONFIG.importance[sanitizedRecord.importance],
			timezone: input.timezone,
			lane: sanitizedRecord.lane,
			dispositionReason: sanitizedRecord.dispositionReason,
			metadata: metadataForRecord(sanitizedRecord, sanitizerMatches, when),
			relations: sanitizedRecord.relations,
		};
	});
}
