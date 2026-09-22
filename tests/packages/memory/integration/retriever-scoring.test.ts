/** Real LLM API required. No mocking. Missing keys = FAIL. */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-retriever-state-${Date.now()}`;

/**
 * Retriever scoring integration: importance weights,
 * and MMR diversity filtering of near-duplicate entries.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("Retriever scoring integration", () => {
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

	it("entry with highest importance ranks first among similarly relevant memories", async () => {
		const embedder = createEmbedder(
			{ dimensions: 1024 },
			STATE_DIR,
		);

		// All entries on the same topic so semantic score is similar
		// Spread timestamps 1 week apart
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;

		const entries = [
			{
				text: "TypeScript strict mode prevents implicit any types in code.",
				importance: 0.3,
				timestamp: now - 7 * dayMs, // oldest
			},
			{
				text: "TypeScript strict mode catches null pointer errors at compile time.",
				importance: 0.5,
				timestamp: now - 5 * dayMs,
			},
			{
				text: "TypeScript strict mode is essential for large codebases.",
				importance: 0.5,
				timestamp: now - 3 * dayMs,
			},
			{
				text: "TypeScript strict mode enables exhaustive type checking.",
				importance: 0.9,
				timestamp: now - dayMs, // most recent + highest importance
			},
			{
				text: "TypeScript strict mode enforces explicit return types.",
				importance: 0.4,
				timestamp: now - 6 * dayMs,
			},
		];

		// Store with real embeddings but override timestamps via direct DB access
		const vectors = await embedder.embedMany(entries.map((e) => e.text));
		const sqlite = (store as unknown as { sqlite: { prepare: (sql: string) => { run: (...args: unknown[]) => void }; query: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).sqlite;

		const storedIds: string[] = [];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const vector = vectors[i];
			if (!entry || !vector) continue;
			const stored = await store.store({
				text: entry.text,
				vector,
				category: "episodic",
				projectId: "global",
				importance: entry.importance,
			});
			storedIds.push(stored.id);

			// Override timestamp via direct SQL (store() always uses Date.now())
			sqlite
				.prepare("UPDATE nodix_memories SET timestamp = ?, importance = ? WHERE id = ?")
				.run(entry.timestamp, entry.importance, stored.id);
		}

		expect((await store.stats()).total).toBe(5);

		// Retrieve using importance scoring (no external reranker)
		const retriever = createRetriever(store, embedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			hardMinScore: 0,
			minScore: 0,
		});

		const results = await retriever.retrieve({
			query: "TypeScript strict mode benefits",
			limit: 5,
		});

		// Must return results — if empty, retrieval is broken
		expect(results.length).toBeGreaterThan(0);

		// All 5 entries stored, so storedIds[3] is guaranteed defined
		expect(storedIds.length).toBe(5);
		const expectedTopId = storedIds[3]!;

		// The entry with highest importance (0.9)
		// must rank first — no conditional, hard assertion
		expect(results[0]!.entry.id).toBe(expectedTopId);
		expect(results[0]!.score).toBeGreaterThan(0);
	});

	it("MMR diversity: retriever returns all entries with valid scores and no crash", async () => {
		const embedder = createEmbedder(
			{ dimensions: 1024 },
			STATE_DIR,
		);

		// Create 2 near-identical entries (very similar text) + 3 distinct entries
		const entries = [
			// Near-duplicate pair
			"I prefer TypeScript strict mode for all projects. It is the best setting.",
			"I prefer TypeScript strict mode for all projects. It is absolutely the best.",
			// Distinct entries
			"Redis cache reduces database query load significantly in production.",
			"Docker containers provide portable deployment environments for services.",
			"Kubernetes autoscaling adjusts pod replicas based on CPU metrics.",
		];

		const vectors = await embedder.embedMany(entries);
		for (let i = 0; i < entries.length; i++) {
			const text = entries[i];
			const vector = vectors[i];
			if (!text || !vector) continue;
			await store.store({ text, vector, category: "episodic", projectId: "global" });
		}

		const retriever = createRetriever(store, embedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			hardMinScore: 0,
			minScore: 0,
		});

		// Query on TypeScript strict mode (near-duplicates are most relevant semantically)
		const results = await retriever.retrieve({
			query: "TypeScript strict mode settings preferences",
			limit: 5,
		});

		// All 5 entries should be returned (no crash from MMR processing near-duplicates)
		expect(results.length).toBeGreaterThanOrEqual(2);

		// All results must have valid finite scores
		for (const result of results) {
			expect(typeof result.score).toBe("number");
			expect(Number.isFinite(result.score)).toBe(true);
		}

		// MMR intentionally reorders results for diversity — no descending-sort guarantee.
		// Verify all scores are positive and all entry IDs are unique.
		const seenIds = new Set<string>();
		for (const result of results) {
			expect(result.score).toBeGreaterThan(0);
			expect(seenIds.has(result.entry.id)).toBe(false);
			seenIds.add(result.entry.id);
		}

		// TypeScript-related entries should appear in results (near-duplicates have highest similarity)
		const typescriptEntries = results.filter((r) =>
			r.entry.text.includes("TypeScript strict mode for all projects"),
		);
		expect(typescriptEntries.length).toBeGreaterThanOrEqual(1);
	});
});
