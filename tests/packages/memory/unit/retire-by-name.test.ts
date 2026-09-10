import { describe, expect, it } from "vitest";
import { shortlistRetireByNameCandidates } from "../../../../apps/mem-claw/src/extraction/retire-by-name.ts";
import {
	PROFILE_SECTION_JUDGMENT_BINDINGS,
	PROFILE_SECTION_JUDGMENT_REGISTRATION_ENABLED,
} from "../../../../apps/mem-claw/src/extraction/profile-section-writer.ts";
import type { MemoryEntry } from "../../../../apps/mem-claw/src/shared/types.ts";

function entry(id: string, text: string): MemoryEntry {
	return {
		id,
		text,
		category: "episodic",
		projectId: "shortlist",
		importance: 0.5,
		timestamp: 1,
		timezone: "UTC",
		metadata: "{}",
		contentHash: id.padEnd(64, "0"),
		lane: "active",
	};
}

describe("retire-by-name shortlist", () => {
	it("loads the re-sealed profile judgment registration", () => {
		expect(PROFILE_SECTION_JUDGMENT_REGISTRATION_ENABLED).toBe(true);
		expect(PROFILE_SECTION_JUDGMENT_BINDINGS.promptSha256).toMatch(/^[0-9a-f]{64}$/u);
	});

	it("normalizes overlap by row length, excludes zero overlap, and caps at eight", () => {
		const retiredPosition = "The user prefers tea in morning meetings";
		const candidates = [
			entry("short", "The user prefers tea"),
			entry("long", "The user prefers tea and writes reports after long morning meetings at work"),
			entry("zero", "A dated train reached Portland"),
			...Array.from({ length: 8 }, (_, index) =>
				entry(
					`candidate-${index}`,
					`Tea appears beside unrelated alpha beta gamma delta epsilon zeta eta theta note ${index}`,
				),
			),
		];

		const result = shortlistRetireByNameCandidates(retiredPosition, candidates);

		expect(result).toHaveLength(8);
		expect(candidates.filter((candidate) => candidate.id !== "zero")).toHaveLength(10);
		expect(result[0]?.id).toBe("short");
		expect(result.map((candidate) => candidate.id)).not.toContain("zero");
		expect(result.findIndex((candidate) => candidate.id === "long")).toBeGreaterThan(0);
	});
});
