/** Model instructions determine meaning; normalization never reads source-language tokens. */
import { describe, expect, it } from "vitest";
import { parseAtomicExtractionReply } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import type { CalendarInstruction } from "../../../../packages/sno-station-mem/src/engine/extraction/calendar-instruction";

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

	it("rejects the obsolete phrase-only model reply instead of guessing", () => {
		const wire = reply({ kind: "unresolved" });
		const record = wire.records[0];
		Reflect.deleteProperty(record, "time");
		expect(parseAtomicExtractionReply(JSON.stringify(wire), 1).ok).toBe(false);
	});

	it.each([
		{ kind: "relative", amount: "minus four", unit: "year", precision: "year" },
		{ kind: "weekday", weekday: 8, direction: "previous", precision: "day" },
		{ kind: "none", amount: -4 },
	])("rejects malformed structured time %j", (time) => {
		expect(parseAtomicExtractionReply(JSON.stringify(reply(time)), 1).ok).toBe(false);
	});
});
