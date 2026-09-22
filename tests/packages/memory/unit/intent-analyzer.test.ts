import { describe, expect, it } from "vitest";
import { formatAtDepth } from "../../../../packages/memory/src/engine/retrieval/intent-analyzer";

describe("formatAtDepth", () => {
	it("renders the category without the project UUID", () => {
		const entry = {
			text: "  Alice attended a pottery class.  ",
			category: "episodic",
			projectId: "01a09816-034e-74d0-90be-e080cedf3a46",
		};
		const rendered = formatAtDepth(entry, 0.85, 0, {
			bm25Hit: true,
			reranked: true,
			eventDate: "2023-03-15",
			sanitize: (text) => text.trim(),
		});

		expect(rendered).not.toContain("01a09816-034e-74d0-90be-e080cedf3a46");
		expect(rendered).toBe(
			"- [episodic] [2023-03-15] Alice attended a pottery class. (85%, vector+BM25+reranked)",
		);
	});
});
