/** @file scope-identity.ts
 * @purpose Normalizes agent identities and configured access lists for scope policy.
 * @boundary Identity parsing, bypass detection, and config normalization only.
 */

import { createLogger } from "@snoai/utils/logger";

import { SCOPE_PATTERNS } from "./scope-policy-types";

const log = createLogger("sno-station-mem:scopes");

const SYSTEM_BYPASS_IDS = new Set(["system", "undefined"]);
const warnedLegacyFallbackBypassIds = new Set<string>();
const warnedLegacyStringBypassIds = new Set<string>();

export function normalizeExtraAccessibleScopes(
	extraAccessibleScopes: string[] | undefined,
): string[] {
	if (!Array.isArray(extraAccessibleScopes)) return [];
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const rawScope of extraAccessibleScopes) {
		if (typeof rawScope !== "string") continue;
		const scope = rawScope.trim();
		if (!scope || seen.has(scope)) continue;
		seen.add(scope);
		normalized.push(scope);
	}
	return normalized;
}

export function isSystemBypassId(agentId?: string): boolean {
	if (typeof agentId !== "string") return false;
	if (agentId === "undefined" && !warnedLegacyStringBypassIds.has(agentId)) {
		warnedLegacyStringBypassIds.add(agentId);
		log.warn("legacy string agentId bypass detected", { reason_code: "legacy_undefined_string" }, {
			event_name: "sno_station_mem.scope-identity.legacy.string.agentid.bypass.detected",
			file: "packages/sno-station-mem/src/engine/security/scope-identity.ts",
			function: "isSystemBypassId",
			site_id: "scope-identity.isSystemBypassId.1d89371f35",
		});
	}
	return SYSTEM_BYPASS_IDS.has(agentId);
}

/** @internal Exported for tests that need to reset legacy warning throttles. */
export function _resetLegacyFallbackWarningState(): void {
	warnedLegacyFallbackBypassIds.clear();
	warnedLegacyStringBypassIds.clear();
}

export function shouldWarnLegacyFallbackBypassId(agentId: string): boolean {
	if (warnedLegacyFallbackBypassIds.has(agentId)) return false;
	warnedLegacyFallbackBypassIds.add(agentId);
	return true;
}

export function parseAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
	if (!sessionKey) return undefined;
	const sk = sessionKey.trim();
	if (!sk.startsWith("agent:")) return undefined;
	const rest = sk.slice("agent:".length);
	const colonIdx = rest.indexOf(":");
	const candidate = (colonIdx === -1 ? rest : rest.slice(0, colonIdx)).trim();
	if (!candidate || isSystemBypassId(candidate)) return undefined;
	return candidate;
}

export function withOwnReflectionScope(scopes: string[], agentId: string): string[] {
	const reflectionScope = SCOPE_PATTERNS.REFLECTION(agentId);
	return scopes.includes(reflectionScope) ? [...scopes] : [...scopes, reflectionScope];
}

export function normalizeAgentAccessMap(
	agentAccess: Record<string, string[]> | undefined,
): Record<string, string[]> {
	const normalized: Record<string, string[]> = {};
	if (!agentAccess) return normalized;
	for (const [rawAgentId, scopes] of Object.entries(agentAccess)) {
		const agentId = rawAgentId.trim();
		if (!agentId) continue;
		normalized[agentId] = Array.isArray(scopes) ? [...scopes] : [];
	}
	return normalized;
}
