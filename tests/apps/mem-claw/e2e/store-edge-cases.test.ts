/** @file store-edge-cases.test.ts
 * @purpose Validates MemoryStore invariants for deduplication, null handling, clamping, and metadata-only updates.
 * @boundary Store API contracts, SQLite persistence, vector table consistency, and input normalization.
 * @see tool-memory-mutate.test.ts, tool-memory-forget-query.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { DEFAULT_IMPORTANCE } from "../../../../packages/memory/config/index.ts";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { stableHash } from "../../../../packages/memory/src/engine/shared/utils.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-edge-cases-state-${Date.now()}`;

/**
 * Edge cases for MemoryStore: content_hash dedup, importance clamping,
 * update preserving unchanged fields, and graceful handling of non-existent IDs.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("store edge cases", () => {
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
	 * Deduplication contract: identical scoped text resolves by content_hash before insert.
	 * The second call returns the existing row and leaves the persisted count unchanged.
	 */
	it("dedup via content_hash — second store returns original entry, count stays at 1", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		const text =
			"TypeScript uses structural typing for type compatibility checks across all modules.";
		const vector = await embedder.embed(text);

		// First write establishes the scoped content-hash baseline.
		const first = await store.store({
			text,
			vector,
			category: "episodic",
			projectId: "global",
		});

		// Same text + same scope + same category hits content_hash dedup before insert.
		// Per PRD §4.2 the UNIQUE index is (project_id, content_hash, category) so a
		// different category would legitimately produce a distinct row; this case
		// is asserted in `category-changes-coexist`.
		const second = await store.store({
			text,
			vector,
			category: "episodic",
			projectId: "global",
		});

		// Deduplicated writes return the original persisted entry.
		expect(first.id).toBe(second.id);
		expect(first.contentHash).toBe(second.contentHash);

		// Store count proves dedup prevented a second insert.
		const stats = await store.stats();
		expect(stats.total).toBe(1);

		// Content-hash lookup must resolve to the same persisted entry.
		const hash = stableHash(text);
		const found = store.findByContentHash(hash, "global");
		expect(found).not.toBeNull();
		expect(found?.id).toBe(first.id);
	});

	/**
	 * Importance boundary clamping:
	 * - 1.5 -> clamped to 1.0
	 * - -0.5 -> clamped to 0.0
	 * - NaN -> falls back to DEFAULT_IMPORTANCE (clamp01 fallback path)
	 */
	it("importance clamped to [0, 1] — 1.5, -0.5, NaN all produce valid stored values", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		const texts = [
			"Node.js runtime is significantly faster than Node.js for most server-side TypeScript workloads.",
			"PostgreSQL JSONB columns allow flexible schema-less storage with full indexing capabilities.",
			"Redis sorted sets enable efficient leaderboard queries with O(log N) time complexity.",
		];
		const vectors = await embedder.embedMany(texts);

		// Values above the boundary are clamped into the valid range.
		const overEntry = await store.store({
			text: texts[0]!,
			vector: vectors[0]!,
			category: "episodic",
			projectId: "global",
			importance: 1.5,
		});
		expect(overEntry.importance).toBeLessThanOrEqual(1);
		expect(overEntry.importance).toBeGreaterThanOrEqual(0);

		// Values below the boundary are clamped into the valid range.
		const underEntry = await store.store({
			text: texts[1]!,
			vector: vectors[1]!,
			category: "episodic",
			projectId: "global",
			importance: -0.5,
		});
		expect(underEntry.importance).toBeLessThanOrEqual(1);
		expect(underEntry.importance).toBeGreaterThanOrEqual(0);

		// Non-finite values fall back to the configured default importance.
		const nanEntry = await store.store({
			text: texts[2]!,
			vector: vectors[2]!,
			category: "episodic",
			projectId: "global",
			importance: NaN,
		});
		expect(nanEntry.importance).toBe(DEFAULT_IMPORTANCE);

		// Update follows the same upper-bound clamp as initial storage.
		const updated = await store.update(overEntry.id, { importance: 1.5 });
		expect(updated).not.toBeNull();
		expect(updated!.importance).toBeLessThanOrEqual(1);
		expect(updated!.importance).toBeGreaterThanOrEqual(0);

		// Update follows the same lower-bound clamp as initial storage.
		const updated2 = await store.update(underEntry.id, { importance: -0.5 });
		expect(updated2).not.toBeNull();
		expect(updated2!.importance).toBeLessThanOrEqual(1);
		expect(updated2!.importance).toBeGreaterThanOrEqual(0);

		// NaN updates preserve a finite importance through the clamp fallback path.
		const updated3 = await store.update(nanEntry.id, { importance: NaN });
		expect(updated3).not.toBeNull();
		expect(Number.isFinite(updated3!.importance)).toBe(true);
		expect(updated3!.importance).toBeGreaterThanOrEqual(0);
		expect(updated3!.importance).toBeLessThanOrEqual(1);
	});

	/**
	 * Partial-update contract: metadata-only writes must preserve text, category,
	 * scope, and importance so maintenance edits do not silently rewrite memory rank.
	 */
	it("metadata-only update preserves text, category, and importance unchanged", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		const originalText =
			"SQLite WAL mode enables concurrent reads with single-writer serialization for performance.";
		const originalCategory = "episodic" as const;
		const originalImportance = 0.85;

		const vector = await embedder.embed(originalText);
		const entry = await store.store({
			text: originalText,
			vector,
			category: originalCategory,
			projectId: "global",
			importance: originalImportance,
		});

		// Baseline assertions protect the fixture from masking update regressions.
		expect(entry.importance).toBe(originalImportance);
		expect(entry.category).toBe(originalCategory);
		expect(entry.text).toBe(originalText);

		// Metadata-only update exercises the narrowest mutable field set.
		const updated = await store.update(entry.id, {
			metadata: JSON.stringify({ reviewed: true, source: "test" }),
		});

		expect(updated).not.toBeNull();

		// Text is immutable for metadata-only updates.
		expect(updated!.text).toBe(originalText);

		// Category is immutable for metadata-only updates.
		expect(updated!.category).toBe(originalCategory);

		// Importance must survive metadata edits because retrieval rank depends on it.
		// This guards against accidental fallback to DEFAULT_IMPORTANCE.
		expect(updated!.importance).toBe(originalImportance);

		// Metadata is the only intended field mutation in this path.
		expect(updated!.metadata).toContain("reviewed");

		// Scope is read from the existing row because UpdateChanges cannot mutate it.
		expect(updated!.projectId).toBe("global");

		// A fresh read confirms the invariant is durable, not only returned in memory.
		const fromDb = store.getById(entry.id);
		expect(fromDb).not.toBeNull();
		expect(fromDb!.importance).toBe(originalImportance);
		expect(fromDb!.text).toBe(originalText);
	});

	/**
	 * Missing-ID contract:
	 * - store.update() returns null for unknown ids.
	 * - store.delete() remains non-throwing and reports zero deleted rows.
	 *
	 * Note: the existence check is part of the public store contract because CLI
	 * delete flows rely on accurate affected-row counts for user-visible reporting.
	 * No row is created, and all reads return the correct "not found" sentinel values.
	 */
	it("update on non-existent ID returns null, delete does not throw, DB stays empty", async () => {
		const nonExistentId = "00000000-0000-0000-0000-000000000000";

		// Unknown IDs return the update sentinel instead of raising.
		const updateResult = await store.update(nonExistentId, { importance: 0.5 });
		expect(updateResult).toBeNull();

		// Delete must be non-throwing so batch cleanup can continue after stale IDs.
		let deleteThrew = false;
		let deleteResult = -1;
		try {
			deleteResult = await store.delete(nonExistentId);
		} catch {
			deleteThrew = true;
		}
		expect(deleteThrew).toBe(false);
		// Non-existent IDs report zero after the store-level existence check.
		expect(deleteResult).toBe(0);

		// Direct lookup exposes the "not found" sentinel.
		const getResult = store.getById(nonExistentId);
		expect(getResult).toBeUndefined();

		// Missing-ID operations must not create compensating rows or metadata.
		const stats = await store.stats();
		expect(stats.total).toBe(0);

		// Existence checks stay aligned with direct lookup semantics.
		const hasId = await store.hasId(nonExistentId);
		expect(hasId).toBe(false);
	});
});
