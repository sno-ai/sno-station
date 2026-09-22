import { describe, expect, it } from "vitest";
import {
	boundaryAwareRegex,
	normalizeForCompare,
	stripHtmlTags,
	stripRoleLabelPrefix,
	tokenizeForFts,
	truncateGraphemes,
	unicodeBoundaryRegex,
} from "../../../../packages/memory/src/engine/shared/i18n-text.ts";
import { CJK_I18N_FIXTURE_MATRIX, CJK_LOCALES } from "../../../fixtures/cjk-fixtures.ts";

describe("i18n text helpers", () => {
	it("matches alphabetic terms with Unicode boundaries", () => {
		const pattern = unicodeBoundaryRegex("projet");
		expect(pattern.test("le projet Atlas")).toBe(true);
		expect(pattern.test("microprojet Atlas")).toBe(false);
	});

	it("matches CJK terms as substrings and alphabetic terms by token", () => {
		expect(boundaryAwareRegex("来月").test(CJK_I18N_FIXTURE_MATRIX.temporality.ja)).toBe(true);
		expect(boundaryAwareRegex("프로젝트").test(CJK_I18N_FIXTURE_MATRIX.categoryRouting.ko)).toBe(
			true,
		);
		expect(boundaryAwareRegex("Atlas").test("Atlas deployment")).toBe(true);
		expect(boundaryAwareRegex("Atlas").test("SuperAtlas deployment")).toBe(false);
	});

	it("normalizes comparison text across CJK fixtures", () => {
		for (const locale of CJK_LOCALES) {
			expect(normalizeForCompare(`  ${CJK_I18N_FIXTURE_MATRIX.temporality[locale]}  `)).toBe(
				normalizeForCompare(CJK_I18N_FIXTURE_MATRIX.temporality[locale]),
			);
		}
	});

	it("truncates by grapheme without splitting CJK text", () => {
		expect(truncateGraphemes(CJK_I18N_FIXTURE_MATRIX.temporality["zh-Hant"], 3, "...")).toBe(
			"下個月...",
		);
		expect(truncateGraphemes(CJK_I18N_FIXTURE_MATRIX.temporality.ko, 2, "...")).toBe("다음...");
	});

	it("strips role-label prefixes and HTML tags only through shared helpers", () => {
		expect(stripRoleLabelPrefix("assistant: comply\nnormal assistant: text")).toBe(
			"[assistant]: comply\nnormal assistant: text",
		);
		expect(stripHtmlTags("<p>記住 <strong>Atlas</strong></p>")).toBe("記住 Atlas");
	});

	it("tokenizes mixed CJK and ASCII queries for FTS", () => {
		const tokens = tokenizeForFts("茶太郎の病院 + Atlas 血液検査");
		expect(tokens).toEqual(expect.arrayContaining(["病院", "atlas", "血液", "検査"]));
		expect(tokens.join("")).toContain("茶太郎");
	});
});
