/** Calendar operations supplied by a model. This module never reads natural language. */
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

export type CalendarPrecision = "year" | "month" | "week" | "day" | "minute";
interface CalendarClock { hour?: number; minute?: number; timezone?: string }
export type CalendarInstruction =
	| { kind: "none" }
	| { kind: "unresolved" }
	| ({ kind: "absolute"; year: number; month?: number; day?: number; precision: CalendarPrecision } & CalendarClock)
	| ({ kind: "relative"; amount: number; unit: "year" | "month" | "week" | "day" | "hour" | "minute"; precision: CalendarPrecision } & CalendarClock)
	| ({ kind: "weekday"; weekday: number; direction: "previous" | "next"; precision: "day" | "minute" } & CalendarClock);

const precisionSchema = z.enum(["year", "month", "week", "day", "minute"]);
const clock = {
	hour: z.number().int().min(0).max(23).optional(),
	minute: z.number().int().min(0).max(59).optional(),
	timezone: z.string().min(1).describe("A valid IANA time zone identifier or fixed UTC offset in +HH:MM or -HH:MM form; never a natural-language abbreviation. Keep hour and minute in that source zone.").optional(),
};

export const calendarInstructionSchema: z.ZodType<CalendarInstruction> = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }).strict(),
	z.object({ kind: z.literal("unresolved") }).strict(),
	z.object({
		kind: z.literal("absolute"), year: z.number().int(),
		month: z.number().int().min(1).max(12).optional(),
		day: z.number().int().min(1).max(31).optional(),
		precision: precisionSchema, ...clock,
	}).strict(),
	z.object({
		kind: z.literal("relative"), amount: z.number().int(),
		unit: z.enum(["year", "month", "week", "day", "hour", "minute"]),
		precision: precisionSchema, ...clock,
	}).strict(),
	z.object({
		kind: z.literal("weekday"), weekday: z.number().int().min(1).max(7),
		direction: z.enum(["previous", "next"]),
		precision: z.enum(["day", "minute"]), ...clock,
	}).strict(),
]);

export interface CalendarResult {
	year: number;
	month: number;
	day: number;
	hour?: number;
	minute?: number;
	precision: CalendarPrecision;
	timezone: string;
	label: string;
	from: number;
	until: number;
}

/** Validate only serialized calendar labels and precision, never natural-language meaning. */
export function isCalendarLabel(value: unknown, precision: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		switch (precision) {
			case "year": return /^\d{4}$/u.test(value) && Temporal.PlainYearMonth.from(`${value}-01`).year === Number(value);
			case "month": return Temporal.PlainYearMonth.from(value).toString() === value;
			case "day": return Temporal.PlainDate.from(value).toString() === value;
			case "minute": return Temporal.PlainDateTime.from(value).toString({ smallestUnit: "minute" }) === value;
			case "week": {
				const [from, until, extra] = value.split("/");
				if (!from || !until || extra !== undefined) return false;
				const start = Temporal.PlainDate.from(from);
				return start.toString() === from && start.dayOfWeek === 1 && start.add({ days: 7 }).toString() === until;
			}
			default: return false;
		}
	} catch { return false; }
}

export function sessionZoneCarriedBy(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try { return Temporal.ZonedDateTime.from(value).timeZoneId; } catch { /* Offset-only ISO. */ }
	const offset = /(Z|[+-]\d{2}:?\d{2})$/u.exec(value)?.[1];
	return offset === "Z" ? "UTC" : offset;
}

function anchorDate(value: string | undefined, zone: string): Temporal.ZonedDateTime | undefined {
	if (!value) return undefined;
	try { return Temporal.Instant.from(value).toZonedDateTimeISO(zone); } catch { /* Local ISO. */ }
	try { return Temporal.ZonedDateTime.from(value).withTimeZone(zone); } catch { /* Local ISO. */ }
	try { return Temporal.PlainDateTime.from(value).toZonedDateTime(zone); } catch { return undefined; }
}

export function calendarSessionTimestamp(value: string | undefined, zone?: string): number | undefined {
	return anchorDate(value, zone ?? sessionZoneCarriedBy(value) ?? "UTC")?.epochMilliseconds;
}

function shift(unit: string, amount: number): Temporal.DurationLike {
	switch (unit) {
		case "year": return { years: amount };
		case "month": return { months: amount };
		case "week": return { weeks: amount };
		case "day": return { days: amount };
		case "hour": return { hours: amount };
		case "minute": return { minutes: amount };
		default: throw new Error("Unknown calendar unit");
	}
}

function interval(date: Temporal.ZonedDateTime, precision: CalendarPrecision): CalendarResult {
	let start = date.startOfDay();
	if (precision === "year") start = start.with({ month: 1, day: 1 });
	if (precision === "month") start = start.with({ day: 1 });
	if (precision === "week") start = start.subtract({ days: start.dayOfWeek - 1 });
	if (precision === "minute") start = date.with({ second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
	const end = start.add(shift(precision, 1));
	const iso = start.toPlainDate().toString();
	const label = precision === "year" ? iso.slice(0, 4) : precision === "month" ? iso.slice(0, 7)
		: precision === "week" ? `${iso}/${end.toPlainDate().toString()}`
		: precision === "minute" ? start.toPlainDateTime().toString({ smallestUnit: "minute" }) : iso;
	return {
		year: start.year, month: start.month, day: start.day,
		...(precision === "minute" ? { hour: start.hour, minute: start.minute } : {}),
		precision, timezone: date.timeZoneId, label, from: start.epochMilliseconds, until: end.epochMilliseconds,
	};
}

/** Invalid or unsupported instructions stay unresolved; no phrase parser or clock fallback. */
export function calculateCalendarTime(
	instruction: CalendarInstruction,
	sessionDateTime?: string,
	sessionTimezone?: string,
): CalendarResult | null {
	if (instruction.kind === "none" || instruction.kind === "unresolved") return null;
	if ((instruction.hour !== undefined || instruction.minute !== undefined) && instruction.precision !== "minute") return null;
	if (instruction.minute !== undefined && instruction.hour === undefined) return null;
	if (instruction.kind === "weekday" && instruction.precision === "minute" && instruction.hour === undefined) return null;
	const zone = instruction.timezone ?? sessionTimezone ?? sessionZoneCarriedBy(sessionDateTime) ?? "UTC";
	try {
		let date: Temporal.ZonedDateTime;
		if (instruction.kind === "absolute") {
			if (instruction.precision !== "year" && instruction.month === undefined) return null;
			if (!["year", "month"].includes(instruction.precision) && instruction.day === undefined) return null;
			if (instruction.precision === "minute" && instruction.hour === undefined) return null;
			date = Temporal.ZonedDateTime.from({
				timeZone: zone, year: instruction.year, month: instruction.month ?? 1, day: instruction.day ?? 1,
				hour: instruction.hour ?? 0, minute: instruction.minute ?? 0,
			}, { overflow: "reject", disambiguation: "reject" });
		} else {
			const anchor = anchorDate(sessionDateTime, zone);
			if (!anchor) return null;
			if (instruction.kind === "relative") date = anchor.add(shift(instruction.unit, instruction.amount));
			else {
				const forward = instruction.direction === "next";
				const delta = forward ? (instruction.weekday - anchor.dayOfWeek + 7) % 7
					: (anchor.dayOfWeek - instruction.weekday + 7) % 7;
				date = anchor.add({ days: (forward ? 1 : -1) * (delta || 7) });
			}
			if (instruction.hour !== undefined) date = date.with({ hour: instruction.hour, minute: instruction.minute ?? 0 }, { disambiguation: "reject" });
		}
		return interval(date, instruction.precision);
	} catch { return null; }
}
