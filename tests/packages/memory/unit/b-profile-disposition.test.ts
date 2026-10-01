import { describe, expect, it } from "vitest";
import {
	B_PROFILE_DISPOSITION_BY_REASON,
	B_PROFILE_DROP_REASONS,
	projectProfileCandidates,
} from "../../../../packages/memory/src/engine/extraction/b-profile-projection.ts";

describe("B-profile disposition table", () => {
	it("maps every projection drop reason to exactly one closed disposition", () => {
		// The list is asserted whole, not sampled: a reason added without a disposition is a
		// candidate whose fate nothing decides, and the pair is what the audit trail reads.
		expect(B_PROFILE_DROP_REASONS).toEqual([
			"candidate_not_object",
			"payload_not_object",
			"entity_capability_parked",
			"slug_not_in_vocabulary",
			"payload_shape_mismatch",
			"code_owned_fields_stripped",
			"preference_topic_generalized",
			"payload_not_renderable",
		]);
		expect(Object.keys(B_PROFILE_DISPOSITION_BY_REASON).sort()).toEqual(
			[...B_PROFILE_DROP_REASONS].sort(),
		);
		for (const reason of B_PROFILE_DROP_REASONS) {
			expect(B_PROFILE_DISPOSITION_BY_REASON[reason]).toMatch(
				/^(discard-after-retry|parked|quarantined|strip-and-continue)$/,
			);
		}
	});

	it.each([
		["candidate_not_object", null, "discard-after-retry"],
		[
			"payload_not_object",
			{ slug: "trait.collaboration", topic_phrase: "meeting style", payload: null },
			"discard-after-retry",
		],
		[
			"entity_capability_parked",
			{
				slug: "entity.organization",
				topic_phrase: "their gym",
				payload: { kind: "organization", name: "Sno Fitness", relationship: null, notes: null },
			},
			"parked",
		],
		[
			"slug_not_in_vocabulary",
			{
				slug: "quantum.basket_weaving",
				topic_phrase: "basket weaving",
				payload: { value: "durable detail about the user", notes: null },
			},
			"quarantined",
		],
		[
			// The slug names the trait family, whose payload is a likes/dislikes pair. A
			// value/notes payload is a different family's shape and cannot be rendered as this one.
			"payload_shape_mismatch",
			{
				slug: "trait.collaboration",
				topic_phrase: "meeting style",
				payload: { value: "prefers async", notes: null },
			},
			"quarantined",
		],
		[
			"code_owned_fields_stripped",
			{
				slug: "preference.music",
				topic_phrase: "music",
				payload: { likes: ["indie folk"], dislikes: [], fact_key: "model-owned" },
			},
			"strip-and-continue",
		],
		[
			"preference_topic_generalized",
			{
				slug: "preference.accommodation",
				topic_phrase: "quantum basket weaving",
				payload: { likes: ["short loops"], dislikes: [] },
			},
			"strip-and-continue",
		],
		[
			"payload_not_renderable",
			{
				slug: "preference.accommodation",
				topic_phrase: "lodging",
				payload: { likes: [], dislikes: [] },
			},
			"quarantined",
		],
	] as const)("routes %s without losing the raw candidate", (reason, candidate, disposition) => {
		const result = projectProfileCandidates({ profile_candidates: [candidate] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.dispositions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason, disposition, rawCandidateJson: expect.any(String) }),
			]),
		);
	});

	it("parks entities under the producer payload kind rather than a free-form topic", () => {
		const result = projectProfileCandidates({
			profile_candidates: [
				{
					slug: "entity.place",
					topic_phrase: "the Orion office",
					payload: { kind: "place", name: "Orion House", relationship: null, notes: null },
				},
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.memories[0]).toMatchObject({
			section_name: "entities.place",
			lane: "parked",
			dispositionReason: "entity_capability_parked",
		});
	});
});
