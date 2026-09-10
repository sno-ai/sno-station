/** Proves code, not the model, owns surviving B-profile addresses. */

import { describe, expect, it } from "vitest";
import { projectProfileCandidates } from "@/extraction/b-profile-projection";

describe("B-profile address ownership", () => {
	it("addresses all candidates from the dictionary", () => {
		const result = projectProfileCandidates({
			profile_candidates: [
				{
					slug: "preference.accommodation",
					topic_phrase: "answer length",
					payload: { likes: ["three tight bullets"], dislikes: [] },
				},
				{
					slug: "preference.accommodation",
					topic_phrase: "status updates",
					payload: { likes: ["async written notes"], dislikes: [] },
				},
			],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.dropped).toEqual({});
		expect(result.memories.map((memory) => memory.section_name).sort()).toEqual([
			"preferences.answer_length",
			"preferences.status_updates",
		]);
		expect(result.memories.map((memory) => memory.rawTopicPhrase).sort()).toEqual([
			"answer length",
			"status updates",
		]);
		expect(result.memories.map((memory) => memory.section_name)).not.toContain("identity");
	});
});
