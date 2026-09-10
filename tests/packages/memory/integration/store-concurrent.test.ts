/** Real LLM API required. No mocking. Missing keys = FAIL. */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { createEmbedder, type Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-concurrent-state-${Date.now()}`;

/**
 * Concurrent store operations: verifies that the async-mutex in MemoryStore
 * serializes writes correctly under parallel load.
 *
 * These tests use real paid OpenAI embeddings — they may be slower.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("store concurrent writes", () => {
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

	/**
	 * Concurrent stores with same content hash:
	 * Launch 5 simultaneous store() calls with identical text.
	 * Dedup must win — final count = 1, no duplicate IDs, mutex prevents corruption.
	 */
	it("5 concurrent stores with same text — dedup wins, final count = 1", async () => {
		const embedder = createEmbedder(
			{ dimensions: 1024 },
			STATE_DIR,
		);

		const text = "Concurrent access control in SQLite WAL mode relies on write serialization at the process level.";
		// Fetch vector once — reuse for all concurrent calls (same text, same embedding)
		const vector = await embedder.embed(text);

		// Launch 5 simultaneous store() calls with identical text and vector
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				store.store({
					text,
					vector,
					category: "episodic",
					projectId: "global",
				}),
			),
		);

		// All 5 must return a MemoryEntry (not throw)
		expect(results).toHaveLength(5);
		for (const result of results) {
			expect(result).not.toBeNull();
			expect(typeof result.id).toBe("string");
			expect(result.text).toBe(text);
		}

		// All 5 must return the SAME id — dedup via content_hash
		const ids = results.map((r) => r.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(1);

		// DB must have exactly 1 entry — no corruption, mutex worked
		const stats = await store.stats();
		expect(stats.total).toBe(1);

		// Verify via list() — only 1 entry
		const entries = await store.list({});
		expect(entries).toHaveLength(1);
	});

	/**
	 * Concurrent stores with different text:
	 * Launch 5 simultaneous store() calls with distinct text (different content hashes).
	 * All 5 must succeed — no mutex deadlock, no transaction collision.
	 * Final count = 5.
	 */
	it("5 concurrent stores with different texts — all succeed, final count = 5", async () => {
		const embedder = createEmbedder(
			{ dimensions: 1024 },
			STATE_DIR,
		);

		// 5 distinct texts with real paid embeddings
		const texts = [
			"TypeScript type narrowing with discriminated unions provides exhaustive pattern matching at compile time.",
			"SQLite WAL mode enables concurrent reads while serializing writes through a single writer lock.",
			"Node.js implements Node.js compatibility via a custom FFI layer backed by JavaScriptCore internals.",
			"Zod schema validation coerces and parses unknown input to strongly typed domain objects at runtime.",
			"async-mutex provides cooperative mutual exclusion for asynchronous critical sections in Node.js.",
		];

		// Pre-compute all embeddings in a single batch (paid API call — real embeddings)
		const vectors = await embedder.embedMany(texts);

		// Launch 5 simultaneous store() calls
		const results = await Promise.all(
			texts.map((text, i) =>
				store.store({
					text,
					vector: vectors[i]!,
					category: "episodic",
					projectId: "global",
				}),
			),
		);

		// All 5 calls must succeed (not throw, not be null)
		expect(results).toHaveLength(5);
		for (const result of results) {
			expect(result).not.toBeNull();
			expect(typeof result.id).toBe("string");
		}

		// All 5 IDs must be distinct (different content hashes → different entries)
		const ids = results.map((r) => r.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(5);

		// DB must have exactly 5 entries — no lost writes, no duplicates
		const stats = await store.stats();
		expect(stats.total).toBe(5);

		// Each stored entry text must match one of the input texts
		const storedEntries = await store.list({ limit: 10 });
		expect(storedEntries).toHaveLength(5);
		const storedTexts = new Set(storedEntries.map((e) => e.text));
		for (const text of texts) {
			expect(storedTexts.has(text)).toBe(true);
		}
	});
});
