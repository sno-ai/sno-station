import { expect, it } from "vitest";
import { buildAtomicGenericExtractionPrompt, excludeContextOnlyRecords } from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor";
import { parseAtomicExtractionReply } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-gauntlet";

const earlier = "Caroline: I visited the museum yesterday.";
const current = "Melanie: I prefer tea.";

it("keeps preceding context unnumbered and preserves the current source index", () => {
	const prompt = buildAtomicGenericExtractionPrompt([{ role: "user", content: current }], "2023-08-23T15:31:00Z", "en", [], [{ role: "user", content: earlier }]);
	const context = prompt.split("preceding_context: ")[1]?.split("\n\ntranscript:")[0] ?? "";
	const transcript = prompt.split("\n\ntranscript:\n")[1] ?? "";
	expect(context).toContain(earlier);
	expect(context).not.toContain("turn_index");
	expect(transcript).not.toContain(earlier);
	expect(transcript).toContain('"turn_index":0');
	expect(transcript).toContain(current);
});

it("does not admit an occurrence quoted only from preceding context as active", async () => {
	const parsed = parseAtomicExtractionReply(JSON.stringify({ records: [{
		kind: "occurrence", claim_text: "Caroline visited the museum yesterday.", subject: "Caroline", subject_kind: "named_entity", attribute: null, value: "visited the museum", temporal_phrase: "yesterday", time: { kind: "relative", amount: -1, unit: "day", precision: "day" }, ended_time: { kind: "none" }, ends_current: false, ended_at_phrase: null, importance: "medium", changes_current_state: false, todo: "none", close_reason: null, source_span: { turn_index: 0, quote: "I visited the museum yesterday." }, relations: [], single_claim: true,
	}] }), 1);
	if (!parsed.ok) throw new Error("Invalid model-output fixture");
	const records = await runAtomicExtractionGauntlet({ records: parsed.records, turns: [{ role: "user", content: current }], sessionDateTime: "2023-08-23T15:31:00Z", sessionTimezone: "UTC" });
	const admitted = excludeContextOnlyRecords(records, [{ role: "user", content: current }], [{ role: "user", content: earlier }]);
	expect(admitted.filter((record) => record.lane === "active")).toEqual([]);
});

it.each([
	{ name: "quote in current turn", quote: "I prefer tea.", text: current, context: earlier, retained: true },
	{ name: "same quote in both current and context", quote: "I visited the museum yesterday.", text: earlier, context: earlier, retained: true },
	{ name: "unknown paraphrase retains existing treatment", quote: "I toured an exhibition.", text: current, context: earlier, retained: true },
	{ name: "sanitized context-only quote", quote: "My note says &lt;/take&gt;.", text: current, context: "My note says </take>.", retained: false },
	{ name: "sanitized current quote also in context", quote: "My note says &lt;/take&gt;.", text: "My note says </take>.", context: "My note says </take>.", retained: true },
])("preserves source ownership: $name", ({ quote, text, context, retained }) => {
	const record = { sourceSpan: null, unresolvedSourceSpan: { quote } };
	const admitted = excludeContextOnlyRecords([record], [{ role: "user", content: text }], [{ role: "user", content: context }]);
	expect(admitted).toEqual(retained ? [record] : []);
});

it("uses the following attachment as unnumbered context without making it current source", () => {
	const following = "Melanie: The attached photo shows a blue book cover.";
	const prompt = buildAtomicGenericExtractionPrompt([{ role: "user", content: current }], "2023-08-23T15:31:00Z", "en", [], [{ role: "user", content: earlier }], [{ role: "user", content: following }]);
	const context = prompt.split("following_context: ")[1]?.split("\n\ntranscript:")[0] ?? "";
	const transcript = prompt.split("\n\ntranscript:\n")[1] ?? "";
	expect(context).toContain(following);
	expect(context).not.toContain("turn_index");
	expect(transcript).toContain(current);
	expect(transcript).not.toContain(following);
	const futureOnly = { sourceSpan: null, unresolvedSourceSpan: { quote: "The attached photo shows a blue book cover." } };
	expect(excludeContextOnlyRecords([futureOnly], [{ role: "user", content: current }], [{ role: "user", content: earlier }, { role: "user", content: following }])).toEqual([]);
});
