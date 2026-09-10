/** @file store-update-metadata.test.ts
 * @purpose RED test for mem-lifecycle Phase 0 §1: MemoryStore.updateMetadata shallow + intrinsic deep merge.
 * @boundary Real SQLite via chokepoint; no mocks.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let embedder: Embedder;
const TEST_PROJECT_ID = "unit-store-update-metadata-project";

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("MemoryStore.updateMetadata", () => {
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

	it("shallow-merges top-level keys and deep-merges intrinsic", async () => {
		const stored = await store.store({
			text: "Metadata-update target memory with sufficient body for the chunker to accept it.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({
				accessCount: 5,
				intrinsic: { confidence: 0.5, importance: 0.7 },
			}),
		});

		await store.updateMetadata(stored.id, {
			intrinsic: { confidence: 0.8 },
		});

		const after = store.getById(stored.id);
		const md = JSON.parse(after?.metadata ?? "{}") as {
			accessCount?: number;
			intrinsic?: { confidence?: number; importance?: number };
		};

		// Shallow: accessCount preserved (was not in the patch).
		expect(md.accessCount).toBe(5);
		// Deep: intrinsic.confidence overwritten, intrinsic.importance preserved.
		expect(md.intrinsic?.confidence).toBe(0.8);
		expect(md.intrinsic?.importance).toBe(0.7);
	});

	it("sets a new top-level key without dropping existing keys", async () => {
		const stored = await store.store({
			text: "Suppression-set target memory with sufficient body for the chunker to accept.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({ accessCount: 5, intrinsic: { confidence: 0.5 } }),
		});

		await store.updateMetadata(stored.id, { suppressed_until_ms: 1000 });

		const md = JSON.parse(store.getById(stored.id)?.metadata ?? "{}") as {
			accessCount?: number;
			suppressed_until_ms?: number;
			intrinsic?: { confidence?: number };
		};
		expect(md.accessCount).toBe(5);
		expect(md.suppressed_until_ms).toBe(1000);
		expect(md.intrinsic?.confidence).toBe(0.5);
	});

	it("missing row resolves without throwing and writes nothing", async () => {
		await expect(store.updateMetadata("nonexistent-id", { bad_recall_count: 1 })).resolves
			.toBeUndefined();
	});
});
