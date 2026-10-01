export const SUPPORTED_LOCALES = [
	"en",
	"de",
	"es",
	"fr",
	"zh",
	"zh-Hant",
	"ja",
	"ko",
	"ru",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

const SUPPORTED_SET = new Set<string>(SUPPORTED_LOCALES);

export function isSupportedLocale(value: string): value is Locale {
	return SUPPORTED_SET.has(value);
}
