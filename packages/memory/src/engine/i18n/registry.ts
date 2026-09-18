import { createLogger } from "@snoai/utils/logger";
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from "./locales";
import type { LocaleResources, Namespace } from "./res/_types";

const log = createLogger("sno-station-mem:i18n-registry");

type LocaleLoader = () => Promise<LocaleResources>;

const RES: Record<Locale, LocaleLoader> = {
	en: () => import("./res/en/index").then((m) => m.resources),
	de: () => import("./res/de/index").then((m) => m.resources),
	es: () => import("./res/es/index").then((m) => m.resources),
	fr: () => import("./res/fr/index").then((m) => m.resources),
	zh: () => import("./res/zh/index").then((m) => m.resources),
	"zh-Hant": () => import("./res/zh-Hant/index").then((m) => m.resources),
	ja: () => import("./res/ja/index").then((m) => m.resources),
	ko: () => import("./res/ko/index").then((m) => m.resources),
	ru: () => import("./res/ru/index").then((m) => m.resources),
};

const loadedCache = new Map<Locale, LocaleResources>();

/**
 * PARENT chain for graceful per-namespace fallback. P3/P4 may ship partial
 * bundles (e.g. `res/ja/extraction-prompts.ts` lands before the full ja
 * pattern set). When a namespace is missing on the primary locale, fall
 * up the chain rather than jumping straight to `en` — keeps closely-related
 * text (zh-Hant ↔ zh) instead of switching to English mid-conversation.
 *
 * Today every supported locale ships every namespace, so this chain is
 * dormant — but the test in §9 line 794 ("`t<NoiseNs>('ko', 'noise')`
 * returns en until `res/ko/noise.ts` is added") locks the contract.
 *
 * TODO(i18n P2): Flip async-safe production boundaries to `t()` once host
 * registration/extraction APIs expose locale-aware async call sites.
 */
const PARENT: Record<Locale, Locale> = {
	en: "en",
	de: "en",
	es: "en",
	fr: "en",
	zh: "en",
	"zh-Hant": "zh",
	ja: "en",
	ko: "en",
	ru: "en",
};

async function loadLocale(locale: Locale): Promise<LocaleResources> {
	const cached = loadedCache.get(locale);
	if (cached) return cached;
	const loader = RES[locale];
	try {
		const mod = await loader();
		loadedCache.set(locale, mod);
		return mod;
	} catch (error) {
		log.warn("locale resource load failed; falling back", { locale, error }, {
			event_name: "sno_station_mem.registry.locale.resource.load.failed.falling.back",
			file: "packages/sno-station-mem/src/engine/i18n/registry.ts",
			function: "loadLocale",
			site_id: "registry.loadLocale.aad78d489e",
		});
		if (locale === DEFAULT_LOCALE) {
			throw error;
		}
		return loadLocale(PARENT[locale]);
	}
}

function hasNamespace(resources: LocaleResources, namespace: Namespace): boolean {
	const value = resources[namespace];
	return value !== undefined && value !== null;
}

async function resolveNamespaceLocale(
	locale: Locale,
	namespace: Namespace,
): Promise<{ locale: Locale; resources: LocaleResources }> {
	let cursor: Locale = locale;
	const visited = new Set<Locale>();
	while (!visited.has(cursor)) {
		visited.add(cursor);
		const resources = await loadLocale(cursor);
		if (hasNamespace(resources, namespace)) {
			return { locale: cursor, resources };
		}
		const next = PARENT[cursor];
		if (next === cursor) break;
		cursor = next;
	}
	throw new Error(
		`i18n: namespace "${namespace}" missing on "${locale}" and every PARENT up to "${DEFAULT_LOCALE}"`,
	);
}

export async function t<N extends Namespace>(
	locale: Locale,
	namespace: N,
): Promise<LocaleResources[N]> {
	const { locale: effective, resources } = await resolveNamespaceLocale(locale, namespace);
	const namespaceResources = resources[namespace];
	if (!namespaceResources) {
		throw new Error(`i18n: namespace "${namespace}" missing on "${effective}"`);
	}
	return withFallback(namespaceResources, effective, namespace) as LocaleResources[N];
}

function mergeFlags(a: string, b: string): string {
	const aHasG = a.includes("g");
	const bHasG = b.includes("g");
	if (aHasG !== bHasG) {
		throw new Error(`i18n: cannot merge regex flags — mixed g flag (a="${a}" b="${b}")`);
	}
	const merged = new Set<string>([...a, ...b]);
	return Array.from(merged).join("");
}

export function combineAlt(parts: ReadonlyArray<RegExp>): RegExp {
	if (parts.length === 0) {
		throw new Error("i18n: combineAlt requires at least one regex");
	}
	const first = parts[0];
	if (!first) throw new Error("i18n: combineAlt parts[0] missing");
	if (parts.length === 1) return first;
	let flags = first.flags;
	const sources: string[] = [first.source];
	for (let i = 1; i < parts.length; i++) {
		const next = parts[i];
		if (!next) continue;
		flags = mergeFlags(flags, next.flags);
		sources.push(next.source);
	}
	return new RegExp(sources.map((s) => `(?:${s})`).join("|"), flags);
}

function withFallback<T extends object>(primary: T, locale: Locale, namespace: Namespace): T {
	return new Proxy(primary, {
		get(target, prop, receiver) {
			if (typeof prop !== "string") {
				return Reflect.get(target, prop, receiver);
			}
			if (Object.hasOwn(target, prop)) return Reflect.get(target, prop, receiver);
			// Thenable guard: awaiting a Proxy probes `then` (and `catch`/`finally`
			// in some toolchains). These are NOT on Object.prototype, so the
			// passthrough below would not cover them.
			if (prop === "then" || prop === "catch" || prop === "finally") {
				return Reflect.get(target, prop, receiver);
			}
			if (prop in Object.prototype) return Reflect.get(target, prop, receiver);
			throw new Error(
				`i18n: unknown key "${prop}" on namespace "${namespace}" (locale "${locale}")`,
			);
		},
	}) as T;
}

export function listSupportedLocales(): readonly Locale[] {
	return SUPPORTED_LOCALES;
}

export function clearLocaleCache(): void {
	loadedCache.clear();
}

export function getParentLocale(locale: Locale): Locale {
	return PARENT[locale];
}

/**
 * Test-only: invoke the static `RES[locale]` loader directly, bypassing
 * `loadLocale`'s PARENT-chain fallback. The bundler-probe integration test
 * needs this because `t()` and `loadLocale()` both swallow chunk-emission
 * failures by walking PARENT to en — that masks the exact bug class the
 * probe is meant to catch (a missing `() => import("./res/<loc>/index")`
 * chunk in the bundled output).
 *
 * Tree-shaken from the production bundle: no plugin source imports it
 * (verified post-bundle; the prefix is convention only — actual safety comes
 * from there being zero internal callers).
 */
export async function _loadLocaleStrictForTests(locale: Locale): Promise<LocaleResources> {
	return RES[locale]();
}
