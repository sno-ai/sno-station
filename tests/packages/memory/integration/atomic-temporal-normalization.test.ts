/** @file atomic-temporal-normalization.test.ts
 * @purpose Proves locale-complete deterministic date resolution and double-resolution removal.
 * @boundary Pure temporal normalization, reply parsing, and the atomic gauntlet integration.
 */

import { describe, expect, it } from "vitest";
import {
	type AtomicExtractionRecord,
	type AtomicExtractionResolvedTime,
	parseAtomicExtractionReply,
} from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import {
	type AtomicGauntletRecord,
	runAtomicExtractionGauntlet,
} from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import {
	ATOMIC_RELATIVE_TIME_PHRASES,
	normalizeAtomicTemporalRecord,
} from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-temporal-normalization";
import { type Locale, SUPPORTED_LOCALES } from "../../../../packages/sno-station-mem/src/engine/i18n/locales";

interface LocalePhrases {
	locale: Locale;
	twoDaysAgo: string;
	lastNight: string;
	lastMonth: string;
	tenYearsAgo: string;
	nextMonday: string;
	unknown: string;
}

const LOCALE_PHRASES: readonly LocalePhrases[] = [
	{
		locale: "en",
		twoDaysAgo: "two days ago",
		lastNight: "last night",
		lastMonth: "last month",
		tenYearsAgo: "10 years ago",
		nextMonday: "next Monday",
		unknown: "during the blue moon",
	},
	{
		locale: "de",
		twoDaysAgo: "vor zwei Tagen",
		lastNight: "letzte Nacht",
		lastMonth: "letzten Monat",
		tenYearsAgo: "vor zehn Jahren",
		nextMonday: "nächsten Montag",
		unknown: "während des blauen Mondes",
	},
	{
		locale: "es",
		twoDaysAgo: "hace dos días",
		lastNight: "anoche",
		lastMonth: "el mes pasado",
		tenYearsAgo: "hace diez años",
		nextMonday: "el próximo lunes",
		unknown: "durante la luna azul",
	},
	{
		locale: "fr",
		twoDaysAgo: "il y a deux jours",
		lastNight: "la nuit dernière",
		lastMonth: "le mois dernier",
		tenYearsAgo: "il y a dix ans",
		nextMonday: "lundi prochain",
		unknown: "pendant la lune bleue",
	},
	{
		locale: "zh",
		twoDaysAgo: "两天前",
		lastNight: "昨晚",
		lastMonth: "上个月",
		tenYearsAgo: "十年前",
		nextMonday: "下周一",
		unknown: "蓝月期间",
	},
	{
		locale: "zh-Hant",
		twoDaysAgo: "兩天前",
		lastNight: "昨晚",
		lastMonth: "上個月",
		tenYearsAgo: "十年前",
		nextMonday: "下週一",
		unknown: "藍月期間",
	},
	{
		locale: "ja",
		twoDaysAgo: "二日前",
		lastNight: "昨夜",
		lastMonth: "先月",
		tenYearsAgo: "十年前",
		nextMonday: "来週の月曜日",
		unknown: "青い月の間",
	},
	{
		locale: "ko",
		twoDaysAgo: "이틀 전",
		lastNight: "어젯밤",
		lastMonth: "지난달",
		tenYearsAgo: "10년 전",
		nextMonday: "다음 월요일",
		unknown: "푸른 달 동안",
	},
	{
		locale: "ru",
		twoDaysAgo: "два дня назад",
		lastNight: "прошлой ночью",
		lastMonth: "в прошлом месяце",
		tenYearsAgo: "десять лет назад",
		nextMonday: "в следующий понедельник",
		unknown: "во время голубой луны",
	},
];

const WRONG_MODEL_DATE: AtomicExtractionResolvedTime = { year: 1999, month: 1, day: 2 };

function extractionRecord(
	temporalPhrase: string | null,
	resolvedTime: AtomicExtractionResolvedTime | null,
): AtomicExtractionRecord {
	const claimText = temporalPhrase
		? `The event happened ${temporalPhrase}.`
		: "The event happened on a recorded date.";
	return {
		kind: "occurrence",
		category: "episodic",
		claimText,
		subject: "user",
		subjectKind: "user",
		attribute: null,
		value: "event",
		temporalPhrase,
		resolvedTime,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote: claimText },
		relations: [],
		singleClaim: true,
	};
}

function gauntletRecord(
	temporalPhrase: string | null,
	resolvedTime: AtomicExtractionResolvedTime | null,
): AtomicGauntletRecord {
	const record = extractionRecord(temporalPhrase, resolvedTime);
	return {
		...record,
		relations: [],
		sourceSpan: {
			...record.sourceSpan,
			startOffset: 0,
			endOffset: record.sourceSpan.quote.length,
		},
		lane: "active",
		dispositionReason: null,
		resplit: false,
	};
}

function normalizeDate(
	phrase: string,
	sessionDate: string,
	locale: Locale = "en",
): AtomicGauntletRecord {
	return normalizeAtomicTemporalRecord({
		record: gauntletRecord(phrase, null),
		locale,
		sessionDateTime: `${sessionDate}T12:00:00Z`,
		sessionTimezone: "UTC",
	});
}

function wireRecord(resolvedTime: unknown): Record<string, unknown> {
	return {
		kind: "occurrence",
		claim_text: "The event happened yesterday.",
		subject: "user",
		subject_kind: "user",
		attribute: null,
		value: "event",
		temporal_phrase: "yesterday",
		resolved_time: resolvedTime,
		importance: "medium",
		changes_current_state: false,
		ends_current: false,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: 0, quote: "The event happened yesterday." },
		relations: [],
		single_claim: true,
	};
}

describe("the moment of the conversation", () => {
	// "I just spent $4 on coffee" carries no other time. Left unresolved the row was undated and
	// dropped out of every "this week" total — measured 2026-09-06 on a Memora run, eight expense
	// rows of one persona and a coffee total $29 short.
	it.each(["just", "just now", "a moment ago", "earlier today"])(
		"resolves %j to the session day",
		(phrase) => {
			const output = normalizeAtomicTemporalRecord({
				record: gauntletRecord(phrase, null),
				locale: "en",
				sessionDateTime: "2024-07-17T12:00:00Z",
				sessionTimezone: "UTC",
			});
			expect(output.resolvedTime).toEqual({ year: 2024, month: 7, day: 17 });
			expect(output.temporalPhrase).toBeNull();
		},
	);
});

describe.each(LOCALE_PHRASES)("$locale relative-time table", (phrases) => {
	const knownCases: ReadonlyArray<{
		name: string;
		phrase: string;
		expected: AtomicExtractionResolvedTime;
	}> = [
		{ name: "two days ago", phrase: phrases.twoDaysAgo, expected: { year: 2024, month: 7, day: 15 } },
		{ name: "last night", phrase: phrases.lastNight, expected: { year: 2024, month: 7, day: 16 } },
		{ name: "last month", phrase: phrases.lastMonth, expected: { year: 2024, month: 6, day: 17 } },
		{ name: "10 years ago", phrase: phrases.tenYearsAgo, expected: { year: 2014, month: 7, day: 17 } },
		{ name: "next Monday", phrase: phrases.nextMonday, expected: { year: 2024, month: 7, day: 22 } },
	];

	it.each(knownCases)("overrides the model and rewrites $name", ({ phrase, expected }) => {
		const input = gauntletRecord(phrase, WRONG_MODEL_DATE);
		const output = normalizeAtomicTemporalRecord({
			record: input,
			locale: phrases.locale,
			sessionDateTime: "2024-07-17T12:00:00Z",
			sessionTimezone: "UTC",
		});

		expect(output.resolvedTime).toEqual(expected);
		expect(output.temporalPhrase).toBeNull();
		expect(output.claimText).not.toContain(phrase);
		expect(output.claimText).toContain(
			`${expected.year}-${String(expected.month).padStart(2, "0")}-${String(expected.day).padStart(2, "0")}`,
		);
			expect(output).not.toHaveProperty("temporalOverride");
	});

	it("keeps an unknown phrase with an empty date", () => {
		const input = gauntletRecord(phrases.unknown, null);
		const output = normalizeAtomicTemporalRecord({
			record: input,
			locale: phrases.locale,
			sessionDateTime: "2024-07-17T12:00:00Z",
			sessionTimezone: "UTC",
		});

		expect(output.resolvedTime).toBeNull();
		expect(output.temporalPhrase).toBe(phrases.unknown);
		expect(output.claimText).toBe(input.claimText);
		expect(output).not.toHaveProperty("temporalOverride");
	});

	it.each([
		["2023-03-31", { year: 2023, month: 2, day: 28 }],
		["2024-03-31", { year: 2024, month: 2, day: 29 }],
	] as const)("constrains last month from %s", (sessionDate, expected) => {
		expect(normalizeDate(phrases.lastMonth, sessionDate, phrases.locale).resolvedTime).toEqual(
			expected,
		);
	});
});

describe("fixed calendar boundaries", () => {
	it.each([
		["2023-01-31", "next month", { year: 2023, month: 2, day: 28 }],
		["2024-01-31", "next month", { year: 2024, month: 2, day: 29 }],
		["2023-03-31", "last month", { year: 2023, month: 2, day: 28 }],
		["2024-03-31", "last month", { year: 2024, month: 2, day: 29 }],
		["2024-02-29", "10 years ago", { year: 2014, month: 2, day: 28 }],
	] as const)("resolves %s plus %s without rolling over", (sessionDate, phrase, expected) => {
		expect(normalizeDate(phrase, sessionDate).resolvedTime).toEqual(expected);
	});

	it.each([
		["2024-07-15", { year: 2024, month: 7, day: 22 }],
		["2024-07-16", { year: 2024, month: 7, day: 22 }],
		["2024-07-17", { year: 2024, month: 7, day: 22 }],
		["2024-07-18", { year: 2024, month: 7, day: 22 }],
		["2024-07-19", { year: 2024, month: 7, day: 22 }],
		["2024-07-20", { year: 2024, month: 7, day: 22 }],
		["2024-07-21", { year: 2024, month: 7, day: 22 }],
	] as const)("resolves next Monday strictly after %s", (sessionDate, expected) => {
		expect(normalizeDate("next Monday", sessionDate).resolvedTime).toEqual(expected);
	});
});

describe("invalid model dates", () => {
	it.each([
		{ year: 2023, month: 13, day: 1 },
		{ year: 2023, month: 2, day: 31 },
	] as const)("clears $year-$month-$day directly and through the gauntlet", async (invalidDate) => {
		const direct = normalizeAtomicTemporalRecord({
			record: gauntletRecord(null, invalidDate),
			sessionDateTime: "2024-07-17T12:00:00Z",
			sessionTimezone: "UTC",
		});
		expect(direct.resolvedTime).toBeNull();

		const input = extractionRecord(null, invalidDate);
		const output = await runAtomicExtractionGauntlet({
			records: [input],
			turns: [{ role: "user", content: input.claimText }],
			sessionDateTime: "2024-07-17T12:00:00Z",
			sessionTimezone: "UTC",
		});
		expect(output).toHaveLength(1);
		expect(output[0]?.resolvedTime).toBeNull();
	});

	it("ignores a date the model computed: the reply is kept and the phrase is what counts", () => {
		const parsed = parseAtomicExtractionReply(
			JSON.stringify({ records: [wireRecord("2024-07-16")] }),
			1,
		);
		expect(parsed).toMatchObject({ ok: true, records: [{ resolvedTime: null }] });
	});
});

it("commits one relative-time table for every supported locale", () => {
	const supported = [...SUPPORTED_LOCALES].sort();
	expect(LOCALE_PHRASES.map(({ locale }) => locale).sort()).toEqual(supported);
	expect(Object.keys(ATOMIC_RELATIVE_TIME_PHRASES).sort()).toEqual(supported);
});
