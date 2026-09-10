import { describe, expect, it } from "vitest";
import { extractAutoRecallQuery } from "../../../../apps/mem-claw/src/plugin/openclaw-auto-recall-hook.ts";

describe("extractAutoRecallQuery", () => {
	it("uses only the benchmark question when the LoCoMo harness adds answer rules", () => {
		const prompt = [
			"Question: When did Caroline meet up with her friends, family, and mentors?",
			"",
			"You are answering a benchmark question about a user's long-term memory.",
			"Use the retrieved memories and follow these rules.",
		].join("\n");

		expect(extractAutoRecallQuery(prompt)).toBe(
			"When did Caroline meet up with her friends, family, and mentors?",
		);
	});

	it("leaves ordinary prompts unchanged", () => {
		const prompt = "Question: Can you summarize my last project notes?";

		expect(extractAutoRecallQuery(prompt)).toBe(prompt);
	});
});
