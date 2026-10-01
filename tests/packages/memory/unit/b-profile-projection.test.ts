import { describe, expect, it } from "vitest";
import { projectProfileCandidates } from "../../../../packages/memory/src/engine/extraction/b-profile-projection.ts";
import { normalizeTopicToSectionName } from "../../../../packages/memory/src/engine/extraction/b-profile-section-registry.ts";
import {
	buildInsightMetadata,
	parseInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";


function totalDrops(dropped: Record<string, number>): number {
	return Object.values(dropped).reduce((total, count) => total + count, 0);
}

describe("B-profile projection", () => {
	it("projects one candidate per payload family to its derived section", () => {
		// Replaces the Python golden-vector case. That fixture's inputs all carried a `section`
		// field the contract deleted, and its generator — a Python renderer pinned to a git rev —
		// cannot be re-run from here, so the vectors could not be regenerated in the new shape.
		// What is lost is cross-language parity with that renderer; what is kept, and is the
		// reason the vectors existed, is that each family lands on the right section with the
		// right wire fields.
		const result = projectProfileCandidates({
			profile_candidates: [
				{
					slug: "preference.accommodation",
					topic_phrase: "response length",
					payload: { likes: ["three tight bullets"], dislikes: ["long preambles"] },
				},
				{
					slug: "identity.name",
					topic_phrase: "who they are",
					payload: { value: "Larry Hope, who builds memory systems", notes: null },
				},
				{
					slug: "entity.person",
					topic_phrase: "their dentist",
					payload: { kind: "person", name: "Dr Chen", relationship: "dentist", notes: null },
				},
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.memories.map((memory) => memory.section_name.split(".")[0])).toEqual([
			"preferences",
			"identity",
			"entities",
		]);
		expect(result.memories.map((memory) => memory.lane)).toEqual([
			"active",
			"active",
			"parked",
		]);
		expect(result.memories[0]?.content).toBe(
			"The user likes three tight bullets. The user dislikes long preambles.",
		);
		expect(result.memories[1]?.content).toBe("Larry Hope, who builds memory systems");
	});

	it.each([null, [], "not an object", {}, { memories: [] }])(
		"returns a typed validation error for malformed payload %#",
		(input) => {
			const result = projectProfileCandidates(input);
			expect(result).toMatchObject({
				ok: false,
				error: { code: "INVALID_B_PROFILE_PAYLOAD" },
			});
		},
	);

	it("keeps dislike polarity distinct at word boundaries", () => {
		const result = projectProfileCandidates({
			profile_candidates: [
				{
					slug: "trait.collaboration",
					topic_phrase: "meeting style",
					payload: { likes: [], dislikes: ["meetings before 10am"] },
				},
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const content = result.memories[0]?.content ?? "";
		expect(content).toMatch(/\bdislikes\b/);
		expect(content).not.toMatch(/\blikes\b/);
	});

	it("normalizes known synonyms and sends unknown topics to the general bucket", () => {
		expect(normalizeTopicToSectionName("response length")).toBe("preferences.answer_length");
		expect(normalizeTopicToSectionName("preferred response length for reports")).toBe(
			"preferences.answer_length",
		);
		expect(normalizeTopicToSectionName("quantum basket weaving")).toBe("preferences.general");
	});

	it("reroutes a preference candidate whose topic collides with a frozen entity section", () => {
		const result = projectProfileCandidates({
			profile_candidates: [
				{
					slug: "preference.accommodation",
					topic_phrase: "project",
					payload: { likes: ["Apollo"], dislikes: [] },
				},
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.memories).toHaveLength(1);
		expect(result.memories[0]).toMatchObject({
			section_name: "preferences.general",
			fact_key: "preferences.general",
			rawTopicPhrase: "project",
		});
		expect(result.dropped).toEqual({ preference_topic_generalized: 1 });
	});

	it("keeps a preference topic that only substring-collides with a short entity synonym", () => {
		const result = projectProfileCandidates({
			profile_candidates: [
				{
					slug: "preference.music",
					topic_phrase: "personal music taste",
					payload: { likes: ["indie folk and vinyl records"], dislikes: [] },
				},
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.memories).toHaveLength(1);
		expect(result.memories[0]?.section_name).toMatch(/^preferences\./);
		expect(result.dropped).toEqual({});
	});

	it("reroutes a preference candidate that is missing a topic phrase to the general bucket", () => {
		const result = projectProfileCandidates({
			profile_candidates: [
				{
					slug: "preference.accommodation",
					payload: { likes: ["late-night deep work"], dislikes: [] },
				},
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.memories).toHaveLength(1);
		expect(result.memories[0]?.section_name).toBe("preferences.general");
		expect(result.dropped).toEqual({ preference_topic_generalized: 1 });
	});

	it("carries the raw topic phrase and no evidence field at all", () => {
		const result = projectProfileCandidates({
			profile_candidates: [
				{
					slug: "preference.accommodation",
					topic_phrase: "  response length  ",
					payload: { likes: ["three tight bullets"], dislikes: [] },
				},
				{
					slug: "identity.name",
					payload: { value: "a nurse on the night shift", notes: null },
				},
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.memories[0]).toMatchObject({ rawTopicPhrase: "  response length  " });
		expect(result.memories[1]).not.toHaveProperty("rawTopicPhrase");
		// The contract has no evidence field. A record that grew one back would mean the position
		// machinery had returned, and the deployed adapter answered "1" to 60 of 60 position
		// probes — there was never a truthful value to carry.
		for (const memory of result.memories) {
			expect(memory).not.toHaveProperty("evidence");
		}
	});

	it("strips model-owned address fields, keeps content, and counts the contract violation", () => {
		const forbiddenFields = ["section_name", "fact_key", "skills", "active_tasks"];
		const result = projectProfileCandidates({
			profile_candidates: forbiddenFields.flatMap((field) => [
				{
					slug: "preference.accommodation",
					topic_phrase: "response length",
					payload: { likes: ["brief answers"], dislikes: [] },
					[field]: "model-owned",
				},
				{
					slug: "identity.name",
					payload: { value: "a nurse on the night shift", notes: null, [field]: "model-owned" },
				},
			]),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.memories).toHaveLength(forbiddenFields.length * 2);
		expect(result.memories.every((memory) => memory.lane === "active")).toBe(true);
		expect(totalDrops(result.dropped)).toBe(forbiddenFields.length * 2);
		expect(Object.keys(result.dropped).length).toBeGreaterThan(0);
	});

	it("round-trips optional rawTopicPhrase metadata on profile rows", () => {
		const metadata = buildInsightMetadata(
			{
				text: "The user likes short answers.",
				category: "profile",
				timestamp: 1_750_000_000_000,
			},
			{
				section_name: "preferences.general",
				rawTopicPhrase: "response shape",
			},
		);
		expect(metadata.kind).toBe("profile");
		if (metadata.kind !== "profile") return;
		expect(metadata.rawTopicPhrase).toBe("response shape");

		const parsed = parseInsightMetadata(JSON.stringify(metadata), { category: "profile" });
		expect(parsed.kind).toBe("profile");
		if (parsed.kind !== "profile") return;
		expect(parsed.rawTopicPhrase).toBe("response shape");
	});

	// The bodies below are verbatim replies from the deployed b-profile adapter, captured from
	// https://rt3-llm.sno.ai/extract/profile/v1/completions on 2026-09-03. A keyed card's value is
	// as short as the fact it states; the free-text 10-code-point floor that used to guard this
	// lane quarantined every one of them, so the adapter's best-scoring family stored nothing a
	// reader could see.
	it.each([
		[
			"Berlin",
			{
				slug: "identity.location",
				topic_phrase: "Berlin",
				payload: { notes: null, value: "Berlin" },
			},
			"Berlin",
		],
		[
			"台北",
			{
				slug: "identity.location",
				topic_phrase: "工作地点",
				payload: { notes: null, value: "台北" },
			},
			"台北",
		],
		[
			"软件工程师",
			{
				slug: "identity.occupation",
				topic_phrase: "职业",
				payload: { notes: null, value: "软件工程师" },
			},
			"软件工程师",
		],
	] as const)("stores the short identity value %s active rather than quarantining it", (
		_label,
		candidate,
		expectedAbstract,
	) => {
		const result = projectProfileCandidates({ profile_candidates: [candidate] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.memories).toHaveLength(1);
		expect(result.memories[0]).toMatchObject({
			category: "profile",
			section_name: "identity",
			abstract: expectedAbstract,
			content: expectedAbstract,
			lane: "active",
			slug: candidate.slug,
		});
		expect(totalDrops(result.dropped)).toBe(0);
		expect(result.dispositions).toEqual([]);
	});

	it("still refuses an identity card whose value is empty", () => {
		const result = projectProfileCandidates({
			profile_candidates: [
				{ slug: "identity.location", topic_phrase: "Berlin", payload: { notes: null, value: "   " } },
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.memories).toHaveLength(1);
		expect(result.memories[0]).toMatchObject({
			section_name: "identity",
			lane: "quarantined",
			dispositionReason: "payload_not_renderable",
		});
		expect(result.memories[0]).not.toHaveProperty("slug");
		expect(result.dropped).toMatchObject({ payload_not_renderable: 1 });
	});
});
