import { buildInsightMetadata } from "../../../../packages/sno-station-mem/src/engine/extraction/memory-metadata-codec";
import { episodicEventDate } from "../../../../packages/sno-station-mem/src/engine/bindings/memory-tool-formatting";
import { serializeIntervalMetadata } from "../../../../packages/sno-station-mem/src/engine/extraction/memory-temporality-classifier";
import { describe, expect, it } from "vitest";
import { parseAtomicExtractionReply } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import { buildAtomicWriteCards } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";

async function project(text: string, phrase: string | null, time: unknown, anchor: string, ending?: unknown) {
	const parsed = parseAtomicExtractionReply(JSON.stringify({ records: [{
		kind: "occurrence", claim_text: text, subject: "Caroline", subject_kind: "named_entity",
		attribute: null, value: text, temporal_phrase: phrase, time,
		ends_current: ending !== undefined, ended_at_phrase: ending ? "last year" : null, ended_time: ending ?? { kind: "none" },
		importance: "medium", changes_current_state: false, todo: "none", close_reason: null,
		source_span: { turn_index: 0, quote: text }, relations: [], single_claim: true,
	}] }), 1);
	if (!parsed.ok) throw new Error("Reply was rejected");
	const records = await runAtomicExtractionGauntlet({
		records: parsed.records, turns: [{ role: "user", content: text }],
		sessionDateTime: anchor, sessionTimezone: "UTC", locale: "en",
	});
	const cards = buildAtomicWriteCards({
		records: records.map((record) => ({ ...record, category: "episodic" as const })),
		idempotencyKeys: ["calendar-instruction"], sourceTurnOffset: 0,
		sessionTimestampMs: Date.parse(anchor), timezone: "UTC",
	});
	return cards[0];
}

describe("model meaning to calendar arithmetic to write metadata", () => {
	it("keeps the year precision of a past duration instead of inventing a future day", async () => {
		const text = "I've known these friends for 4 years, since I moved from my home country.";
		const card = await project(text, "for 4 years", {
			kind: "relative", amount: -4, unit: "year", precision: "year",
		}, "2023-06-09T19:55:00Z");
		expect(card?.metadata).toMatchObject({ temporal_date: "2019", temporal_precision: "year" });
		expect(card?.metadata).not.toHaveProperty("event_at");
		expect(card?.text).toBe(text);
	});

	it("uses the model's weekday decision without reading the weekday spelling", async () => {
		const text = "I just joined a new LGBTQ activist group last Tues.";
		const card = await project(text, "last Tues", {
			kind: "weekday", day_name: "tuesday", direction: "previous", precision: "day",
		}, "2023-07-20T20:56:00Z");
		expect(card?.metadata).toMatchObject({ event_at: "2023-07-18T00:00:00.000Z" });
	});

	it("lands a named Friday said on a Sunday on the Friday two days back", async () => {
		const text = "Last Friday, I did yoga and meditation to relax.";
		const card = await project(text, "Last Friday", {
			kind: "weekday", day_name: "friday", direction: "previous", precision: "day",
		}, "2023-07-23T15:20:00Z");
		expect(card?.metadata).toMatchObject({ temporal_date: "2023-07-21", event_at: "2023-07-21T00:00:00.000Z" });
	});

	it("does not override a model's unresolved verdict with a recognizable keyword", async () => {
		const card = await project("The note says yesterday, but does not date this event.", "yesterday",
			{ kind: "unresolved" }, "2023-07-20T20:56:00Z");
		expect(card?.metadata).not.toHaveProperty("event_at");
		expect(card?.validFrom).toBeNull();
	});

	it("does not invent a session date for an undated historical event", async () => {
		const card = await project("Caroline moved from her home country.", null,
			{ kind: "unresolved" }, "2023-06-09T19:55:00Z");
		expect(card?.metadata).not.toHaveProperty("event_at");
		expect(card?.validFrom).toBeNull();
	});

	it("keeps past and future decisions separate even when their quoted words are identical", async () => {
		const card = await project("The programme begins four years from now.", "four years",
			{ kind: "relative", amount: 4, unit: "year", precision: "year" }, "2023-06-09T19:55:00Z");
		expect(card?.metadata).toMatchObject({ temporal_date: "2027", temporal_precision: "year" });
	});
});

describe("calendar boundaries and invalid operations", () => {
	it.each([
		["2023-01-31T12:00:00Z", 1, "month", "2023-02-28"],
		["2024-01-31T12:00:00Z", 1, "month", "2024-02-29"],
		["2024-03-31T12:00:00Z", -1, "month", "2024-02-29"],
		["2024-02-29T12:00:00Z", -10, "year", "2014-02-28"],
	] as const)("constrains %s shifted %s %s", async (anchor, amount, unit, label) => {
		const card = await project("The event has the stated calendar offset.", null,
			{ kind: "relative", amount, unit, precision: "day" }, anchor);
		expect(card?.metadata).toMatchObject({ temporal_date: label, event_at: `${label}T00:00:00.000Z` });
	});

	it.each([
		{ kind: "absolute", year: 2023, month: 2, day: 30, precision: "day" },
		{ kind: "absolute", year: 2023, month: 2, precision: "day" },
		{ kind: "absolute", year: 2024, month: 3, day: 10, hour: 2, minute: 30, precision: "minute", timezone: "America/Los_Angeles" },
		{ kind: "absolute", year: 2024, month: 11, day: 3, hour: 1, minute: 30, precision: "minute", timezone: "America/Los_Angeles" },
	] as const)("does not invent an instant from invalid or ambiguous calendar fields %j", async (instruction) => {
		const card = await project("The source supplied this time.", null, instruction, "2024-07-17T12:00:00Z");
		expect(card?.validFrom).toBeNull();
		expect(card?.metadata).not.toHaveProperty("event_at");
	});
});


it("does not turn a standing fact's start-year precision into an expiry", () => {
	const interval = { type: "bounded" as const, resolutionStatus: "resolved" as const, from: Date.UTC(2019, 0, 1), until: Date.UTC(2020, 0, 1), phrase: "for 4 years", date: "2019", precision: "year" as const };
	for (const category of ["profile", "state"] as const) {
		const metadata = serializeIntervalMetadata(category, interval);
		expect(metadata).toMatchObject({ valid_from: Date.UTC(2019, 0, 1), temporal_date: "2019", temporal_precision: "year" });
		expect(metadata).not.toHaveProperty("valid_until");
		expect(metadata).not.toHaveProperty("event_at");
	}
	expect(serializeIntervalMetadata("episodic", interval)).toMatchObject({ valid_until: Date.UTC(2020, 0, 1), temporal_date: "2019" });
});


it("preserves a coarse ending range without inventing an exact closing day", async () => {
	const card = await project("The user stopped living in Kyoto last year.", null, { kind: "none" }, "2023-06-09T19:55:00Z", { kind: "relative", amount: -1, unit: "year", precision: "year" });
	expect(card?.endedAt).toBeNull();
	expect(card?.metadata).toMatchObject({ ended_at_date: "2022", ended_at_precision: "year", ended_at_from: Date.UTC(2022, 0, 1), ended_at_until: Date.UTC(2023, 0, 1), ended_time_instruction: { kind: "relative", amount: -1, unit: "year", precision: "year" } });
});


describe("metadata normalization preserves event uncertainty", () => {
	const entry = { text: "The user moved from their home country.", category: "episodic" as const, timestamp: Date.parse("2023-06-09T19:55:00Z") };

	it("does not derive an event date from the statement timestamp", () => {
		const metadata = buildInsightMetadata(entry);
		expect(metadata.event_at).toBeUndefined();
		expect(metadata.temporal_resolution_status).toBe("unresolved");
		expect(metadata.valid_from).toBeUndefined();
		expect(metadata.valid_until).toBeUndefined();
		expect(episodicEventDate({ metadata: JSON.stringify(metadata) })).toBeUndefined();
	});

	it.each(["unresolved", "static"] as const)("does not revive an old event date after a new %s judgment", (status) => {
		const metadata = buildInsightMetadata({ ...entry, metadata: JSON.stringify({ kind: "episodic", event_at: "2019-01-01T00:00:00Z", valid_from: Date.UTC(2019, 0, 1) }) }, { temporal_resolution_status: status });
		expect(metadata.event_at).toBeUndefined();
		expect(episodicEventDate({ metadata: JSON.stringify(metadata) })).toBeUndefined();
	});

	it("preserves year precision without turning January 1 into the event date", () => {
		const metadata = buildInsightMetadata({ ...entry, metadata: JSON.stringify({ kind: "episodic", event_at: "2019-01-01T00:00:00Z" }) }, { temporal_resolution_status: "resolved", temporal_date: "2019", temporal_precision: "year", valid_from: Date.UTC(2019, 0, 1), valid_until: Date.UTC(2020, 0, 1) });
		expect(metadata.event_at).toBeUndefined();
		expect(episodicEventDate({ metadata: JSON.stringify(metadata) })).toBe("2019");
	});

	it("accepts an explicitly supplied event timestamp", () => {
		const metadata = buildInsightMetadata(entry, { event_at: "2020-03-15T00:00:00Z" });
		expect(metadata.event_at).toBe("2020-03-15T00:00:00Z");
		expect(episodicEventDate({ metadata: JSON.stringify(metadata) })).toBe("2020-03-15");
	});
});


it.each([[0, "1970-01-01"], [-1, "1969-12-31"]] as const)("preserves the explicitly supplied numeric event timestamp %s", (eventAt, label) => {
	const metadata = buildInsightMetadata({ text: "An explicitly dated event.", category: "episodic", timestamp: Date.parse("2023-06-09T19:55:00Z"), metadata: JSON.stringify({ kind: "episodic", event_at: eventAt }) });
	expect(metadata.event_at).toBe(eventAt);
	expect(episodicEventDate({ metadata: JSON.stringify(metadata) })).toBe(label);
});

it.each([
	{ name: "missing minute clock", time: { kind: "weekday", day_name: "tuesday", direction: "previous", precision: "minute" }, label: undefined, eventAt: undefined, from: null },
	{ name: "explicit 10:00 clock", time: { kind: "weekday", day_name: "tuesday", direction: "previous", precision: "minute", hour: 10, minute: 0 }, label: "2023-07-18T10:00", eventAt: "2023-07-18T10:00:00.000Z", from: Date.UTC(2023, 6, 18, 10) },
	{ name: "day without a clock", time: { kind: "weekday", day_name: "tuesday", direction: "previous", precision: "day" }, label: "2023-07-18", eventAt: "2023-07-18T00:00:00.000Z", from: Date.UTC(2023, 6, 18) },
])("does not inherit the session clock for weekday $name", async ({ time, label, eventAt, from }) => {
	const card = await project("The user attended the meeting last Tuesday.", "last Tuesday", time, "2023-07-20T14:37:00Z");
	expect(card).toBeDefined();
	expect(card?.validFrom).toBe(from);
	expect(card?.metadata?.event_at).toBe(eventAt);
	expect(episodicEventDate({ metadata: JSON.stringify(card?.metadata) })).toBe(label);
	if (label === undefined) {
		expect(card?.metadata).toMatchObject({ temporal_resolution_status: "unresolved" });
		expect(card?.metadata).not.toHaveProperty("temporal_date");
	}
});

it("shows the resolved date of a dated plan, which is a standing claim, not an event", () => {
	// Measured 2026-09-20: 77 rows of a re-extracted store held a resolved date that no reader
	// was shown, because the renderer keyed on `kind` instead of on having a resolved date.
	const metadata = {
		kind: "state", temporal_resolution_status: "resolved",
		temporal_date: "2023-03", temporal_precision: "month",
	};
	expect(episodicEventDate({ metadata: JSON.stringify(metadata) })).toBe("2023-03");
	expect(episodicEventDate({ metadata: JSON.stringify({ ...metadata, temporal_resolution_status: "static" }) })).toBeUndefined();
});

it.each([
	["2024", "year", true], ["2024-02", "month", true], ["2024-02-29", "day", true],
	["2024-02-29T10:30", "minute", true], ["2024-02-26/2024-03-04", "week", true],
	["Friday", "day", false], ["2023-02-29", "day", false], ["2024-13", "month", false],
	["2024-02-29T25:00", "minute", false], ["2024-02-26/2024-03-05", "week", false],
	["2024-02-29", "year", false], ["2024", "day", false],
] as const)("validates calendar label %s at %s precision", (label, precision, valid) => {
	const metadata = { kind: "episodic", temporal_resolution_status: "resolved", temporal_date: label, temporal_precision: precision };
	expect(episodicEventDate({ metadata: JSON.stringify(metadata) })).toBe(valid ? label : undefined);
	if (!valid) expect(episodicEventDate({ metadata: JSON.stringify({ ...metadata, event_at: "2020-03-15T00:00:00Z" }) })).toBe("2020-03-15");
});

it.each([
	{ kind: "absolute", year: 2023, month: 7, day: 18, precision: "day", hour: 10, minute: 30 },
	{ kind: "relative", amount: -1, unit: "day", precision: "day", hour: 10, minute: 30 },
	{ kind: "weekday", day_name: "tuesday", direction: "previous", precision: "day", hour: 10, minute: 30 },
	{ kind: "absolute", year: 2023, month: 7, day: 18, precision: "minute", minute: 30 },
	{ kind: "relative", amount: -1, unit: "day", precision: "minute", minute: 30 },
	{ kind: "weekday", day_name: "tuesday", direction: "previous", precision: "minute", minute: 30 },
])("keeps inconsistent or incomplete clock instructions unresolved: %j", async (time) => {
	const card = await project("The user attended a meeting.", null, time, "2023-07-20T14:37:00Z");
	expect(card).toBeDefined();
	expect(card?.validFrom).toBeNull();
	expect(card?.metadata).not.toHaveProperty("event_at");
	expect(episodicEventDate({ metadata: JSON.stringify(card?.metadata) })).toBeUndefined();
});

it.each([
	[{ kind: "absolute", year: 2023, month: 7, day: 18, precision: "minute", hour: 10, minute: 30 }, "2023-07-18T10:30"],
	[{ kind: "relative", amount: -1, unit: "day", precision: "minute", hour: 10, minute: 30 }, "2023-07-19T10:30"],
	[{ kind: "weekday", day_name: "tuesday", direction: "previous", precision: "minute", hour: 10, minute: 30 }, "2023-07-18T10:30"],
])("preserves a complete minute clock: %j", async (time, label) => {
	const card = await project("The meeting was at the stated date and 10:30.", null, time, "2023-07-20T14:37:00Z");
	expect(episodicEventDate({ metadata: JSON.stringify(card?.metadata) })).toBe(label);
});
