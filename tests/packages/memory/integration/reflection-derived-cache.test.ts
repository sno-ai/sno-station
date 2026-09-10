import { describe, expect, it } from "vitest";
import {
	getReflectionDerivedCacheEntry,
	pruneReflectionDerivedCache,
	type ReflectionDerivedCache,
	setReflectionDerivedCacheEntry,
} from "../../../../packages/sno-station-mem/src/engine/reflection/derived-line-cache.ts";
import { storeReflectionEntries } from "../../../../packages/sno-station-mem/src/engine/reflection/reflection-store-writer.ts";
import type { MemorySearchResult } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";

describe("reflection derived cache", () => {
	it("refreshes recency and updatedAt on cache hits", () => {
		const cache: ReflectionDerivedCache = new Map();
		setReflectionDerivedCacheEntry(cache, "session-a", {
			updatedAt: 10,
			derived: ["a"],
		});
		setReflectionDerivedCacheEntry(cache, "session-b", {
			updatedAt: 20,
			derived: ["b"],
		});

		const hit = getReflectionDerivedCacheEntry(cache, "session-a", 50);

		expect(hit).toEqual({
			updatedAt: 50,
			derived: ["a"],
		});
		expect([...cache.keys()]).toEqual(["session-b", "session-a"]);
	});

	it("evicts the least recently used entry after a touch", () => {
		const cache: ReflectionDerivedCache = new Map();
		setReflectionDerivedCacheEntry(cache, "session-a", {
			updatedAt: 10,
			derived: ["a"],
		});
		setReflectionDerivedCacheEntry(cache, "session-b", {
			updatedAt: 20,
			derived: ["b"],
		});
		setReflectionDerivedCacheEntry(cache, "session-c", {
			updatedAt: 30,
			derived: ["c"],
		});
		getReflectionDerivedCacheEntry(cache, "session-a", 40);

		pruneReflectionDerivedCache(cache, 1_000, 2, 40);

		expect([...cache.keys()]).toEqual(["session-c", "session-a"]);
	});

	it("keeps recently touched entries past the TTL window", () => {
		const cache: ReflectionDerivedCache = new Map();
		setReflectionDerivedCacheEntry(cache, "session-a", {
			updatedAt: 10,
			derived: ["a"],
		});
		setReflectionDerivedCacheEntry(cache, "session-b", {
			updatedAt: 20,
			derived: ["b"],
		});
		getReflectionDerivedCacheEntry(cache, "session-a", 90);

		pruneReflectionDerivedCache(cache, 50, 10, 100);

		expect([...cache.entries()]).toEqual([
			[
				"session-a",
				{
					updatedAt: 90,
					derived: ["a"],
				},
			],
		]);
	});

	it("exposes stored derived row sources for cache-backed prompt injection", async () => {
		const result = (await storeReflectionEntries({
			reflectionText: [
				"## Invariants",
				"- Keep receipts deterministic.",
				"",
				"## Derived",
				"- Prefer the durable local outbox for usage.",
			].join("\n"),
			sessionKey: "agent:reflection-agent:cache",
			sessionId: "cache-session",
			agentId: "reflection-agent",
			command: "new",
			scope: "reflection-cache",
			toolErrorSignals: [],
			runAt: 1_700_000_000_000,
			usedFallback: false,
			writeLegacyCombined: false,
			embed: async () => new Float32Array([0.1, 0.2, 0.3]),
			searchSemantic: async () => [] as MemorySearchResult[],
			store: async (entry) => ({
				id: entry.text.startsWith("Prefer ") ? "derived-row" : "other-row",
				factId: entry.text.startsWith("Prefer ") ? "derived-fact" : "other-fact",
				category: entry.category,
				projectId: entry.projectId,
			}),
		})) as Awaited<ReturnType<typeof storeReflectionEntries>> & {
			derivedSources?: Array<{ factId: string; line: string; rank: number }>;
		};

		expect(result.slices.derived).toEqual(["Prefer the durable local outbox for usage."]);
		expect(result.derivedSources).toEqual([
			expect.objectContaining({
				factId: "derived-fact",
				line: "Prefer the durable local outbox for usage.",
				rank: 1,
			}),
		]);
	});
});
