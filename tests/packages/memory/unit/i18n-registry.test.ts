import { describe, expect, it } from "vitest";
import { combineAlt } from "../../../../apps/mem-claw/src/i18n/registry.ts";

describe("i18n registry — combineAlt", () => {
	it("returns single regex unchanged", () => {
		const re = /foo/i;
		expect(combineAlt([re])).toBe(re);
	});

	it("merges identical flags", () => {
		const merged = combineAlt([/abc/g, /xyz/g]);
		expect(merged.flags).toBe("g");
		expect("abc xyz".match(merged)?.length ?? 0).toBeGreaterThan(0);
	});

	it("unions flag sets that don't conflict on g", () => {
		const merged = combineAlt([/abc/i, /xyz/u]);
		expect(merged.flags.split("").sort().join("")).toBe("iu");
	});

	it("throws on mixed g / non-g", () => {
		expect(() => combineAlt([/abc/g, /xyz/])).toThrow(/g flag/);
	});

	it("preserves alternation semantics on real text", () => {
		const a = /cat/;
		const b = /dog/;
		const merged = combineAlt([a, b]);
		expect(merged.test("the cat sat")).toBe(true);
		expect(merged.test("the dog sat")).toBe(true);
		expect(merged.test("the bird sat")).toBe(false);
	});

	it("throws on empty input", () => {
		expect(() => combineAlt([])).toThrow();
	});
});
