/** @file iso-date-time.ts
 * @purpose Validates persisted ISO date/date-time strings without JavaScript Date rollover.
 * @boundary ISO string normalization and epoch parsing only; no relative date parsing.
 */

import { z } from "zod";

const ISO_DATE_STRING_SCHEMA = z.string().date();
const ISO_DATE_TIME_STRING_SCHEMA = z.string().datetime({ offset: true, local: true });

/**
 * Accepts `2023-05-07`, `2023-05-07T12:30:00`, or `2023-05-07T12:30:00Z`.
 * Returns the trimmed input unchanged when valid; otherwise undefined.
 */
export function normalizeIsoDateTimeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	if (
		!ISO_DATE_STRING_SCHEMA.safeParse(trimmed).success &&
		!ISO_DATE_TIME_STRING_SCHEMA.safeParse(trimmed).success
	) {
		return undefined;
	}

	return trimmed;
}

/** Parses a validated ISO date/date-time string into epoch milliseconds. */
export function parseIsoDateTimeMs(value: unknown): number | undefined {
	const normalized = normalizeIsoDateTimeString(value);
	if (normalized === undefined) return undefined;
	const parsed = Date.parse(normalized);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Formats epoch milliseconds as an ISO calendar date (`YYYY-MM-DD`, UTC).
 * The result validates as an ISO date string, so it round-trips through
 * `normalizeIsoDateTimeString`. Used to give episodic memories a concrete
 * event date when only a millisecond anchor (e.g. `valid_from`) is known.
 */
export function isoDateFromMs(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}
