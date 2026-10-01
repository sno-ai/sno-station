import type { Locale } from "./locales";
import type { LocaleResources } from "./res/_types";
import { resources as de } from "./res/de/index";
import { resources as en } from "./res/en/index";
import { resources as es } from "./res/es/index";
import { resources as fr } from "./res/fr/index";
import { resources as ja } from "./res/ja/index";
import { resources as ko } from "./res/ko/index";
import { resources as ru } from "./res/ru/index";
import { resources as zh } from "./res/zh/index";
import { resources as zhHant } from "./res/zh-Hant/index";

/**
 * Static union of every supported-locale's resource bundle.
 *
 * Step B re-exports source-file constants (capture/noise/adaptive/intent)
 * as the union over this list so legacy callers see the merged regex of
 * all 9 locales without an async `t(locale, ns)` call. Imports are static
 * so `MEMORY_TRIGGERS` etc. remain top-level constants.
 *
 * Order is canonical (en first, then alphabetical) but call sites must NOT
 * depend on order — `.some(p => p.test(s))` is the only contract.
 */
export const ALL_RESOURCES: ReadonlyArray<LocaleResources> = [
	en,
	de,
	es,
	fr,
	zh,
	zhHant,
	ja,
	ko,
	ru,
];

export const RESOURCES_BY_LOCALE: Record<Locale, LocaleResources> = {
	en,
	de,
	es,
	fr,
	zh,
	"zh-Hant": zhHant,
	ja,
	ko,
	ru,
};
