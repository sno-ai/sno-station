/** @file store-apply-metadata-delta.test.ts
 * @purpose RED test for mem-lifecycle Phase 0 §1: atomic read-modify-write under one mutex.
 * @boundary Real SQLite + real concurrency; no mocks.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let embedder: Embedder;
const TEST_PROJECT_ID = "unit-store-apply-metadata-delta-project";

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("MemoryStore.applyMetadataDelta", () => {
	let store: MemoryStore;
	let cleanup: () => void;

	beforeEach(() => {
		const td = createTestDb();
		cleanup = td.cleanup;
		store = new MemoryStore({ dbPath: td.dbPath, embedder });
	});

	afterEach(() => {
		store.closeSync();
		cleanup();
	});

	it("10 concurrent increments accumulate without lost updates", async () => {
		const stored = await store.store({
			text: "Concurrent delta target memory with sufficient body for the chunker to accept it.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({ bad_recall_count: 0 }),
		});

		await Promise.all(
			Array.from({ length: 10 }, () =>
				store.applyMetadataDelta(stored.id, (cur) => ({
					bad_recall_count: (cur?.bad_recall_count ?? 0) + 1,
				})),
			),
		);

		const md = JSON.parse(store.getById(stored.id)?.metadata ?? "{}") as {
			bad_recall_count?: number;
		};
		expect(md.bad_recall_count).toBe(10);
	});

	it("missing row is a no-op — callback not invoked, no throw", async () => {
		let invocations = 0;
		await expect(
			store.applyMetadataDelta("nonexistent-id", () => {
				invocations += 1;
				return {};
			}),
		).resolves.toBeUndefined();
		expect(invocations).toBe(0);
	});

	it("callback exception releases the lock — next call succeeds", async () => {
		const stored = await store.store({
			text: "Callback-throw target memory with sufficient body for the chunker to accept it.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({ bad_recall_count: 0 }),
		});

		await expect(
			store.applyMetadataDelta(stored.id, () => {
				throw new Error("delta callback failure");
			}),
		).rejects.toThrow("delta callback failure");

		// Lock must have been released — a follow-up delta must complete.
		await store.applyMetadataDelta(stored.id, (cur) => ({
			bad_recall_count: (cur?.bad_recall_count ?? 0) + 1,
		}));

		const md = JSON.parse(store.getById(stored.id)?.metadata ?? "{}") as {
			bad_recall_count?: number;
		};
		expect(md.bad_recall_count).toBe(1);
	});
});
