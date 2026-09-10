import { getCjkRatio } from "@snoai/chunking";
import { describe, expect, it } from "vitest";

describe("package-backed extraction text measurement", () => {
	it("uses package CJK ratio semantics", () => {
		expect(getCjkRatio("abc 中文")).toBeCloseTo(2 / 5, 12);
		expect(getCjkRatio(" \n\t")).toBe(0);
	});
});
