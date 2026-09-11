/** @file memory-temporality-classifier.ts
 * @purpose Resolves temporal intervals through the shared date resolver.
 * @boundary Metadata writes and deterministic capture callers.
 */

import { Temporal } from "@js-temporal/polyfill";
import { unresolvedMemoryDate } from "./date-resolution";
import type { InsightMetadata } from "./memory-metadata-types";
import { DEFAULT_LOCALE, isSupportedLocale } from "../i18n/locales";
import { parseIsoDateTimeMs } from "../shared/iso-date-time";
import type { MemoryCategory } from "../shared/types";

export type TemporalType = "static" | "dynamic";
export type TemporalResolutionStatus = "resolved" | "unresolved" | "static";

export interface SessionTemporalContext {
	sessionTimestamp?: number;
	sessionTimezone?: string;
}

export type TemporalInterval =
	| { type: "static"; resolutionStatus: "static" }
	| { type: "unresolved"; resolutionStatus: "unresolved"; phrase: string }
	| { type: "instant"; resolutionStatus: "resolved"; at: number; phrase?: string }
	| {
			type: "bounded";
			resolutionStatus: "resolved";
			from: number;
			until: number;
			phrase?: string;
			date?: string;
			precision?: "year" | "month" | "week" | "day" | "minute";
			timezone?: string;
	  }
	| {
			type: "ongoing";
			resolutionStatus: "resolved";
			from: number;
			until?: number;
			phrase?: string;
	  };

export function parseSessionTimestamp(sessionDateTime?: string): number | undefined {
	return parseIsoDateTimeMs(sessionDateTime);
}

function sessionDateTime(context: SessionTemporalContext): string | undefined {
	if (context.sessionTimestamp === undefined) return undefined;
	const timezone = context.sessionTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	return Temporal.Instant.fromEpochMilliseconds(context.sessionTimestamp)
		.toZonedDateTimeISO(timezone)
		.toString({ smallestUnit: "millisecond", timeZoneName: "never" });
}

export function inferTemporalInterval(
	text: string,
	locale?: string,
	context: SessionTemporalContext = {},
): TemporalInterval {
	return unresolvedMemoryDate({
		text,
		sessionDateTime: sessionDateTime(context),
		sessionTimezone: context.sessionTimezone,
		locale: locale && isSupportedLocale(locale) ? locale : DEFAULT_LOCALE,
	}).interval;
}

export function serializeIntervalMetadata(
	category: MemoryCategory,
	interval: TemporalInterval,
): Partial<InsightMetadata> {
	if (interval.type === "static") {
		return {
			memory_temporal_type: "static",
			temporal_resolution_status: "static",
		};
	}

	const base: Partial<InsightMetadata> = {
		memory_temporal_type: "dynamic",
		temporal_resolution_status: interval.resolutionStatus,
	};
	if ("phrase" in interval && interval.phrase) base.temporal_phrase = interval.phrase;
	if (interval.type === "instant") {
		if (category === "episodic") base.event_at = interval.at;
		base.valid_from = interval.at;
	} else if (interval.type === "bounded") {
		base.valid_from = interval.from;
		if (category === "episodic") base.valid_until = interval.until;
		if (interval.date !== undefined) base.temporal_date = interval.date;
		if (interval.precision !== undefined) base.temporal_precision = interval.precision;
		if (interval.timezone !== undefined) base.temporal_timezone = interval.timezone;
	} else if (interval.type === "ongoing") {
		base.valid_from = interval.from;
		if (interval.until !== undefined) base.valid_until = interval.until;
	}
	return base;
}

export function classifyTemporal(text: string): TemporalType {
	return inferTemporalInterval(text).type === "static" ? "static" : "dynamic";
}

export function inferExpiry(text: string, now: number = Date.now()): number | undefined {
	const interval = inferTemporalInterval(text, DEFAULT_LOCALE, {
		sessionTimestamp: now,
		sessionTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	});
	return interval.type === "bounded" ? interval.until : undefined;
}
