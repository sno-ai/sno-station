import { describe, expect, it } from "vitest";
import { parseProgressTurns, excludeProgressRecords } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-progress-boundary";

const turns = [
	{ role: "user" as const, content: "The draft is halfway done." },
	{ role: "assistant" as const, content: "Understood." },
	{ role: "user" as const, content: "The draft is halfway done. I prefer tea." },
];
const decisions = [
	{ turn_index: 0, progress_only: true },
	{ turn_index: 2, progress_only: false },
];

describe("progress classification admission", () => {
	it("drops every emitted record from a classified turn, including parked records", async () => {
		const excluded = parseProgressTurns({ decisions }, turns);
		if (excluded === null) throw new Error("Classification rejected");
		const mixed = { sourceSpan: { turnIndex: 2 }, text: "tea" };
		expect(excludeProgressRecords([
			{ sourceSpan: { turnIndex: 0 }, text: "working on draft" },
			{ sourceSpan: null, unresolvedSourceSpan: { turnIndex: 0 }, text: "draft task" },
			mixed,
		], excluded)).toEqual([mixed]);
	});
	it.each([
		{ decisions: [] },
		{ decisions: [decisions[0], decisions[0], decisions[1]] },
		{ decisions: [...decisions, { turn_index: 1, progress_only: true }] },
		{ decisions: [decisions[0], { turn_index: 1, progress_only: false }] },
		{ decisions: [{ turn_index: 0, progress_only: "true" }, decisions[1]] },
	])("refuses incomplete or invalid classifications: %j", async (reply) => {
		expect(parseProgressTurns(reply, turns)).toBeNull();
	});
	it("does not convert an absent reply into permission to store", async () => {
		expect(parseProgressTurns(null, turns)).toBeNull();
	});
});
