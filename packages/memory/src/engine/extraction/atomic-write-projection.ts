/** @file atomic-write-projection.ts
 * @purpose Projects guarded atomic records into the mechanical storage-door contract.
 * @boundary Deterministic axes and metadata only; no model calls, suppression, or persistence.
 */

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

/** An unresolved record keeps its session timestamp without claiming an event date. */
function eventTime(
	record: AtomicKeyedRecord,
	sessionTimestampMs: number,
): { timestamp: number; validFrom: number | null; validUntil: number | null } {
	const resolved = record.resolvedTime;
	const sameSessionDay = record.category !== "episodic" && resolved?.precision === "day"
		&& resolved.from <= sessionTimestampMs && sessionTimestampMs < resolved.until;
	return {
		timestamp: sessionTimestampMs,
		validFrom: sameSessionDay ? sessionTimestampMs : resolved?.from ?? (record.kind === "standing" && record.time.kind === "none" ? sessionTimestampMs : null),
		validUntil: record.category === "episodic" ? record.resolvedTime?.until ?? null : null,
	};
}

function metadataForRecord(
	record: AtomicKeyedRecord,
	sanitizerMatches: readonly string[],
	validFrom: number | null,
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
		...(validFrom === null ? {} : { valid_from: validFrom }),
		// A year or month is a range, never a fabricated event day.
		...(record.resolvedTime ? {
			temporal_date: record.resolvedTime.label,
			temporal_precision: record.resolvedTime.precision,
			temporal_timezone: record.resolvedTime.timezone,
			...(record.category === "episodic" ? { valid_until: record.resolvedTime.until } : {}),
			...(record.category === "episodic" && ["day", "minute"].includes(record.resolvedTime.precision)
				? { event_at: new Date(record.resolvedTime.from).toISOString() } : {}),
		} : {}),
		time_instruction: record.time,
		ended_time_instruction: record.endedTime,
		...(record.endedAt ? {
			ended_at_date: record.endedAt.label,
			ended_at_precision: record.endedAt.precision,
			ended_at_from: record.endedAt.from,
			ended_at_until: record.endedAt.until,
		} : {}),
		temporal_resolution_status: record.resolvedTime ? "resolved" : record.time.kind === "none" ? "static" : "unresolved",
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
		const when = eventTime(sanitizedRecord, input.sessionTimestampMs);
		return {
			idempotencyKey,
			...(record.refusedAttribute === undefined
				? {}
				: { refusedAttribute: record.refusedAttribute }),
			globalTurnIndex: input.sourceTurnOffset + sourceTurnIndex(sanitizedRecord),
			endsCurrent: sanitizedRecord.endsCurrent,
			endedAt: sanitizedRecord.endedAt && ["day", "minute"].includes(sanitizedRecord.endedAt.precision)
				? sanitizedRecord.endedAt.from : null,
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
			metadata: metadataForRecord(sanitizedRecord, sanitizerMatches, when.validFrom),
			relations: sanitizedRecord.relations,
		};
	});
}
