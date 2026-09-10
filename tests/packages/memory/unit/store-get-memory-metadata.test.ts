/** @file store-get-memory-metadata.test.ts
 * @purpose RED test for mem-lifecycle Phase 0 §1: MemoryStore.getMemoryMetadata read accessor.
 * @boundary Real SQLite via chokepoint; no mocks.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let embedder: Embedder;
const TEST_PROJECT_ID = "unit-store-get-memory-metadata-project";

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("MemoryStore.getMemoryMetadata", () => {
	let store: MemoryStore;
	let cleanup: () => void;
	let rawSqlite: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };

	beforeEach(() => {
		const td = createTestDb();
		cleanup = td.cleanup;
		store = new MemoryStore({ dbPath: td.dbPath, embedder });
		rawSqlite = td.sqlite as unknown as typeof rawSqlite;
	});

	afterEach(() => {
		store.closeSync();
		cleanup();
	});

	it("returns undefined for a missing row", async () => {
		await expect(store.getMemoryMetadata("nonexistent-id")).resolves.toBeUndefined();
	});

	it("returns undefined when metadata JSON is malformed (logs warning, does not throw)", async () => {
		const stored = await store.store({
			text: "Malformed metadata target memory with sufficient body for the chunker to accept it.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({ accessCount: 1 }),
		});
		// Corrupt the metadata column directly so the row exists but JSON is invalid.
		rawSqlite
			.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
			.run("not valid json", stored.id);

		await expect(store.getMemoryMetadata(stored.id)).resolves.toBeUndefined();
	});

	it("returns parsed metadata when JSON is valid", async () => {
		const stored = await store.store({
			text: "Valid metadata target memory with sufficient body for the chunker to accept it.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({
				accessCount: 7,
				intrinsic: { confidence: 0.6 },
			}),
		});

		const md = await store.getMemoryMetadata(stored.id);
		expect(md).toBeDefined();
		expect(md?.accessCount).toBe(7);
		expect(md?.intrinsic?.confidence).toBe(0.6);
		expect(md?.memory_layer).toBe("durable");
	});
});
