import { describe, expect, it } from "vitest";
import { parseAtomicExtractionReply } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-gauntlet";

const sentence = "I switched my local model server to LM Studio today and uninstalled Ollama.";
const turns = [{ role: "user" as const, content: `Heads up: ${sentence} Just acknowledge in one line.\n` }];
const none = { kind: "none" } as const;
const today = { kind: "relative", amount: 0, unit: "day", precision: "day" } as const;

function splitRecord(kind: string, claim: string, value: string, relations: unknown) {
	return {
		kind, claim_text: claim, subject: "user", subject_kind: "user", attribute: null, value,
		temporal_phrase: "today", time: today, ended_time: none, ends_current: false, ended_at_phrase: null,
		importance: "medium", changes_current_state: true, todo: "none", close_reason: null,
		source_span: { turn_index: 0, quote: sentence }, relations, single_claim: true,
	};
}

// The split call's real reply shape on 2026-11-23 (4 of 4 replays): relation type names, not relation objects.
const realSplitReply = JSON.stringify({ claims_found: [0, 0], records: [
	splitRecord("standing", "The user's local model server is now LM Studio.", "LM Studio", ["MENTIONS"]),
	splitRecord("occurrence", "The user uninstalled Ollama today.", "Uninstalled Ollama", ["MENTIONS"]),
] });

describe("a split reply that lists relation type names", () => {
	it("is read, and each listed name that is not a relation is left out", () => {
		const parsed = parseAtomicExtractionReply(realSplitReply, 1);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.records.map(record => record.claimText)).toEqual([
			"The user's local model server is now LM Studio.", "The user uninstalled Ollama today.",
		]);
		expect(parsed.records.map(record => record.relations)).toEqual([[], []]);
	});

	it("keeps a well-formed relation beside a bare name", () => {
		const parsed = parseAtomicExtractionReply(JSON.stringify({ records: [splitRecord("standing",
			"The user's local model server is now LM Studio.", "LM Studio",
			["MENTIONS", { subject: "user", predicate: "MENTIONS", object: "LM Studio" }])] }), 1);
		expect(parsed.ok && parsed.records[0]?.relations).toEqual([{ subject: "user", predicate: "MENTIONS", object: "LM Studio" }]);
	});

	it("turns the corrected sentence into separate facts that are stored for use, not set aside", async () => {
		const records = await runAtomicExtractionGauntlet({
			records: [{
				kind: "occurrence", claimText: "The owner switched their local model server to LM Studio today and uninstalled Ollama.",
				subject: "user", subjectKind: "user", attribute: null, value: "Switched local model server to LM Studio and uninstalled Ollama",
				temporalPhrase: "today", time: today, endedTime: none, resolvedTime: null, endsCurrent: false, endedAtPhrase: null,
				endedAt: null, importance: "medium", changesCurrentState: true, todo: "none", closeReason: null,
				sourceSpan: { turnIndex: 0, quote: sentence }, relations: [], singleClaim: false,
			}],
			turns, captureMode: "work", sessionDateTime: "2026-11-22T21:36:00-08:00", sessionTimezone: "-08:00", locale: "en",
			resplitTransport: { async resplit() {
				const parsed = parseAtomicExtractionReply(realSplitReply, turns.length);
				return parsed.ok ? parsed.records : null;
			} },
		});
		expect(records.filter(record => record.lane === "active").map(record => record.claimText)).toEqual([
			"The user's local model server is now LM Studio.", "The user uninstalled Ollama today.",
		]);
	});
});
