import { expect, it } from "vitest";
import { createAtomicResplitTransport } from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";

const sentence = "I switched my local model server to LM Studio today and uninstalled Ollama.";
const none = { kind: "none" } as const;

// Measured 2026-11-24 with Claude answering the split call: 3 of 4 replies copied the field names of the record they
// were shown (claimText, sourceSpan, singleClaim), which the reply parser refuses, so the sentence stayed set aside.
it("shows the split call each record in the field names its reply must use", async () => {
	let prompt = "";
	const transport = createAtomicResplitTransport({
		async completeText(input: { prompt: string }) { prompt = input.prompt; return '{"records":[]}'; },
	} as never, "en");
	await transport.resplit({
		records: [{
			precisionKind: "person", kind: "standing",
			claimText: "The user's local model server is LM Studio, which replaced Ollama; Ollama has been uninstalled.",
			subject: "user", subjectKind: "user", attribute: null, value: "LM Studio as local model server, replacing Ollama",
			temporalPhrase: "today", time: { kind: "relative", amount: 0, unit: "day", precision: "day" }, endedTime: none,
			resolvedTime: null, endsCurrent: false, endedAtPhrase: null, endedAt: null, importance: "medium",
			changesCurrentState: false, todo: "none", closeReason: null,
			sourceSpan: { turnIndex: 0, quote: sentence }, relations: [], singleClaim: false,
		}],
		turns: [{ role: "user", content: `Heads up: ${sentence}` }],
	});
	const data = prompt.slice(prompt.lastIndexOf("thing_attribute_slugs:"));
	for (const name of ["claim_text", "subject_kind", "temporal_phrase", "ends_current", "changes_current_state",
		"close_reason", "source_span", "turn_index", "single_claim"]) expect(data).toContain(`"${name}"`);
	for (const name of ["claimText", "subjectKind", "temporalPhrase", "endsCurrent", "changesCurrentState", "closeReason",
		"sourceSpan", "turnIndex", "singleClaim", "precisionKind", "resolvedTime", "endedAt\""]) expect(data).not.toContain(name);
	expect(data).toContain("which replaced Ollama; Ollama has been uninstalled.");
	expect(data).toContain(sentence);
});
