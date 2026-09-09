/** @file atomic-temporal-normalization.ts
 * @purpose Resolves a record's time phrases into dates: the engine's calendar, never the model's.
 * @boundary Deterministic calendar work only; no model calls, storage, or locale detection.
 *
 * Two stages, both code. The committed phrase tables answer first: nine locales of "yesterday",
 * "last month", "N days ago", "next <weekday>", with month-end clamping the way the tests pin it.
 * What the tables do not know goes to the shared date parser (`date-resolution.ts`, the same one
 * the update tool uses), anchored on the session: "June 16", "this morning", "at 3pm", "on
 * Thursday". A phrase neither can place stays as words, undated — never a guessed year.
 */

import { Temporal } from "@js-temporal/polyfill";
import type { AtomicGauntletRecord } from "@/extraction/atomic-extraction-gauntlet";
import type { AtomicExtractionResolvedTime } from "@/extraction/atomic-extraction-reply";
import { resolveDateLocally } from "@/extraction/date-resolution";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";

type DateUnit = "day" | "week" | "month" | "year";

interface RelativeOffset {
	amount: number;
	unit: DateUnit;
}

interface RelativePhraseTable {
	fixed: Readonly<Record<string, RelativeOffset>>;
	agoPattern: RegExp;
	agoUnits: Readonly<Record<string, DateUnit>>;
	numbers: Readonly<Record<string, number>>;
	nextWeekdays: Readonly<Record<string, number>>;
}

const LATIN_NUMBERS = {
	"1": 1,
	"2": 2,
	"3": 3,
	"4": 4,
	"5": 5,
	"6": 6,
	"7": 7,
	"8": 8,
	"9": 9,
	"10": 10,
} as const;

export const ATOMIC_RELATIVE_TIME_PHRASES: Readonly<Record<Locale, RelativePhraseTable>> = {
	en: {
		fixed: {
			// The moment of the conversation. "I just spent $4 on coffee" carries no other time, and
			// left unresolved the row is undated and drops out of every "this week" total —
			// measured 2026-09-06 on a Memora run: eight expense rows, one coffee total $29 short.
			just: { amount: 0, unit: "day" },
			"just now": { amount: 0, unit: "day" },
			"a moment ago": { amount: 0, unit: "day" },
			"moments ago": { amount: 0, unit: "day" },
			"earlier today": { amount: 0, unit: "day" },
			yesterday: { amount: -1, unit: "day" },
			"last night": { amount: -1, unit: "day" },
			"last week": { amount: -1, unit: "week" },
			"last month": { amount: -1, unit: "month" },
			"last year": { amount: -1, unit: "year" },
			"next week": { amount: 1, unit: "week" },
			"next month": { amount: 1, unit: "month" },
		},
		agoPattern: /^(\S+)\s+(days?|weeks?|months?|years?)\s+ago$/u,
		agoUnits: { day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year" },
		numbers: { ...LATIN_NUMBERS, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 },
		nextWeekdays: { "next monday": 1, "next tuesday": 2, "next wednesday": 3, "next thursday": 4, "next friday": 5, "next saturday": 6, "next sunday": 7 },
	},
	de: {
		fixed: {
			gestern: { amount: -1, unit: "day" },
			"letzte nacht": { amount: -1, unit: "day" },
			"letzte woche": { amount: -1, unit: "week" },
			"letzten monat": { amount: -1, unit: "month" },
			"letztes jahr": { amount: -1, unit: "year" },
			"nächste woche": { amount: 1, unit: "week" },
			"nächsten monat": { amount: 1, unit: "month" },
		},
		agoPattern: /^vor\s+(\S+)\s+(tagen|wochen|monaten|jahren)$/u,
		agoUnits: { tagen: "day", wochen: "week", monaten: "month", jahren: "year" },
		numbers: { ...LATIN_NUMBERS, ein: 1, eins: 1, einem: 1, einer: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10 },
		nextWeekdays: { "nächsten montag": 1, "nächsten dienstag": 2, "nächsten mittwoch": 3, "nächsten donnerstag": 4, "nächsten freitag": 5, "nächsten samstag": 6, "nächsten sonntag": 7 },
	},
	es: {
		fixed: {
			ayer: { amount: -1, unit: "day" },
			anoche: { amount: -1, unit: "day" },
			"la semana pasada": { amount: -1, unit: "week" },
			"el mes pasado": { amount: -1, unit: "month" },
			"el año pasado": { amount: -1, unit: "year" },
			"la próxima semana": { amount: 1, unit: "week" },
			"el próximo mes": { amount: 1, unit: "month" },
		},
		agoPattern: /^hace\s+(\S+)\s+(días?|semanas?|mes(?:es)?|años?)$/u,
		agoUnits: { día: "day", días: "day", semana: "week", semanas: "week", mes: "month", meses: "month", año: "year", años: "year" },
		numbers: { ...LATIN_NUMBERS, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 },
		nextWeekdays: { "el próximo lunes": 1, "el próximo martes": 2, "el próximo miércoles": 3, "el próximo jueves": 4, "el próximo viernes": 5, "el próximo sábado": 6, "el próximo domingo": 7 },
	},
	fr: {
		fixed: {
			hier: { amount: -1, unit: "day" },
			"la nuit dernière": { amount: -1, unit: "day" },
			"la semaine dernière": { amount: -1, unit: "week" },
			"le mois dernier": { amount: -1, unit: "month" },
			"l'année dernière": { amount: -1, unit: "year" },
			"la semaine prochaine": { amount: 1, unit: "week" },
			"le mois prochain": { amount: 1, unit: "month" },
		},
		agoPattern: /^il y a\s+(\S+)\s+(jours?|semaines?|mois|ans?|années?)$/u,
		agoUnits: { jour: "day", jours: "day", semaine: "week", semaines: "week", mois: "month", an: "year", ans: "year", année: "year", années: "year" },
		numbers: { ...LATIN_NUMBERS, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 },
		nextWeekdays: { "lundi prochain": 1, "mardi prochain": 2, "mercredi prochain": 3, "jeudi prochain": 4, "vendredi prochain": 5, "samedi prochain": 6, "dimanche prochain": 7 },
	},
	zh: {
		fixed: {
			昨天: { amount: -1, unit: "day" },
			昨晚: { amount: -1, unit: "day" },
			上周: { amount: -1, unit: "week" },
			上星期: { amount: -1, unit: "week" },
			上个月: { amount: -1, unit: "month" },
			去年: { amount: -1, unit: "year" },
			下周: { amount: 1, unit: "week" },
			下星期: { amount: 1, unit: "week" },
			下个月: { amount: 1, unit: "month" },
		},
		agoPattern: /^(\S+?)(天|周|星期|个月|年)前$/u,
		agoUnits: { 天: "day", 周: "week", 星期: "week", 个月: "month", 年: "year" },
		numbers: { ...LATIN_NUMBERS, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 },
		nextWeekdays: { 下周一: 1, 下周二: 2, 下周三: 3, 下周四: 4, 下周五: 5, 下周六: 6, 下周日: 7 },
	},
	"zh-Hant": {
		fixed: {
			昨天: { amount: -1, unit: "day" },
			昨晚: { amount: -1, unit: "day" },
			上週: { amount: -1, unit: "week" },
			上星期: { amount: -1, unit: "week" },
			上個月: { amount: -1, unit: "month" },
			去年: { amount: -1, unit: "year" },
			下週: { amount: 1, unit: "week" },
			下星期: { amount: 1, unit: "week" },
			下個月: { amount: 1, unit: "month" },
		},
		agoPattern: /^(\S+?)(天|週|星期|個月|年)前$/u,
		agoUnits: { 天: "day", 週: "week", 星期: "week", 個月: "month", 年: "year" },
		numbers: { ...LATIN_NUMBERS, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 },
		nextWeekdays: { 下週一: 1, 下週二: 2, 下週三: 3, 下週四: 4, 下週五: 5, 下週六: 6, 下週日: 7 },
	},
	ja: {
		fixed: {
			昨日: { amount: -1, unit: "day" },
			きのう: { amount: -1, unit: "day" },
			昨夜: { amount: -1, unit: "day" },
			昨晩: { amount: -1, unit: "day" },
			先週: { amount: -1, unit: "week" },
			先月: { amount: -1, unit: "month" },
			去年: { amount: -1, unit: "year" },
			来週: { amount: 1, unit: "week" },
			来月: { amount: 1, unit: "month" },
		},
		agoPattern: /^(\S+?)(日|週間|か月|ヶ月|年)前$/u,
		agoUnits: { 日: "day", 週間: "week", か月: "month", ヶ月: "month", 年: "year" },
		numbers: { ...LATIN_NUMBERS, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 },
		nextWeekdays: { 来週の月曜日: 1, 来週の火曜日: 2, 来週の水曜日: 3, 来週の木曜日: 4, 来週の金曜日: 5, 来週の土曜日: 6, 来週の日曜日: 7 },
	},
	ko: {
		fixed: {
			어제: { amount: -1, unit: "day" },
			어젯밤: { amount: -1, unit: "day" },
			이틀전: { amount: -2, unit: "day" },
			"이틀 전": { amount: -2, unit: "day" },
			지난주: { amount: -1, unit: "week" },
			지난달: { amount: -1, unit: "month" },
			작년: { amount: -1, unit: "year" },
			"다음 주": { amount: 1, unit: "week" },
			"다음 달": { amount: 1, unit: "month" },
		},
		agoPattern: /^(\S+?)(일|주|개월|달|년)\s*전$/u,
		agoUnits: { 일: "day", 주: "week", 개월: "month", 달: "month", 년: "year" },
		numbers: { ...LATIN_NUMBERS, 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 },
		nextWeekdays: { "다음 월요일": 1, "다음 화요일": 2, "다음 수요일": 3, "다음 목요일": 4, "다음 금요일": 5, "다음 토요일": 6, "다음 일요일": 7 },
	},
	ru: {
		fixed: {
			вчера: { amount: -1, unit: "day" },
			"прошлой ночью": { amount: -1, unit: "day" },
			"на прошлой неделе": { amount: -1, unit: "week" },
			"в прошлом месяце": { amount: -1, unit: "month" },
			"в прошлом году": { amount: -1, unit: "year" },
			"на следующей неделе": { amount: 1, unit: "week" },
			"в следующем месяце": { amount: 1, unit: "month" },
		},
		agoPattern: /^(\S+)\s+(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)\s+назад$/u,
		agoUnits: { день: "day", дня: "day", дней: "day", неделю: "week", недели: "week", недель: "week", месяц: "month", месяца: "month", месяцев: "month", год: "year", года: "year", лет: "year" },
		numbers: { ...LATIN_NUMBERS, один: 1, одна: 1, одно: 1, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10 },
		nextWeekdays: { "в следующий понедельник": 1, "в следующий вторник": 2, "в следующую среду": 3, "в следующий четверг": 4, "в следующую пятницу": 5, "в следующую субботу": 6, "в следующее воскресенье": 7 },
	},
};

export interface AtomicTemporalNormalizationInput {
	record: AtomicGauntletRecord;
	locale?: Locale;
	sessionDateTime?: string;
	sessionTimezone?: string;
}

function normalizePhrase(phrase: string): string {
	return phrase.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function parseSessionDate(
	sessionDateTime?: string,
	sessionTimezone?: string,
): Temporal.PlainDate | undefined {
	if (!sessionDateTime) return undefined;
	try {
		if (sessionDateTime.includes("[")) {
			return Temporal.ZonedDateTime.from(sessionDateTime, { offset: "use" }).toPlainDate();
		}
		if (/z|[+-]\d{2}:\d{2}$/iu.test(sessionDateTime)) {
			const offset = sessionDateTime.match(/(z|[+-]\d{2}:\d{2})$/iu)?.[1] ?? "UTC";
			const timezone = sessionTimezone ?? (offset.toUpperCase() === "Z" ? "UTC" : offset);
			return Temporal.Instant.from(sessionDateTime).toZonedDateTimeISO(timezone).toPlainDate();
		}
		return Temporal.PlainDateTime.from(sessionDateTime, { overflow: "reject" }).toPlainDate();
	} catch {
		return undefined;
	}
}

function resolveOffset(anchor: Temporal.PlainDate, offset: RelativeOffset): Temporal.PlainDate {
	const amount = Math.abs(offset.amount);
	const direction = offset.amount < 0 ? -1 : 1;
	const signedAmount = amount * direction;
	switch (offset.unit) {
		case "day":
			return anchor.add({ days: signedAmount });
		case "week":
			return anchor.add({ weeks: signedAmount });
		case "month":
			return anchor.add({ months: signedAmount }, { overflow: "constrain" });
		case "year":
			return anchor.add({ years: signedAmount }, { overflow: "constrain" });
	}
}

function resolveRelativePhrase(
	phrase: string,
	locale: Locale,
	anchor: Temporal.PlainDate,
): Temporal.PlainDate | undefined {
	const normalized = normalizePhrase(phrase);
	const table = ATOMIC_RELATIVE_TIME_PHRASES[locale];
	const fixed = table.fixed[normalized];
	if (fixed) return resolveOffset(anchor, fixed);
	const weekday = table.nextWeekdays[normalized];
	if (weekday !== undefined) {
		const delta = ((weekday - anchor.dayOfWeek + 7) % 7) || 7;
		return anchor.add({ days: delta });
	}
	const ago = normalized.match(table.agoPattern);
	if (!ago) return undefined;
	const countToken = ago[1];
	const numericCount = countToken?.match(/^\d+$/u) ? Number(countToken) : undefined;
	const count = countToken
		? (table.numbers[countToken] ??
			(Number.isSafeInteger(numericCount) && Number(numericCount) > 0 ? numericCount : undefined))
		: undefined;
	const unit = ago[2] ? table.agoUnits[ago[2]] : undefined;
	if (count === undefined || unit === undefined) return undefined;
	return resolveOffset(anchor, { amount: -count, unit });
}

/** A time code handed in (a fixture, an older row) must still be a real calendar date. */
function validateResolvedTime(
	value: AtomicExtractionResolvedTime | null,
): AtomicExtractionResolvedTime | null {
	if (value === null) return null;
	try {
		Temporal.PlainDateTime.from(
			{
				year: value.year,
				month: value.month,
				day: value.day,
				hour: value.hour ?? 0,
				minute: value.minute ?? 0,
			},
			{ overflow: "reject" },
		);
		return value;
	} catch {
		return null;
	}
}

function resolvedTimeFromDate(date: Temporal.PlainDate): AtomicExtractionResolvedTime {
	return { year: date.year, month: date.month, day: date.day };
}

interface ParsedPhrase {
	date: Temporal.PlainDate;
	clock?: { hour: number; minute: number };
}

/** The shared parser's reading of a phrase against the session anchor, stated parts and implied. */
function parsePhrase(
	phrase: string,
	locale: Locale,
	input: AtomicTemporalNormalizationInput,
	anchored: boolean,
): ParsedPhrase | undefined {
	const resolved = resolveDateLocally({
		text: phrase,
		...(input.sessionDateTime === undefined ? {} : { sessionDateTime: input.sessionDateTime }),
		...(input.sessionTimezone === undefined ? {} : { sessionTimezone: input.sessionTimezone }),
		locale,
		localFirst: true,
	});
	const reading = resolved.parserReadings.find(
		(candidate) => candidate.parser === resolved.result.stage.selectedParser,
	);
	try {
		if (reading !== undefined) {
			const { values, knownValues } = reading;
			if (values.year === undefined || values.month === undefined || values.day === undefined) {
				return undefined;
			}
			// Unanchored, an inferred year or day comes from the wall clock. Only a stated one counts.
			if (
				!anchored &&
				(knownValues.year === undefined ||
					knownValues.month === undefined ||
					knownValues.day === undefined)
			) {
				return undefined;
			}
			const date = Temporal.PlainDate.from(
				{ year: values.year, month: values.month, day: values.day },
				{ overflow: "reject" },
			);
			// The clock counts only when the phrase stated an hour and did not leave it ambiguous
			// (a bare 1–12 with no am/pm).
			const ambiguousHour =
				knownValues.hour !== undefined &&
				knownValues.hour >= 1 &&
				knownValues.hour <= 12 &&
				knownValues.meridiem === undefined;
			return knownValues.hour !== undefined && !ambiguousHour && values.hour !== undefined
				? { date, clock: { hour: values.hour, minute: values.minute ?? 0 } }
				: { date };
		}
		// No parser for this locale (Korean): the resolver's own day table answers with an interval.
		// That table is relative to a clock, so unanchored it has nothing to say.
		if (!anchored) return undefined;
		const result = resolved.result;
		if (result.interval.resolutionStatus !== "resolved") return undefined;
		const zone = result.timezone === "user" ? "UTC" : result.timezone;
		const at = result.interval.type === "instant" ? result.interval.at : result.interval.from;
		const plain = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone);
		return result.interval.type === "instant"
			? { date: plain.toPlainDate(), clock: { hour: plain.hour, minute: plain.minute } }
			: { date: plain.toPlainDate() };
	} catch {
		return undefined;
	}
}

function resolvePhrase(
	phrase: string,
	locale: Locale,
	input: AtomicTemporalNormalizationInput,
): { time: AtomicExtractionResolvedTime; date: Temporal.PlainDate } | undefined {
	const anchor = parseSessionDate(input.sessionDateTime, input.sessionTimezone);
	// Without the session's own clock a relative phrase would be dated against the wall clock,
	// which is how an eval replaying June once wrote September on every row. Keep the phrase, and
	// accept only a date the phrase states in full — year, month and day — which needs no clock.
	if (anchor !== undefined) {
		const tableDate = resolveRelativePhrase(phrase, locale, anchor);
		if (tableDate) return { time: resolvedTimeFromDate(tableDate), date: tableDate };
	}
	const parsed = parsePhrase(phrase, locale, input, anchor !== undefined);
	if (parsed === undefined) return undefined;
	return {
		time: { ...resolvedTimeFromDate(parsed.date), ...(parsed.clock ?? {}) },
		date: parsed.date,
	};
}

function rewriteRelativePhrase(claimText: string, phrase: string, date: Temporal.PlainDate): string {
	const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	// One occurrence, exact case first: a global case-blind replace turned "I may travel in May"
	// into two dates. Word boundaries apply only where the phrase's own edge is a Latin letter or
	// digit; Chinese, Japanese and Korean run their words together. A phrase that cannot be placed
	// leaves the sentence as it is.
	const latinEdge = /[\p{Script=Latin}\p{N}]/u;
	const before = latinEdge.test(phrase.charAt(0)) ? "(?<![\\p{L}\\p{N}])" : "";
	const after = latinEdge.test(phrase.charAt(phrase.length - 1)) ? "(?![\\p{L}\\p{N}])" : "";
	const bounded = `${before}${escaped}${after}`;
	for (const flags of ["u", "iu"]) {
		const matched = new RegExp(bounded, flags).exec(claimText);
		if (matched !== null) {
			return `${claimText.slice(0, matched.index)}${date.toString()}${claimText.slice(matched.index + matched[0].length)}`;
		}
	}
	return claimText;
}

/**
 * The model hands over the words that carry a time; this turns them into dates. A phrase the
 * engine can place is written into the sentence as a date and dropped; one it cannot place stays
 * as it is, undated. A record that arrives with no phrase keeps whatever date code already gave it.
 */
export function normalizeAtomicTemporalRecord(
	input: AtomicTemporalNormalizationInput,
): AtomicGauntletRecord {
	const { record } = input;
	const locale = input.locale ?? DEFAULT_LOCALE;
	const givenTime = validateResolvedTime(record.resolvedTime);
	let output: AtomicGauntletRecord =
		givenTime === record.resolvedTime
			? record
			: { ...record, resolvedTime: null, resolvedTimeInvalid: true };
	if (record.temporalPhrase !== null) {
		const resolved = resolvePhrase(record.temporalPhrase, locale, input);
		output = resolved
			? {
					...record,
					claimText: rewriteRelativePhrase(record.claimText, record.temporalPhrase, resolved.date),
					resolvedTime: resolved.time,
					temporalPhrase: null,
				}
			: { ...record, resolvedTime: null };
	}
	if (record.endsCurrent && record.endedAtPhrase !== null) {
		const ended = resolvePhrase(record.endedAtPhrase, locale, input);
		output = { ...output, endedAt: ended ? ended.time : null };
	}
	return output;
}
