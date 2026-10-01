/** Model instructions determine meaning; normalization never reads source-language tokens. */
import { describe, expect, it } from "vitest";
import { parseAtomicExtractionReply } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-gauntlet";
import type { CalendarInstruction } from "../../../../packages/memory/src/engine/extraction/calendar-instruction";

function reply(time: unknown, endedTime: unknown = { kind: "none" }, endsCurrent = false) {
	return { records: [{
		kind: "occurrence", claim_text: "The note contains yesterday and tomorrow.",
		subject: "user", subject_kind: "user", attribute: null, value: "event",
		temporal_phrase: "yesterday and tomorrow", time, ended_time: endedTime,
		ended_at_phrase: endsCurrent ? "last month" : null, ends_current: endsCurrent,
		importance: "medium", changes_current_state: false, todo: "none", close_reason: null,
		source_span: { turn_index: 0, quote: "The note contains yesterday and tomorrow." },
		relations: [], single_claim: true,
	}] };
}

async function normalize(time: CalendarInstruction, endedTime: CalendarInstruction = { kind: "none" }, endsCurrent = false) {
	const parsed = parseAtomicExtractionReply(JSON.stringify(reply(time, endedTime, endsCurrent)), 1);
	if (!parsed.ok) throw new Error("invalid fixture");
	return (await runAtomicExtractionGauntlet({ records: parsed.records,
		turns: [{ role: "user", content: "The note contains yesterday and tomorrow." }],
		sessionDateTime: "2024-07-17T12:00:00Z", sessionTimezone: "UTC",
	}))[0];
}

describe("atomic temporal normalization", () => {
	it.each([
		[-2, "day", "day", "2024-07-15"],
		[-1, "month", "month", "2024-06"],
		[-10, "year", "year", "2014"],
		[2, "day", "day", "2024-07-19"],
	] as const)("calculates %s %s at %s precision without replacing source words", async (amount, unit, precision, label) => {
		const output = await normalize({ kind: "relative", amount, unit, precision });
		expect(output?.resolvedTime?.label).toBe(label);
		expect(output?.claimText).toBe("The note contains yesterday and tomorrow.");
		expect(output?.temporalPhrase).toBe("yesterday and tomorrow");
	});

	it.each(["none", "unresolved"] as const)("honors %s despite date keywords in the quote", async (kind) => {
		expect((await normalize({ kind }))?.resolvedTime).toBeNull();
	});

	it("calculates the stated ending separately from the event start", async () => {
		const output = await normalize(
			{ kind: "relative", amount: -4, unit: "year", precision: "year" },
			{ kind: "relative", amount: -1, unit: "month", precision: "month" }, true);
		expect(output?.resolvedTime?.label).toBe("2020");
		expect(output?.endedAt?.label).toBe("2024-06");
	});

	it.each(["time", "ended_time"])("keeps both records when one model record omits %s", async (missing) => {
		const wire = reply({ kind: "relative", amount: -1, unit: "day", precision: "day" });
		const first = wire.records[0];
		if (!first) throw new Error("missing fixture");
		const second = { ...first };
		Reflect.deleteProperty(second, missing);
		wire.records.push(second);
		const parsed = parseAtomicExtractionReply(JSON.stringify(wire), 1);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("the complete record was discarded");
		expect(parsed.records).toHaveLength(2);
		expect(parsed.records[0]?.time).toMatchObject({ kind: "relative", amount: -1 });
		expect(parsed.records[1]?.time).toEqual(missing === "time" ? { kind: "unresolved" } : first.time);
		expect(parsed.records[1]?.endedTime).toEqual({ kind: "none" });
		const normalized = await runAtomicExtractionGauntlet({ records: parsed.records, turns: [{ role: "user", content: first.claim_text }], sessionDateTime: "2024-07-17T12:00:00Z", sessionTimezone: "UTC" });
		expect(normalized).toHaveLength(2);
		expect(normalized[0]?.resolvedTime?.label).toBe("2024-07-16");
		if (missing === "time") expect(normalized[1]?.resolvedTime).toBeNull();
	});

	it("keeps an ending with missing ended_time unresolved without dropping the other record", async () => {
		const wire = reply({ kind: "none" }, { kind: "relative", amount: -1, unit: "day", precision: "day" }, true);
		const first = wire.records[0];
		if (!first) throw new Error("missing fixture");
		const second = { ...first };
		Reflect.deleteProperty(second, "ended_time");
		wire.records.push(second);
		const parsed = parseAtomicExtractionReply(JSON.stringify(wire), 1);
		if (!parsed.ok) throw new Error("the complete record was discarded");
		expect(parsed.records).toHaveLength(2);
		expect(parsed.records[1]?.endedTime).toEqual({ kind: "unresolved" });
		const normalized = await runAtomicExtractionGauntlet({ records: parsed.records, turns: [{ role: "user", content: first.claim_text }], sessionDateTime: "2024-07-17T12:00:00Z", sessionTimezone: "UTC" });
		expect(normalized[0]?.endedAt?.label).toBe("2024-07-16");
		expect(normalized[1]?.endedAt).toBeNull();
	});

	it.each([
		{ kind: "relative", amount: "minus four", unit: "year", precision: "year" },
		{ kind: "weekday", weekday: 8, direction: "previous", precision: "day" },
		{ kind: "none", amount: -4 },
		{ kind: "relative", amount: -1, unit: "days", precision: "day" },
		{ kind: "relative", amount: -1, unit: "day", precision: "decade" },
		null,
	])("keeps valid facts when nested time and ending instructions are malformed: %j", async (badTime) => {
		const wire = reply({ kind: "relative", amount: -2, unit: "day", precision: "day" }, { kind: "relative", amount: -1, unit: "day", precision: "day" }, true);
		const first = wire.records[0];
		if (!first) throw new Error("missing fixture");
		wire.records.push({ ...first, time: badTime, ended_time: badTime });
		const parsed = parseAtomicExtractionReply(JSON.stringify(wire), 1);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("the valid neighboring fact was discarded");
		expect(parsed.records).toHaveLength(2);
		expect(parsed.records[1]).toMatchObject({ claimText: first.claim_text, time: { kind: "unresolved" }, endedTime: { kind: "unresolved" } });
		const normalized = await runAtomicExtractionGauntlet({ records: parsed.records, turns: [{ role: "user", content: first.claim_text }], sessionDateTime: "2024-07-17T12:00:00Z", sessionTimezone: "UTC" });
		expect(normalized).toHaveLength(2);
		expect(normalized[0]?.resolvedTime?.label).toBe("2024-07-15");
		expect(normalized[0]?.endedAt?.label).toBe("2024-07-16");
		expect(normalized[1]?.resolvedTime).toBeNull();
		expect(normalized[1]?.endedAt).toBeNull();
	});

	it("still rejects an invalid core claim instead of treating it as a time-only defect", () => {
		const wire = reply({ kind: "none" });
		const first = wire.records[0];
		if (!first) throw new Error("missing fixture");
		const malformed = { ...first, claim_text: 123, time: null };
		expect(parseAtomicExtractionReply(JSON.stringify({ records: [first, malformed] }), 1).ok).toBe(false);
	});

});
