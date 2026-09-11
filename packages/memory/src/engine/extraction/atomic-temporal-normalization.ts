/** Applies model time decisions. No natural-language date detection. */
import type { AtomicGauntletRecord } from "./atomic-extraction-gauntlet";
import { calculateCalendarTime } from "./calendar-instruction";
import type { Locale } from "../i18n/locales";

export interface AtomicTemporalNormalizationInput {
	record: AtomicGauntletRecord;
	locale?: Locale;
	sessionDateTime?: string;
	sessionTimezone?: string;
}

export function normalizeAtomicTemporalRecord(input: AtomicTemporalNormalizationInput): AtomicGauntletRecord {
	const { record, sessionDateTime, sessionTimezone } = input;
	return {
		...record,
		resolvedTime: calculateCalendarTime(record.time, sessionDateTime, sessionTimezone),
		endedAt: record.endsCurrent ? calculateCalendarTime(record.endedTime, sessionDateTime, sessionTimezone) : null,
	};
}
