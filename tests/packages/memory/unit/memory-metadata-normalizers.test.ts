import { describe, expect, it } from "vitest";
import { deriveDefaultLayer } from "../../../../packages/memory/src/engine/extraction/memory-metadata-normalizers.ts";

describe("memory metadata normalizers", () => {
	it("defaults confirmed summary memories to the reflection layer", () => {
		expect(deriveDefaultLayer("manual", "summary", "confirmed")).toBe("reflection");
	});
});
