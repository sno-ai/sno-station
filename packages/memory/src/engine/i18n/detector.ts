import { createLogger } from "@snoai/utils/logger";
import { eld } from "eld/medium";
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from "./locales";

const log = createLogger("sno-station-mem:i18n-detector");

// Any Han code point — used only as a "is there Chinese here at all" guard.
const HAS_HAN = /[一-鿿]/u;

// Hant-distinct characters whose Hans counterparts differ in code point. Used
// for frequency-based simplified-vs-traditional disambiguation. Keep paired
// with HANS_DISTINCT_RE — every entry here should have a 1:1 Hans counterpart
// in HANS_DISTINCT_RE for fair counting. Exported so an HANS ∩ HANT = ∅ unit
// test can guard against accidental overlap (PRD §9 line 778).
export const HANT_DISTINCT_CHARS = "說講識讀譯長寫關類體聖貝謊議證讓訊為";
export const HANS_DISTINCT_CHARS = "说讲识读译长写关类体圣贝谎议证让讯为";
const HANT_DISTINCT_RE = new RegExp(`[${HANT_DISTINCT_CHARS}]`, "gu");
const HANS_DISTINCT_RE = new RegExp(`[${HANS_DISTINCT_CHARS}]`, "gu");
const DETECTOR_RETRY_AFTER_MS = 60_000;

let detectorReady = false;
let detectorBroken = false;
let detectorRetryAtMs = 0;

function markDetectorBroken(error: unknown, reasonCode: string): void {
	detectorReady = false;
	detectorBroken = true;
	detectorRetryAtMs = Date.now() + DETECTOR_RETRY_AFTER_MS;
	log.warn("Language detector temporarily unavailable", {
		error, reason_code: reasonCode, retryAfterMs: DETECTOR_RETRY_AFTER_MS,
	}, {
		event_name: "language.detector.unavailable",
		file: "packages/sno-station-mem/src/engine/i18n/detector.ts",
		function: "markDetectorBroken",
		site_id: "language.detector.unavailable",
	});
}

function ensureDetector(): boolean {
	if (detectorBroken) {
		if (Date.now() < detectorRetryAtMs) return false;
		detectorBroken = false;
		detectorRetryAtMs = 0;
	}
	if (detectorReady) return true;
	try {
		eld.info();
		detectorReady = true;
		return true;
	} catch (error) {
		markDetectorBroken(error, "detector_initialization_failed");
		return false;
	}
}

function refineChinese(text: string): "zh" | "zh-Hant" {
	const hantMatches = text.match(HANT_DISTINCT_RE)?.length ?? 0;
	const hansMatches = text.match(HANS_DISTINCT_RE)?.length ?? 0;
	if (hantMatches > hansMatches) return "zh-Hant";
	return "zh";
}

export function detectLocale(text: string): Locale | undefined {
	if (!text || text.length < 4) return undefined;
	if (!ensureDetector()) return undefined;
	try {
		const result = eld.detect(text);
		const lang = result?.language;
		if (!lang) return undefined;
		if (lang === "zh") {
			if (HAS_HAN.test(text)) {
				return refineChinese(text);
			}
			return "zh";
		}
		if (isSupportedLocale(lang)) return lang;
		return undefined;
	} catch (error) {
		markDetectorBroken(error, "detector_detection_failed");
		return undefined;
	}
}

export function detectorFallbackLocale(): Locale {
	return DEFAULT_LOCALE;
}

export function detectorHealth(): {
	ready: boolean;
	degraded: boolean;
	retryAfterMs?: number;
} {
	if (!detectorBroken) {
		return { ready: detectorReady, degraded: false };
	}
	return {
		ready: false,
		degraded: true,
		retryAfterMs: Math.max(0, detectorRetryAtMs - Date.now()),
	};
}
