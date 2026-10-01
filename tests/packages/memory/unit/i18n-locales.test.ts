import { describe, expect, it } from "vitest";
import {
	DEFAULT_LOCALE,
	isSupportedLocale,
	SUPPORTED_LOCALES,
} from "../../../../packages/memory/src/engine/i18n/locales.ts";

describe("i18n locales", () => {
	it("includes the 9 P0 locales", () => {
		expect([...SUPPORTED_LOCALES]).toEqual([
			"en",
			"de",
			"es",
			"fr",
			"zh",
			"zh-Hant",
			"ja",
			"ko",
			"ru",
		]);
	});

	it("default locale is en", () => {
		expect(DEFAULT_LOCALE).toBe("en");
	});

	it("isSupportedLocale narrows known codes", () => {
		expect(isSupportedLocale("en")).toBe(true);
		expect(isSupportedLocale("zh-Hant")).toBe(true);
		expect(isSupportedLocale("xx")).toBe(false);
		expect(isSupportedLocale("")).toBe(false);
	});
});
