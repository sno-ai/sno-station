/** @file reflection-slice-loader.ts
 * @purpose Loads and caches reflection slices for prompt injection.
 */

import {
	DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS,
	REFLECTION_MAX_DERIVED,
	REFLECTION_MAX_INVARIANTS,
	REFLECTION_SLICE_CACHE_TTL_MS,
} from "../../../config/index";
import {
	loadAgentReflectionSlicesFromEntries,
	type LoadedReflectionSlices,
	type ReflectionLineSource,
} from "./memory-entry-projector";
import type { createScopePolicy } from "../security/scopes";
import { setLruEntry, touchLruEntry } from "../shared/lru";
import type { MemoryStore } from "../../store/store";

interface ReflectionSliceCacheEntry {
	updatedAt: number;
	invariants: string[];
	derived: string[];
	invariantSources: ReflectionLineSource[];
	derivedSources: ReflectionLineSource[];
}

export interface ReflectionSliceLoader {
	loadAgentReflectionSlices: (
		agentId: string,
		projectIdFilter: string[],
	) => Promise<LoadedReflectionSlices>;
	clearAll: () => void;
	clearAgent: (agentId: string) => void;
}

export function createReflectionSliceLoader(params: {
	store: MemoryStore;
	scopePolicy: ReturnType<typeof createScopePolicy>;
}): ReflectionSliceLoader {
	const reflectionSliceCache = new Map<string, ReflectionSliceCacheEntry>();

	async function loadAgentReflectionSlices(
		agentId: string,
		projectIdFilter: string[],
	): Promise<LoadedReflectionSlices> {
		const effectiveScopes =
			agentId !== "main"
				? (() => {
						const mainScope = params.scopePolicy.getDefaultScope("main");
						return projectIdFilter.includes(mainScope)
							? projectIdFilter
							: [...projectIdFilter, mainScope];
					})()
				: projectIdFilter;
		const cacheKey = `${agentId}::${[...effectiveScopes].sort().join(",")}`;
		const cached = touchLruEntry(reflectionSliceCache, cacheKey);
		if (cached && Date.now() - cached.updatedAt < REFLECTION_SLICE_CACHE_TTL_MS) return cached;
		if (cached) reflectionSliceCache.delete(cacheKey);

		const allEntries: Awaited<ReturnType<typeof params.store.list>> = [];
		for (const scope of effectiveScopes) {
			const recent = await params.store.list({ projectId: scope, limit: 240 });
			allEntries.push(...recent);
		}

		const slices = loadAgentReflectionSlicesFromEntries({
			entries: allEntries,
			agentId,
		});
		const next = {
			updatedAt: Date.now(),
			invariants: slices.invariants.slice(0, REFLECTION_MAX_INVARIANTS),
			derived: slices.derived.slice(0, REFLECTION_MAX_DERIVED),
			invariantSources: limitSources(slices.invariantSources, REFLECTION_MAX_INVARIANTS),
			derivedSources: limitSources(slices.derivedSources, REFLECTION_MAX_DERIVED),
		};
		setLruEntry(reflectionSliceCache, cacheKey, next, DEFAULT_REFLECTION_MAX_TRACKED_SESSIONS);
		return next;
	}

	return {
		loadAgentReflectionSlices,
		clearAll: () => reflectionSliceCache.clear(),
		clearAgent: (agentId) => {
			for (const k of [...reflectionSliceCache.keys()]) {
				if (k.startsWith(`${agentId}::`)) reflectionSliceCache.delete(k);
			}
		},
	};
}

function limitSources(
	sources: readonly ReflectionLineSource[],
	limit: number,
): ReflectionLineSource[] {
	return sources.filter((source) => source.rank <= limit);
}
