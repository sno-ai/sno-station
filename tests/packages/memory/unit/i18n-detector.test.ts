import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	detectLocale,
	detectorFallbackLocale,
	detectorHealth,
} from "../../../../packages/memory/src/engine/i18n/detector.ts";
import { SUPPORTED_LOCALES } from "../../../../packages/memory/src/engine/i18n/locales.ts";

const FIXTURE_DIR = fileURLToPath(new URL("../../../apps/mem-claw/i18n/fixtures/", import.meta.url));

function loadFixture(locale: string): string {
	return readFileSync(`${FIXTURE_DIR}${locale}.txt`, "utf8").trim();
}

describe("i18n detector — short-text and inline samples", () => {
	it("returns undefined for very short text (R1 short-text bypass)", () => {
		expect(detectLocale("hi")).toBeUndefined();
	});

	it("detects English on a long sentence", () => {
		const detected = detectLocale(
			"Hello, my name is Alice and I live in San Francisco.",
		);
		expect(detected).toBe("en");
	});

	it("exposes detector health for gateway health checks", () => {
		detectLocale("Hello, my name is Alice and I live in San Francisco.");
		const health = detectorHealth();
		expect(detectorFallbackLocale()).toBe("en");
		expect(health.ready || health.degraded).toBe(true);
		if (health.degraded) {
			expect(health.retryAfterMs).toBeGreaterThanOrEqual(0);
		}
	});

	it("returns zh for Simplified Chinese sample", () => {
		const detected = detectLocale("我今天去公园散步，天气真好，很喜欢这个季节。");
		expect(detected === "zh" || detected === "zh-Hant").toBe(true);
	});

	it("refines to zh-Hant when traditional-only chars dominate", () => {
		const detected = detectLocale(
			"我們今天去公園散步說話，這個關於識讀的議題很重要。",
		);
		expect(detected).toBe("zh-Hant");
	});
});

describe("i18n detector — 9-locale fixture matrix (PRD §9 line 776 + 799)", () => {
	// Each fixture is ≥100 codepoints, in the locale's natural script.
	// Fixtures live in tests/apps/mem-claw/i18n/fixtures/<locale>.txt
	// and are LLM-drafted pending native-speaker review (tracked per locale via
	// .github/CODEOWNERS). The detector must classify each one to its own code.
	for (const locale of SUPPORTED_LOCALES) {
		it(`detectLocale(<${locale} fixture>) === "${locale}"`, () => {
			const text = loadFixture(locale);
			expect([...text].length, `${locale}.txt below 100 codepoints`).toBeGreaterThanOrEqual(100);
			expect(detectLocale(text), `${locale} fixture misclassified`).toBe(locale);
		});
	}
});

// EldDetector shape contract (PRD §9 line 777) is asserted by the
// integration-layer bundler probe (i18n-bundler-probe.test.ts), where
// `eld/medium` resolves naturally inside the plugin's bundle. Adding a
// test-only re-export to src just to call eld from this file would leak API
// surface for no benefit — the bundler probe runs eld in a fresh Node child
// and is the canonical shape gate.
