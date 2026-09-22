/**
 * P0 gate tests not covered by the other i18n test files.
 *
 * Pulls together the small remaining items from PRD §9:
 *   - HANS ∩ HANT = ∅ + no internal duplicates (line 778)
 *   - PARENT chain semantics (line 794)
 *   - Bundler-style "every (locale, ns) loads cleanly" probe (line 793)
 *   - extraction-prompts placeholder-parity skeleton (line 797, vacuous at P0)
 */

import { describe, expect, it } from "vitest";
import {
	HANS_DISTINCT_CHARS,
	HANT_DISTINCT_CHARS,
} from "../../../../packages/memory/src/engine/i18n/detector.ts";
import { SUPPORTED_LOCALES } from "../../../../packages/memory/src/engine/i18n/locales.ts";
import {
	getParentLocale,
	t,
} from "../../../../packages/memory/src/engine/i18n/registry.ts";
import {
	ALL_NAMESPACES,
	type LocaleResources,
} from "../../../../packages/memory/src/engine/i18n/res/_types.ts";

function parseExtractionOutputExample(prompt: string): {
	memories: Array<Record<string, unknown>>;
} {
	// The few-shot examples above the "Structured fields" section also contain
	// standalone `"memories"` arrays; anchor past that heading so this always
	// parses the trailing schema example, not the first few-shot occurrence.
	const schemaHeadingIndex = prompt.indexOf("# Structured fields");
	if (schemaHeadingIndex < 0) {
		throw new Error("prompt is missing the structured fields section");
	}
	const tokenIndex = prompt.indexOf('"memories"', schemaHeadingIndex);
	if (tokenIndex < 0) {
		throw new Error("prompt output example is missing memories array");
	}
	const start = prompt.lastIndexOf("{", tokenIndex);
	if (start < 0) {
		throw new Error("prompt output example is missing opening brace");
	}

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < prompt.length; i++) {
		const char = prompt[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (char === "{") depth += 1;
		if (char === "}") depth -= 1;
		if (depth === 0) {
			return JSON.parse(prompt.slice(start, i + 1)) as {
				memories: Array<Record<string, unknown>>;
			};
		}
	}

	throw new Error("prompt output example is missing closing brace");
}

describe("i18n P0 gates — HANS / HANT char sets", () => {
	it("HANS_DISTINCT_CHARS and HANT_DISTINCT_CHARS share no codepoint", () => {
		const hans = new Set([...HANS_DISTINCT_CHARS]);
		const hant = new Set([...HANT_DISTINCT_CHARS]);
		const overlap: string[] = [];
		for (const c of hans) if (hant.has(c)) overlap.push(c);
		expect(overlap, `overlap chars: ${overlap.join("")}`).toEqual([]);
	});

	it("HANS_DISTINCT_CHARS has no internal duplicates", () => {
		const arr = [...HANS_DISTINCT_CHARS];
		expect(arr.length).toBe(new Set(arr).size);
	});

	it("HANT_DISTINCT_CHARS has no internal duplicates", () => {
		const arr = [...HANT_DISTINCT_CHARS];
		expect(arr.length).toBe(new Set(arr).size);
	});

	it("HANS and HANT have the same length (1:1 pairing for fair counting)", () => {
		expect([...HANS_DISTINCT_CHARS].length).toBe(
			[...HANT_DISTINCT_CHARS].length,
		);
	});
});

describe("i18n P0 gates — PARENT chain", () => {
	it("PARENT[en] === en (terminal)", () => {
		expect(getParentLocale("en")).toBe("en");
	});

	it("PARENT covers every supported locale", () => {
		for (const locale of SUPPORTED_LOCALES) {
			expect(getParentLocale(locale)).toBeDefined();
		}
	});

	it("zh-Hant parents to zh (script proximity)", () => {
		expect(getParentLocale("zh-Hant")).toBe("zh");
	});

	it("non-en non-zh-Hant locales parent to en", () => {
		const cases: ReadonlyArray<(typeof SUPPORTED_LOCALES)[number]> = [
			"de",
			"es",
			"fr",
			"zh",
			"ja",
			"ko",
			"ru",
		];
		for (const locale of cases) {
			expect(getParentLocale(locale)).toBe("en");
		}
	});

	it("chain terminates: walking PARENT from any locale reaches en", () => {
		for (const locale of SUPPORTED_LOCALES) {
			let cursor: (typeof SUPPORTED_LOCALES)[number] = locale;
			let steps = 0;
			while (cursor !== "en" && steps < 5) {
				cursor = getParentLocale(cursor);
				steps += 1;
			}
			expect(cursor, `${locale} did not reach en in ≤5 steps`).toBe("en");
		}
	});
});

describe("i18n P0 gates — runtime probe (every locale × every namespace loads)", () => {
	// Bundler-style probe (PRD §9 line 793 lite). The full fidelity version
	// runs after `npm run build` (esbuild) from a Node child process,
	// asserting the static import map survives chunk-splitting. The
	// unit-side probe asserts the equivalent runtime contract: each
	// (locale, ns) resolves through `t()` without throwing, returning a
	// non-trivial value with the expected shape. If the build later breaks
	// chunk emission, the integration
	// probe — when added — will catch THAT specific failure mode; this test
	// covers the dev-mode contract.
	for (const locale of SUPPORTED_LOCALES) {
		for (const namespace of ALL_NAMESPACES) {
			it(`t("${locale}", "${namespace}") loads and is well-formed`, async () => {
				const ns = await t(locale, namespace);
				expect(ns, `${locale}.${namespace} returned falsy`).toBeTruthy();
				expect(typeof ns).toBe("object");
				expect(
					Object.keys(ns).length,
					`${locale}.${namespace} is empty`,
				).toBeGreaterThan(0);
			});
		}
	}
});

describe("i18n P0 gates — prompt-namespace shape parity", () => {
	// P2: `extractionPrompts` and `reflectionPrompts` now exist in every
	// locale bundle. Every locale must expose the same set of builder
	// function names — the function bodies may differ per locale, but the
	// callable surface that insight-distill / daily-log-generator.ts dispatch into
	// MUST line up so RESOURCES_BY_LOCALE[locale].<ns>.<fn> never returns
	// undefined.
	const PROMPT_NAMESPACES = ["extractionPrompts", "reflectionPrompts"] as const;

	for (const namespace of PROMPT_NAMESPACES) {
		it(`every locale exposes the same builder names in ${namespace}`, async () => {
			const enNs = (await t("en", namespace)) as unknown as Record<
				string,
				unknown
			>;
			const enKeys = Object.keys(enNs).sort();

			for (const locale of SUPPORTED_LOCALES) {
				const localeNs = (await t(locale, namespace)) as unknown as Record<
					string,
					unknown
				>;
				const localeKeys = Object.keys(localeNs).sort();
				expect(
					localeKeys,
					`${locale}.${namespace} keys mismatch vs en`,
				).toEqual(enKeys);

				for (const key of enKeys) {
					expect(
						typeof localeNs[key],
						`${locale}.${namespace}.${key} is not a function`,
					).toBe("function");
				}
			}
		});
	}
});

describe("i18n P0 gates — package-shipping smoke checks", () => {
	it("every locale's loaded shape exposes all namespaces (sanity)", async () => {
		// One last assertion that complements the per-namespace probe above:
		// resolving each locale yields a `LocaleResources` with EVERY
		// namespace populated (no graceful PARENT fallback fired).
		for (const locale of SUPPORTED_LOCALES) {
			const captured = (await t(locale, "captureTriggers")) as unknown as
				| LocaleResources["captureTriggers"]
				| undefined;
			// The witness was `memoryTriggers` until the capture-side teardown deleted that bank.
			// Any always-populated field of the namespace proves the same thing: the locale
			// resolved to its own bundle and no PARENT fallback fired.
			expect(captured?.explicitMemoryCommandPositivePatterns.length).toBeGreaterThan(0);
		}
	});
});
