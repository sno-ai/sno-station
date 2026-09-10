/** @file store-update-tier.test.ts
 * @purpose Verifies direct tier mutation is frozen for non-offline callers.
 * @boundary Real SQLite via chokepoint; no mocks.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("MemoryStore.updateTier", () => {
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

	it("rejects direct tier mutation without changing the row", async () => {
		const stored = await store.store({
			text: "Tier-update target memory with sufficient body for the chunker to accept it.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({
				tier: "peripheral",
				accessCount: 4,
				lastAccessedAt: 1700000000000,
			}),
		});

		const before = store.getById(stored.id);
		expect(before).toBeDefined();
		const metadataBefore = before?.metadata;

		await expect(store.updateTier(stored.id, "core")).rejects.toThrow(
			/storage axis mutations require offline-family authority/,
		);

		const after = store.getById(stored.id);
		expect(after).toBeDefined();

		const metadataAfter = JSON.parse(after?.metadata ?? "{}") as {
			tier?: string;
			accessCount?: number;
			access_count?: number;
		};
		expect(metadataAfter.tier).toBe("peripheral");
		expect(metadataAfter.accessCount ?? metadataAfter.access_count).toBe(4);
		expect(after?.text).toBe(before?.text);
		expect(after?.category).toBe(before?.category);
		expect(after?.projectId).toBe(before?.projectId);
		expect(after?.importance).toBe(before?.importance);
		expect(after?.contentHash).toBe(before?.contentHash);
		expect(after?.metadata).toBe(metadataBefore);
	});
});
