import { describe, expect, it } from "vitest";
import { projectProfileCandidates } from "../../../../packages/sno-station-mem/src/engine/extraction/b-profile-projection.ts";

/**
 * The causal proof for the slug-addressing repair.
 *
 * The deployed adapter emits `slug`; projection reads `section`, which that reply never
 * carries, so every candidate takes the unregistered-section branch and is filed
 * quarantined — invisible to the default read path. This case fails on that behaviour today
 * and passes once the section is derived from the slug's family prefix.
 *
 * It lives in its own file rather than inside the projection suite because that suite is
 * rewritten by the same change; the evidence this case produced has to stay legible
 * afterwards.
 */
const LIVE_REPLY = {
	profile_candidates: [
		{
			evidence: ["0"],
			payload: { dislikes: [], likes: ["controlled vocabulary", "structured data input"] },
			slug: "trait.communication",
			topic_phrase: "data precision",
		},
	],
};

describe("B-profile slug addressing", () => {
	it("files a slug-addressed candidate active, under the family its slug names", () => {
		const result = projectProfileCandidates(LIVE_REPLY);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Captured from the production route on 2026-08-18: `trait.communication` is in the
		// `trait` family, which the contract's family table maps to `preferences`. The family is
		// asserted, not the leaf, because the leaf is a naming decision this repair does not make.
		const [record] = result.memories;
		expect(record?.lane).toBe("active");
		expect(record?.section_name.split(".")[0]).toBe("preferences");
		expect(result.dropped.section_not_registered).toBeUndefined();
	});
});
