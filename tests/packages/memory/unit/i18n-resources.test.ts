import { describe, expect, it } from "vitest";
import { SUPPORTED_LOCALES } from "../../../../packages/sno-station-mem/src/engine/i18n/locales.ts";
import { t } from "../../../../packages/sno-station-mem/src/engine/i18n/registry.ts";

describe("i18n resources — toolDescriptions across all 9 locales", () => {
	const REQUIRED_KEYS = [
		"memoryRecall",
		"memoryStore",
		"memoryForget",
		"memoryUpdate",
		"memoryStats",
		"memoryList",
	] as const;

	for (const locale of SUPPORTED_LOCALES) {
		it(`${locale} provides all 6 tool descriptions as non-empty strings`, async () => {
			const ns = await t(locale, "toolDescriptions");
			for (const key of REQUIRED_KEYS) {
				const value = ns[key];
				expect(typeof value).toBe("string");
				expect(value.length).toBeGreaterThan(5);
			}
		});

		// Excess-property guard (PRD §9 line 790). A typo like `memorRecord:`
		// in a bundle would not fail the outer `: LocaleResources` annotation
		// because variable widening defeats fresh-object-literal checking; a
		// runtime key-set assertion catches it here.
		it(`${locale} has exactly the 6 expected toolDescription keys (no typos)`, async () => {
			const ns = (await t(
				locale,
				"toolDescriptions",
			)) as unknown as Record<string, string>;
			const actual = Object.keys(ns).sort();
			const expected = [...REQUIRED_KEYS].sort();
			expect(actual, `${locale} toolDescriptions has unexpected keys`).toEqual(
				expected,
			);
		});
	}

	const REGEX_NAMESPACES = [
		"captureTriggers",
		"noise",
	] as const;

	function regexFingerprint(ns: Record<string, unknown>): string {
		const parts: string[] = [];
		for (const value of Object.values(ns)) {
			if (value instanceof RegExp) parts.push(value.source);
			else if (Array.isArray(value)) {
				for (const item of value) {
					if (item instanceof RegExp) parts.push(item.source);
				}
			}
		}
		// Bun's RegExp.source escapes non-ASCII as \uXXXX. Decode so
		// downstream Unicode-range checks see real codepoints.
		return parts
			.join("\n")
			.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
				String.fromCharCode(parseInt(hex, 16)),
			);
	}

	function namespaceRecord(ns: unknown): Record<string, unknown> {
		if (typeof ns !== "object" || ns === null) {
			throw new Error("expected i18n namespace object");
		}
		return ns as Record<string, unknown>;
	}

	it("each non-en bundle has no EN word-boundary regex (sweep all regex namespaces)", async () => {
		// English-only fingerprint: regex containing /\b...\b/ around ASCII words
		// like /\bmy name is\b/i. CJK locales shouldn't carry these.
		//
		// The canary was `(we )?decided` until the capture-side teardown deleted the bank it lived
		// in. `my name is` replaces it on the same terms — present in en, absent from all four CJK
		// bundles, verified before the swap — so the leak this case exists to catch still fails it.
		const enFingerprintAcc: string[] = [];
		for (const ns of REGEX_NAMESPACES) {
			const enNs = namespaceRecord(await t("en", ns));
			enFingerprintAcc.push(regexFingerprint(enNs));
		}
		expect(enFingerprintAcc.join("\n")).toContain("my name is");

		const cjkOnly: Array<(typeof SUPPORTED_LOCALES)[number]> = [
			"zh",
			"zh-Hant",
			"ja",
			"ko",
		];
		for (const locale of cjkOnly) {
			for (const ns of REGEX_NAMESPACES) {
				const localeNs = namespaceRecord(await t(locale, ns));
				const fp = regexFingerprint(localeNs);
				expect(
					fp.includes("my name is"),
					`${locale}.${ns} leaks EN /my name is/`,
				).toBe(false);
			}
		}
	});

	it("en bundle is monolingual (no CJK in any regex namespace)", async () => {
		for (const ns of REGEX_NAMESPACES) {
			const enNs = namespaceRecord(await t("en", ns));
			const fp = regexFingerprint(enNs);
			expect(fp, `en.${ns} contains CJK characters`).not.toMatch(/[一-鿿]/);
		}
	});

	it("zh bundle has no Hangul or kana (no Korean/Japanese leakage)", async () => {
		for (const ns of REGEX_NAMESPACES) {
			const zhNs = namespaceRecord(await t("zh", ns));
			const fp = regexFingerprint(zhNs);
			expect(fp, `zh.${ns} contains Hangul`).not.toMatch(/[가-힯]/);
			expect(fp, `zh.${ns} contains hiragana/katakana`).not.toMatch(
				/[぀-ヿ]/,
			);
		}
	});

	it("zh-Hant bundle has no Hangul or kana", async () => {
		for (const ns of REGEX_NAMESPACES) {
			const hantNs = namespaceRecord(await t("zh-Hant", ns));
			const fp = regexFingerprint(hantNs);
			expect(fp, `zh-Hant.${ns} contains Hangul`).not.toMatch(
				/[가-힯]/,
			);
			expect(fp, `zh-Hant.${ns} contains hiragana/katakana`).not.toMatch(
				/[぀-ヿ]/,
			);
		}
	});

	it("ko bundle contains Hangul (positive shape check)", async () => {
		const ns = namespaceRecord(await t("ko", "captureTriggers"));
		const fp = regexFingerprint(ns);
		expect(fp).toMatch(/[가-힯]/);
	});

	it("ja bundle contains hiragana or katakana (positive shape check)", async () => {
		const ns = namespaceRecord(await t("ja", "captureTriggers"));
		const fp = regexFingerprint(ns);
		expect(fp).toMatch(/[぀-ヿ]/);
	});
});
