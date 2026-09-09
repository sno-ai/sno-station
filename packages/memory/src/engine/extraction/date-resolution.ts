import { Temporal } from "@js-temporal/polyfill";
import * as chrono from "chrono-node";
import type { Component, ParsedResult, ParsingReference } from "chrono-node";
import { z } from "zod";
import type { TemporalInterval } from "./memory-temporality-classifier";
import { DEFAULT_LOCALE, type Locale } from "../i18n/locales";
import { RESOURCES_BY_LOCALE } from "../i18n/all-resources";
import type { TemporalIntervalAnchor } from "../i18n/res/_types";
import type { LlmClient } from "../../model/llm-client";
import { readModelReplyJson } from "../shared/model-reply-text";
import type { LlmRoutingConfig } from "../../contract/config/plugin-config-mode-schema";
import { createLogger } from "@snoai/utils/logger";

const log = createLogger("mem-claw:date-resolution");

type KnownValues = Partial<Record<Component, number>>;
type ChronoParser = { parse(text: string, reference?: ParsingReference): ParsedResult[] };

const PARSERS = [
	["en", chrono.en],
	["de", chrono.de],
	["es", chrono.es],
	["fr", chrono.fr],
	["ja", chrono.ja],
	["ru", chrono.ru],
	["zh", chrono.zh.hans],
	["zh-Hant", chrono.zh.hant],
] as const satisfies ReadonlyArray<readonly [Exclude<Locale, "ko">, ChronoParser]>;

export const DATE_RESOLUTION_PARSER_BY_LOCALE: Readonly<Record<Locale, string | null>> = {
	en: "en",
	de: "de",
	es: "es",
	fr: "fr",
	ja: "ja",
	ko: null,
	ru: "ru",
	zh: "zh",
	"zh-Hant": "zh-Hant",
};

export interface DateResolutionStage {
	selectedParser: string | null;
	selectionReason: "winner" | "tie-agreed" | "locale-tiebreak" | "no-result" | "tie-disagreed" | "korean-anchor";
	winningScore: number;
	runnerUpScore: number;
	ambiguityGateFired: boolean;
	modelCalled: boolean;
	timezone: string;
	reason: string | null;
}

export interface DateResolutionResult {
	interval: TemporalInterval;
	timestamp?: number;
	timezone: string;
	stage: DateResolutionStage;
}

interface ParseCandidate {
	parser: string;
	/** The components the phrase itself stated. */
	knownValues: KnownValues;
	/** Every component, stated or implied from the reference — the date the parser actually read. */
	values: KnownValues;
	score: number;
}

interface SessionAnchor {
	instant: Date;
	offsetMinutes: number;
	plain: Temporal.PlainDateTime;
	weekday: number;
	timestamp: number;
	timezone: string;
}

function knownValues(result: ParsedResult): KnownValues {
	const start = result.start as ParsedResult["start"] & {
		getCertainComponents(): Component[];
	};
	const values: KnownValues = {};
	for (const component of start.getCertainComponents()) {
		const value = start.get(component);
		if (value !== null) values[component] = value;
	}
	return values;
}

const ALL_COMPONENTS: Component[] = [
	"year",
	"month",
	"day",
	"hour",
	"minute",
	"second",
	"millisecond",
	"meridiem",
	"timezoneOffset",
];

function allValues(result: ParsedResult): KnownValues {
	const values: KnownValues = {};
	for (const component of ALL_COMPONENTS) {
		const value = result.start.get(component);
		if (value !== null && value !== undefined) values[component] = value;
	}
	return values;
}

function sameKnownValues(left: KnownValues, right: KnownValues): boolean {
	const leftEntries = Object.entries(left).toSorted(([a], [b]) => a.localeCompare(b));
	const rightEntries = Object.entries(right).toSorted(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

/**
 * The zone a session time string carries itself: a bracketed IANA zone, else its UTC offset.
 * Used when no zone is given; the host's zone shifted "2026-06-16T00:30+02:00" to the 15th on a
 * UTC server.
 */
export function sessionZoneCarriedBy(sessionDateTime: string | undefined): string | undefined {
	if (sessionDateTime === undefined) return undefined;
	const bracketed = /\[([^\]]+)\]$/u.exec(sessionDateTime)?.[1];
	if (bracketed !== undefined) return bracketed;
	const offset = /(Z|[+-]\d{2}:?\d{2})$/u.exec(sessionDateTime)?.[1];
	if (offset === undefined) return undefined;
	return offset === "Z" ? "UTC" : offset;
}

function sessionAnchor(
	sessionDateTime?: string,
	sessionTimezone?: string,
	sessionTimestamp?: number,
): SessionAnchor | undefined {
	if (!sessionDateTime && sessionTimestamp === undefined) return undefined;
	try {
		const timezone =
			sessionTimezone ??
			sessionZoneCarriedBy(sessionDateTime) ??
			Intl.DateTimeFormat().resolvedOptions().timeZone;
		const zoned = sessionTimestamp === undefined
			? Temporal.ZonedDateTime.from(
					sessionDateTime?.includes("[")
						? sessionDateTime
						: `${sessionDateTime}[${timezone}]`,
					{ offset: "use" },
				)
			: Temporal.Instant.fromEpochMilliseconds(sessionTimestamp).toZonedDateTimeISO(timezone);
		return {
			instant: new Date(zoned.epochMilliseconds),
			offsetMinutes: zoned.offsetNanoseconds / 60_000_000_000,
			plain: zoned.toPlainDateTime(),
			weekday: zoned.dayOfWeek,
			timestamp: zoned.epochMilliseconds,
			timezone,
		};
	} catch {
		return undefined;
	}
}

function parseCandidates(text: string, anchor: SessionAnchor | undefined): ParseCandidate[] {
	const reference: ParsingReference | undefined = anchor
		? { instant: anchor.instant, timezone: anchor.offsetMinutes }
		: undefined;
	const candidates: ParseCandidate[] = [];
	for (const [parser, implementation] of PARSERS) {
		for (const result of implementation.parse(text, reference)) {
			if (!anchor && [...result.tags()].some((tag) => tag.startsWith("result/relative"))) continue;
			const values = knownValues(result);
			candidates.push({
				parser,
				knownValues: values,
				values: allValues(result),
				score: Object.keys(values).length,
			});
		}
	}
	return candidates;
}

function selectCandidate(candidates: ParseCandidate[], locale: Locale, localFirst: boolean): {
	candidate?: ParseCandidate;
	top: ParseCandidate[];
	reason: DateResolutionStage["selectionReason"];
	winningScore: number;
	runnerUpScore: number;
} {
	if (candidates.length === 0) {
		return { top: [], reason: "no-result", winningScore: 0, runnerUpScore: 0 };
	}
	const scores = [...new Set(candidates.map((candidate) => candidate.score))].toSorted((a, b) => b - a);
	const winningScore = scores[0] ?? 0;
	const runnerUpScore = scores[1] ?? 0;
	const top = candidates.filter((candidate) => candidate.score === winningScore);
	if (top.length === 1) {
		return { candidate: top[0], top, reason: "winner", winningScore, runnerUpScore };
	}
	const first = top[0];
	if (first && top.every((candidate) => sameKnownValues(candidate.knownValues, first.knownValues))) {
		return { candidate: first, top, reason: "tie-agreed", winningScore, runnerUpScore };
	}
	const localeParser = DATE_RESOLUTION_PARSER_BY_LOCALE[locale];
	const localeCandidate = localFirst
		? top.find((candidate) => candidate.parser === localeParser)
		: undefined;
	return {
		...(localeCandidate ? { candidate: localeCandidate } : {}),
		top,
		reason: localeCandidate ? "locale-tiebreak" : "tie-disagreed",
		winningScore,
		runnerUpScore,
	};
}

function fixedOffset(offsetMinutes: number): string {
	const sign = offsetMinutes < 0 ? "-" : "+";
	const absolute = Math.abs(offsetMinutes);
	const hours = Math.trunc(absolute / 60);
	const minutes = absolute % 60;
	return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function plainDateTime(values: KnownValues): Temporal.PlainDateTime | undefined {
	const { year, month, day } = values;
	if (year === undefined || month === undefined || day === undefined) return undefined;
	try {
		return Temporal.PlainDateTime.from({
			year,
			month,
			day,
			hour: values.hour ?? 0,
			minute: values.minute ?? 0,
			second: values.second ?? 0,
			millisecond: values.millisecond ?? 0,
		});
	} catch {
		return undefined;
	}
}

function resultFromPlain(
	plain: Temporal.PlainDateTime,
	phrase: string,
	timeKnown: boolean,
	timezone: string,
	stage: DateResolutionStage,
): DateResolutionResult {
	const carrierZone = timezone === "user" ? "UTC" : timezone;
	const timestamp = plain.toZonedDateTime(carrierZone).epochMilliseconds;
	if (timeKnown) {
		return {
			interval: { type: "instant", resolutionStatus: "resolved", at: timestamp, phrase },
			timestamp,
			timezone,
			stage: { ...stage, timezone },
		};
	}
	const start = plain.with({ hour: 0, minute: 0, second: 0, millisecond: 0 });
	const from = start.toZonedDateTime(carrierZone).epochMilliseconds;
	const until = start.add({ days: 1 }).toZonedDateTime(carrierZone).epochMilliseconds;
	return {
		interval: { type: "bounded", resolutionStatus: "resolved", from, until, phrase },
		timestamp: from,
		timezone,
		stage: { ...stage, timezone },
	};
}

function resolveCandidate(
	candidate: ParseCandidate,
	phrase: string,
	stage: DateResolutionStage,
): { result?: DateResolutionResult; partial?: DateResolutionResult } {
	const plain = plainDateTime(candidate.knownValues);
	if (!plain) return {};
	const ambiguousHour =
		candidate.knownValues.hour !== undefined &&
		candidate.knownValues.hour >= 1 &&
		candidate.knownValues.hour <= 12 &&
		candidate.knownValues.meridiem === undefined;
	const timezone =
		candidate.knownValues.timezoneOffset === undefined
			? "user"
			: fixedOffset(candidate.knownValues.timezoneOffset);
	const timeKnown = candidate.knownValues.hour !== undefined && !ambiguousHour;
	const result = resultFromPlain(plain, phrase, timeKnown, timezone, {
		...stage,
		ambiguityGateFired: ambiguousHour,
	});
	return ambiguousHour ? { partial: result } : { result };
}

/** True when the text states a clock time in Korean, which the day-anchor table cannot express. */
function koreanTextStatesClockTime(text: string): boolean {
	const pattern = RESOURCES_BY_LOCALE.ko.captureTriggers.temporalClockTimePattern;
	if (!pattern) return false;
	const matched = pattern.test(text);
	pattern.lastIndex = 0;
	return matched;
}

function findKoreanPhrase(text: string): { phrase: string; anchor: TemporalIntervalAnchor } | undefined {
	let best: { phrase: string; anchor: TemporalIntervalAnchor } | undefined;
	for (const rule of RESOURCES_BY_LOCALE.ko.captureTriggers.temporalPhrases ?? []) {
		for (const pattern of rule.patterns) {
			const match = pattern.exec(text);
			pattern.lastIndex = 0;
			const phrase = match?.[0];
			if (phrase && (!best || phrase.length > best.phrase.length)) {
				best = { phrase, anchor: rule.anchor };
			}
		}
	}
	return best;
}

function koreanInterval(
	match: { phrase: string; anchor: TemporalIntervalAnchor },
	anchor: SessionAnchor,
	stage: DateResolutionStage,
): DateResolutionResult {
	const dayStart = anchor.plain.with({ hour: 0, minute: 0, second: 0, millisecond: 0 });
	const weekStart = dayStart.subtract({ days: anchor.weekday - 1 });
	const monthStart = dayStart.with({ day: 1 });
	const bounded = (from: Temporal.PlainDateTime, until: Temporal.PlainDateTime) => {
		const start = from.toZonedDateTime("UTC").epochMilliseconds;
		return {
			interval: {
				type: "bounded" as const,
				resolutionStatus: "resolved" as const,
				from: start,
				until: until.toZonedDateTime("UTC").epochMilliseconds,
				phrase: match.phrase,
			},
			timestamp: start,
			timezone: "user",
			stage: { ...stage, selectedParser: "ko-table", selectionReason: "korean-anchor" as const, timezone: "user" },
		};
	};
	switch (match.anchor) {
		case "today": return bounded(dayStart, dayStart.add({ days: 1 }));
		case "yesterday": return bounded(dayStart.subtract({ days: 1 }), dayStart);
		case "tomorrow": return bounded(dayStart.add({ days: 1 }), dayStart.add({ days: 2 }));
		case "day_after_tomorrow": return bounded(dayStart.add({ days: 2 }), dayStart.add({ days: 3 }));
		case "this_week": return bounded(weekStart, weekStart.add({ weeks: 1 }));
		case "next_week": return bounded(weekStart.add({ weeks: 1 }), weekStart.add({ weeks: 2 }));
		case "last_week": return bounded(weekStart.subtract({ weeks: 1 }), weekStart);
		case "this_month": return bounded(monthStart, monthStart.add({ months: 1 }));
		case "next_month": return bounded(monthStart.add({ months: 1 }), monthStart.add({ months: 2 }));
		case "tonight": return bounded(dayStart.with({ hour: 18 }), dayStart.add({ days: 1 }));
		case "this_morning": return bounded(dayStart, dayStart.with({ hour: 12 }));
		case "recent": {
			const from = anchor.plain.subtract({ days: 14 }).toZonedDateTime("UTC").epochMilliseconds;
			return {
				interval: { type: "ongoing", resolutionStatus: "resolved", from, until: anchor.timestamp, phrase: match.phrase },
				timestamp: from,
				timezone: "user",
				stage: { ...stage, selectedParser: "ko-table", selectionReason: "korean-anchor", timezone: "user" },
			};
		}
	}
}

function baseResult(
	type: "static" | "unresolved",
	phrase: string,
	anchor: SessionAnchor | undefined,
	stage: DateResolutionStage,
): DateResolutionResult {
	return {
		interval: type === "static"
			? { type: "static", resolutionStatus: "static" }
			: { type: "unresolved", resolutionStatus: "unresolved", phrase },
		...(anchor ? { timestamp: anchor.timestamp } : {}),
		timezone: anchor?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		stage,
	};
}

export function resolveDateLocally(input: {
	text: string;
	expression?: string;
	sessionDateTime?: string;
	sessionTimestamp?: number;
	sessionTimezone?: string;
	locale?: Locale;
	localFirst?: boolean;
}): { result: DateResolutionResult; needsModel: boolean; parserReadings: ParseCandidate[]; partial?: DateResolutionResult } {
	const locale = input.locale ?? DEFAULT_LOCALE;
	const phrase = input.expression?.trim() || input.text;
	const anchor = sessionAnchor(input.sessionDateTime, input.sessionTimezone, input.sessionTimestamp);
	const candidates = parseCandidates(phrase, anchor);
	const selection = selectCandidate(candidates, locale, input.localFirst === true);
	const stage: DateResolutionStage = {
		selectedParser: selection.candidate?.parser ?? null,
		selectionReason: selection.reason,
		winningScore: selection.winningScore,
		runnerUpScore: selection.runnerUpScore,
		ambiguityGateFired: false,
		modelCalled: false,
		timezone: anchor?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		reason: null,
	};
	if (selection.candidate) {
		const resolved = resolveCandidate(selection.candidate, phrase, stage);
		if (resolved.result) return { result: resolved.result, needsModel: false, parserReadings: candidates };
		if (resolved.partial) {
			return { result: resolved.partial, partial: resolved.partial, needsModel: !input.localFirst, parserReadings: candidates };
		}
	}
	if (selection.reason === "no-result" && anchor) {
		const korean = findKoreanPhrase(phrase);
		if (korean) {
			const day = koreanInterval(korean, anchor, stage);
			// The Korean table knows day-sized anchors and nothing smaller. When the sentence also
			// states a clock time, the day it produces is true but coarse, so it goes down the same
			// partial path an ambiguous hour already takes: the caller keeps a correct day AND is
			// told a model still has work to do. Returning it as a resolved answer — which this
			// branch used to do — meant "yesterday at 3pm" was stored as the whole of yesterday and
			// the model that would have read the hour was never called, in any mode.
			//
			// Partial when a model may still run: `resolveMemoryDate` falls back to `local.partial`
			// if the model cannot resolve, so the coarse day survives instead of being discarded.
			//
			// Under local-first no model will ever run, and the public result carries no status
			// between "resolved" and "unresolved" — a partial day would reach the caller indexed
			// as a resolved whole day, which is the original defect wearing a different name. So
			// local-first says unresolved, and that costs nothing the memory needs: every caller
			// stores the row either way and only omits the timestamp
			// (`memory-store-tool.ts` passes it only when defined; the merge handler falls back to
			// the session time). A wrong day anchor is worse than no anchor — it answers
			// time-filtered recall with a confident lie.
			if (koreanTextStatesClockTime(phrase)) {
				if (input.localFirst === true) {
					return {
						result: baseResult("unresolved", phrase, anchor, {
							...day.stage,
							reason: "local-first-unreadable",
						}),
						needsModel: false,
						parserReadings: candidates,
					};
				}
				return { result: day, partial: day, needsModel: true, parserReadings: candidates };
			}
			return { result: day, needsModel: false, parserReadings: candidates };
		}
	}
	const temporalWasNamed = Boolean(input.expression?.trim());
	const localFirstUnreadable = input.localFirst === true && selection.reason === "no-result";
	const type = selection.reason === "no-result" && !temporalWasNamed ? "static" : "unresolved";
	const result = baseResult(type, phrase, anchor, {
		...stage,
		reason: localFirstUnreadable ? "local-first-unreadable" : stage.reason,
	});
	return {
		result,
		needsModel: !input.localFirst && type === "unresolved",
		parserReadings: candidates,
	};
}

const modelReply = z
	.object({
		resolved: z.boolean(),
		year: z.number().int().nullable(),
		month: z.number().int().nullable(),
		day: z.number().int().nullable(),
		hour: z.number().int().nullable(),
		minute: z.number().int().nullable(),
		timezone: z.string().nullable(),
		reason: z.string(),
	})
	.strict()
	.superRefine((value, context) => {
		const dateFields = [value.year, value.month, value.day, value.hour, value.minute, value.timezone];
		if (!value.resolved) {
			if (dateFields.some((field) => field !== null)) context.addIssue({ code: "custom", message: "unresolved reply carries date fields" });
			return;
		}
		if (value.year === null || value.month === null || value.day === null) {
			context.addIssue({ code: "custom", message: "resolved reply is missing a calendar date" });
			return;
		}
		try {
			Temporal.PlainDate.from(
				{ year: value.year, month: value.month, day: value.day },
				{ overflow: "reject" },
			);
		} catch {
			context.addIssue({ code: "custom", message: "resolved reply has an invalid calendar date" });
		}
		if (value.hour !== null && (value.hour < 0 || value.hour > 23)) context.addIssue({ code: "custom", message: "hour is outside 0..23" });
		if (value.minute !== null && (value.minute < 0 || value.minute > 59)) context.addIssue({ code: "custom", message: "minute is outside 0..59" });
		if (value.timezone !== null) {
			try {
				const normalized = Temporal.PlainDateTime.from("2000-01-01T00:00").toZonedDateTime(value.timezone).offset;
				if (normalized !== value.timezone) throw new Error("not canonical");
			} catch {
				context.addIssue({ code: "custom", message: "timezone must be a fixed offset" });
			}
		}
	});

function modelResult(value: z.infer<typeof modelReply>, phrase: string, stage: DateResolutionStage): DateResolutionResult | undefined {
	if (!value.resolved || value.year === null || value.month === null || value.day === null) return undefined;
	const plain = Temporal.PlainDateTime.from({
		year: value.year,
		month: value.month,
		day: value.day,
		hour: value.hour ?? 0,
		minute: value.minute ?? 0,
	});
	return resultFromPlain(plain, phrase, value.hour !== null, value.timezone ?? "user", {
		...stage,
		modelCalled: true,
		reason: value.reason,
	});
}

function dateDiagnosticFields(stage: DateResolutionStage): Record<string, unknown> {
	return {
		parser: stage.selectedParser ?? "unavailable",
		reason_code: stage.selectionReason,
		winning_score: stage.winningScore,
		runner_up_score: stage.runnerUpScore,
		ambiguity_gate_fired: stage.ambiguityGateFired,
		model_called: stage.modelCalled,
		timezone: stage.timezone,
		local_reason: stage.modelCalled ? "unavailable" : stage.reason ?? "unavailable",
		model_reason_length: stage.modelCalled ? stage.reason?.length ?? 0 : 0,
	};
}

export async function resolveMemoryDate(input: {
	text: string;
	expression?: string;
	sessionDateTime?: string;
	sessionTimestamp?: number;
	sessionTimezone?: string;
	locale?: Locale;
	llm?: LlmClient;
	routing?: LlmRoutingConfig;
}): Promise<DateResolutionResult> {
	const locale = input.locale ?? input.routing?.language ?? DEFAULT_LOCALE;
	const local = resolveDateLocally({
		text: input.text,
		expression: input.expression,
		sessionDateTime: input.sessionDateTime,
		sessionTimestamp: input.sessionTimestamp,
		sessionTimezone: input.sessionTimezone,
		locale,
		localFirst: input.routing?.mode === "local-first",
	});
	if (!local.needsModel || !input.llm || input.routing?.mode === "local-first") {
		log.info("Memory date resolution completed", dateDiagnosticFields(local.result.stage), {
			event_name: "mem_claw.date-resolution.date.resolution.stage",
			file: "apps/mem-claw/src/extraction/date-resolution.ts",
			function: "resolveMemoryDate",
			site_id: "date-resolution.resolveMemoryDate.1224fa35b2",
		});
		return local.result;
	}
	const anchor = sessionAnchor(input.sessionDateTime, input.sessionTimezone, input.sessionTimestamp);
	const expression = input.expression?.trim() || input.text;
	const prompt = `${RESOURCES_BY_LOCALE[locale].extractionPrompts.buildDateResolutionPrompt()}\n${JSON.stringify({
		anchor: anchor ? `${anchor.plain.toString()}${fixedOffset(anchor.offsetMinutes)}` : null,
		weekday: anchor?.weekday ?? null,
		sentence: input.text,
		expression,
		parserReadings: local.parserReadings.map((candidate) => ({ parser: candidate.parser, values: candidate.knownValues })),
	})}`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const raw = await input.llm.completeText({
				adapterSlot: "date-resolution",
				callLabel: "date-resolution",
				prompt,
				enableThinking: true,
			});
			// Walk every candidate against this reply's own shape. Taking the first syntactically
			// valid slice discarded the turn whenever the model put an example or its reasoning
			// ahead of the payload.
			const data = raw
				? readModelReplyJson(raw, (value) => {
						const candidate = modelReply.safeParse(value);
						return candidate.success ? candidate.data : undefined;
					})
				: undefined;
			if (raw && data === undefined) break;
			if (!data) continue;
			const parsed = { data } as const;
			if (!parsed.data.resolved) {
				const unresolved = {
					...(local.partial ?? local.result),
					stage: {
						...(local.partial?.stage ?? local.result.stage),
						modelCalled: true,
						reason: parsed.data.reason,
					},
				};
				log.info("Memory date resolution completed", dateDiagnosticFields(unresolved.stage), {
					event_name: "mem_claw.date-resolution.date.resolution.stage",
					file: "apps/mem-claw/src/extraction/date-resolution.ts",
					function: "resolveMemoryDate",
					site_id: "date-resolution.resolveMemoryDate.f9d5985547",
				});
				return unresolved;
			}
			const resolved = modelResult(parsed.data, expression, local.result.stage);
			if (resolved) {
				log.info("Memory date resolution completed", dateDiagnosticFields(resolved.stage), {
					event_name: "mem_claw.date-resolution.date.resolution.stage",
					file: "apps/mem-claw/src/extraction/date-resolution.ts",
					function: "resolveMemoryDate",
					site_id: "date-resolution.resolveMemoryDate.c2334f61f6",
				});
				return resolved;
			}
		} catch {
			// The second iteration is the only retry. The unresolved result below is durable.
		}
	}
	const unresolved = {
		...(local.partial ?? local.result),
		stage: {
			...(local.partial?.stage ?? local.result.stage),
			modelCalled: true,
			reason: "model-unresolved",
		},
	};
	log.info("Memory date resolution completed", dateDiagnosticFields(unresolved.stage), {
		event_name: "mem_claw.date-resolution.date.resolution.stage",
		file: "apps/mem-claw/src/extraction/date-resolution.ts",
		function: "resolveMemoryDate",
		site_id: "date-resolution.resolveMemoryDate.5e94847eb6",
	});
	return unresolved;
}
