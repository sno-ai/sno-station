import { LRUCache } from "lru-cache";
import { detectLocale } from "./detector";
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from "./locales";

const SHORT_TEXT_BYPASS_CHARS = 8;
const SESSION_ID_MAX_CHARS = 256;

interface CacheEntry {
	locale: Locale;
}

const sessionCache = new LRUCache<string, CacheEntry>({
	max: 1000,
	ttl: 1000 * 60 * 60 * 6,
});

function normalizeSessionId(sessionId: string | undefined): string | undefined {
	const trimmed = sessionId?.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > SESSION_ID_MAX_CHARS) return undefined;
	if (hasControlCharacter(trimmed)) return undefined;
	return trimmed;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

export interface ResolveLocaleInput {
	text: string;
	sessionId?: string;
	explicitLocale?: string;
}

export function resolveLocale({ text, sessionId, explicitLocale }: ResolveLocaleInput): Locale {
	if (explicitLocale && isSupportedLocale(explicitLocale)) {
		return explicitLocale;
	}

	if (!text || text.trim().length === 0) {
		return DEFAULT_LOCALE;
	}

	const cacheKey = normalizeSessionId(sessionId);
	const cached = cacheKey ? sessionCache.get(cacheKey) : undefined;
	if (cached) return cached.locale;

	if (!text || text.trim().length < SHORT_TEXT_BYPASS_CHARS) {
		return DEFAULT_LOCALE;
	}

	const detected = detectLocale(text);

	if (!detected) {
		return DEFAULT_LOCALE;
	}

	if (cacheKey) sessionCache.set(cacheKey, { locale: detected });
	return detected;
}

export function clearSessionLocaleCache(): void {
	sessionCache.clear();
}
