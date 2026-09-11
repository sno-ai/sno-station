import { describe, expect, it } from "vitest";
import { parseAtomicExtractionReply } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import { buildAtomicWriteCards } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";

async function project(text: string, phrase: string | null, time: unknown, anchor: string) {
	const parsed = parseAtomicExtractionReply(JSON.stringify({ records: [{
		kind: "occurrence", claim_text: text, subject: "Caroline", subject_kind: "named_entity",
		attribute: null, value: text, temporal_phrase: phrase, time,
		ends_current: false, ended_at_phrase: null, ended_time: { kind: "none" },
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
			kind: "weekday", weekday: 2, direction: "previous", precision: "day",
		}, "2023-07-20T20:56:00Z");
		expect(card?.metadata).toMatchObject({ event_at: "2023-07-18T00:00:00.000Z" });
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
