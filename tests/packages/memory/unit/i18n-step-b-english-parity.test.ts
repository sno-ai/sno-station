/** Keeps the surviving deterministic category mapping inside the canonical category set. */

import { describe, expect, it } from "vitest";
import { detectCategory } from "../../../../packages/sno-station-mem/src/engine/extraction/capture-policy-detector";
import { MEMORY_CATEGORIES } from "../../../../packages/sno-station-mem/src/engine/shared/types";

const ENGLISH_FIXTURES = [
	"my name is alice",
	"i prefer dark mode",
	"jane is the manager of the platform team",
	"we decided to migrate to postgres",
	"we learned to avoid manual cache flushes",
	"the database is postgres",
	"fresh hay near the barn",
];

describe("English category mapping", () => {
	it("recognizes canonical examples", () => {
		expect(detectCategory("my name is alice")).toBe("profile");
		expect(detectCategory("i prefer dark mode")).toBe("profile");
		expect(detectCategory("jane is the manager of the platform team")).toBe("episodic");
		expect(detectCategory("we decided to migrate to postgres")).toBe("episodic");
		expect(detectCategory("we learned to avoid manual cache flushes")).toBe("lesson");
	});

	it("only emits canonical categories", () => {
		for (const text of ENGLISH_FIXTURES) {
			const category = detectCategory(text);
			expect(category === undefined || MEMORY_CATEGORIES.includes(category)).toBe(true);
		}
	});

	it("does not invent a fallback category", () => {
		expect(detectCategory("fresh hay near the barn")).toBeUndefined();
	});

	it("strips OpenClaw metadata before category detection", () => {
		expect(
			detectCategory(
				"Conversation info (untrusted metadata):\nuser prefers noise\n\nfresh hay near the barn",
			),
		).toBeUndefined();
	});

	it("maps fact-like non-English text to a canonical category", () => {
		expect(
			detectCategory("El sistema es estable y tiene documentación suficiente para el equipo."),
		).toBe("episodic");
	});
});
