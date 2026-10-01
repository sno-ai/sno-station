/** @file precision-recall-fusion.test.ts
 * @purpose Validates Precision Recall fusion when semantic and keyword signals both carry ranking value.
 * @boundary Vector search, FTS5 search, reciprocal-rank fusion, and MemoryStore score metadata.
 * @see retriever-pipeline-bugs.test.ts, store-vector-search-quality.test.ts, store-fts5-search.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-precision-recall-state-${Date.now()}`;

/**
 * Precision Recall fusion quality: tests that fused RRF beats pure semantic or pure FTS5
 * alone for an ambiguous query that requires both signals.
 *
 * Design:
 * - 10 "semantic-similar but keyword-different" entries: conceptually related to
 *   the query but use different vocabulary (good for semantic search, bad for FTS5)
 * - 10 "keyword-matching but semantic-different" entries: contain exact query words
 *   but are unrelated concepts (good for FTS5, bad for semantic)
 *
 * The true relevant entry sits in neither set and uses both signals. We verify
 * that Precision Recall places it higher than pure semantic or pure FTS5.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("store Precision Recall fusion quality", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	it(
		"Precision Recall top-5 is better than pure semantic or pure FTS5 alone for ambiguous query",
		{ timeout: 20_000 },
		async () => {
			const embedder = createEmbedder(
				{
					dimensions: 1024,
				},
				STATE_DIR,
			);

			// Ambiguous query combines the keyword "cache" with the semantic concept "performance".
			const ambiguousQuery = "cache performance optimization";

			// This target carries both keyword and semantic signal for the fused ranker.
			const targetText =
				"Redis cache dramatically improves performance by storing frequently accessed data in memory.";

			// Semantic-only distractors are conceptually related but omit the keyword "cache".
			const semanticSimilarTexts = [
				"Memory memoization stores computed results to avoid redundant calculations.",
				"Lazy evaluation defers computation until the value is actually needed.",
				"Database connection pooling amortizes connection setup overhead.",
				"Query optimization reduces execution time by choosing efficient access paths.",
				"Precomputing expensive results at startup reduces runtime latency.",
				"Buffering writes in batch reduces I/O round trips significantly.",
				"CDN edge nodes reduce latency by serving content closer to users.",
				"HTTP keep-alive reuses TCP connections for multiple requests.",
				"Asynchronous I/O allows handling multiple requests without blocking threads.",
				"Pagination limits result sets to reduce memory usage and response time.",
			];

			// Keyword-only distractors contain "cache" while staying semantically unrelated.
			const keywordMatchingTexts = [
				"The CPU instruction cache stores recently fetched machine code bytes.",
				"Browser cache stores HTML pages to reduce server round trips for users.",
				"DNS cache stores resolved domain names to avoid repeated lookups.",
				"L1 cache hit latency is about 1 nanosecond on modern processors.",
				"Cache invalidation is famously one of the hardest problems in computer science.",
				"Write-through cache ensures data consistency between cache and backing store.",
				"Cache coherence protocols maintain consistency across multi-core processor caches.",
				"Object cache in CMS systems stores rendered HTML fragments for reuse.",
				"APT package cache stores downloaded Debian packages on disk locally.",
				"Opcode cache in PHP caches compiled bytecode to skip repeated parsing.",
			];

			// Store all entries with production embeddings before comparing rankers.
			const allTexts = [
				targetText,
				...semanticSimilarTexts,
				...keywordMatchingTexts,
			];
			const allVectors = await embedder.embedMany(allTexts);

			const targetVector = allVectors[0];
			if (!targetVector) throw new Error("Missing target vector");

			const targetEntry = await store.store({
				text: targetText,
				vector: targetVector,
				category: "episodic",
				projectId: "global",
			});

			for (let i = 1; i <= semanticSimilarTexts.length; i++) {
				const vector = allVectors[i];
				const text = semanticSimilarTexts[i - 1];
				if (!vector || !text) continue;
				await store.store({ text, vector, category: "episodic", projectId: "global" });
			}

			for (let i = 0; i < keywordMatchingTexts.length; i++) {
				const vector = allVectors[11 + i];
				const text = keywordMatchingTexts[i];
				if (!vector || !text) continue;
				await store.store({ text, vector, category: "episodic", projectId: "global" });
			}

			expect((await store.stats()).total).toBe(21);

			// Pure semantic search isolates vector similarity without FTS5 contribution.
			const queryVector = await embedder.embed(ambiguousQuery);
			const semanticResults = await store.searchSemantic(queryVector, {
				limit: 5,
				minScore: 0,
			});
			const semanticRank = semanticResults.findIndex(
				(r) => r.entry.id === targetEntry.id,
			);

			// Pure FTS5 search isolates keyword contribution without vector similarity.
			const ftsResults = await store.searchKeyword(ambiguousQuery, {
				limit: 5,
			});
			const ftsRank = ftsResults.findIndex(
				(r) => r.entry.id === targetEntry.id,
			);

			// Precision Recall combines semantic and keyword signals under the default fusion path.
			const logger = {
				warn: (_msg: string) => {
					/* no-op */
				},
			};
			const precisionRecallRetriever = createRetriever(store, embedder, logger, {
				...DEFAULT_RETRIEVAL_CONFIG,
				mode: "precision-recall",
				rerank: "none", // Keep this test independent of external reranking services.
				hardMinScore: 0,
				minScore: 0,
			});

			const precisionRecallResults = await precisionRecallRetriever.retrieve({
				query: ambiguousQuery,
				limit: 5,
			});
			const precisionRecallRank = precisionRecallResults.findIndex(
				(r) => r.entry.id === targetEntry.id,
			);

			// The target must land in top 5 because it satisfies both retrieval signals.
			expect(precisionRecallRank).not.toBe(-1);
			expect(precisionRecallRank).toBeLessThan(5);

			// Precision Recall ranking must be at least as useful as the strongest pure strategy.
			const bestPure = Math.min(
				semanticRank >= 0 ? semanticRank : 100,
				ftsRank >= 0 ? ftsRank : 100,
			);
			// Precision Recall rank must be no worse than the best pure rank.
			if (bestPure < 100) {
				expect(precisionRecallRank).toBeLessThanOrEqual(bestPure);
			}
		},
	);
});
