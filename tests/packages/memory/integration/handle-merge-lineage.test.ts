/** Real codec round-trip over foundation metadata. No mocks. */

import { describe, expect, it } from "vitest";
import {
	appendLineage,
	buildInsightMetadata,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";

const BASE_TS = Date.UTC(2026, 4, 20, 12, 0, 0);

describe("handleMerge lineage helper", () => {
	it("appends multiple ids and caps the lineage at the configured boundary", () => {
		const prior = Array.from({ length: 32 }, (_, index) => `old-${index}`);

		const lineage = appendLineage(prior, ["new-raw", "new-merged"], 32);

		expect(lineage).toHaveLength(32);
		expect(lineage[0]).toBe("old-2");
		expect(lineage.slice(-2)).toEqual(["new-raw", "new-merged"]);
	});

	it("ignores malformed prior lineage and preserves multi-id append order", () => {
		expect(appendLineage("not-array", ["existing-row", "raw-row"], 32)).toEqual([
			"existing-row",
			"raw-row",
		]);
	});

	it("round-trips capped lineage through the insight metadata codec", () => {
		const metadata = stringifyInsightMetadata(
			buildInsightMetadata(
				{
					text: "Lesson: check the working directory before patching a missing path.",
					category: "lesson",
					timestamp: BASE_TS,
				},
				{
					kind: "lesson",
					memory_category: "lesson",
					asserted_at: BASE_TS,
					source: "manual",
					anti_pattern_signature: "missing-file-check-working-directory",
					merge_lineage: appendLineage(["existing-row"], ["raw-row"], 32),
				},
			),
		);

		const parsed = parseInsightMetadata(metadata, {
			text: "Lesson: check the working directory before patching a missing path.",
			category: "lesson",
			timestamp: BASE_TS,
		});

		expect(parsed.merge_lineage).toEqual(["existing-row", "raw-row"]);
	});
});
