/** @file store-update-metadata-axes.test.ts
 * @purpose An online metadata update on a row whose stored JSON omits the storage axes
 *   (`state`, `tier`) must succeed: the axes did not change, they were only defaulted.
 * @boundary Real SQLite via chokepoint; no mocks.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("MemoryStore.update on a row without stored storage axes", () => {
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

	it("accepts a calendar-field update without touching state or tier", async () => {
		const stored = await store.store({
			text: "Caroline passed the adoption agency interviews last Friday.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({ kind: "episodic", memory_category: "episodic", temporal_date: "2026-09-11" }),
		});
		// The atomic write path stores rows whose JSON carries no axes at all; the store() path
		// normalizes them in, so strip them back out of the persisted row to reproduce that shape.
		const normalized = JSON.parse(store.getById(stored.id)?.metadata ?? "{}") as Record<string, unknown>;
		const { state: _state, tier: _tier, ...before } = normalized;
		store.db.$client
			.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
			.run(JSON.stringify(before), stored.id);
		expect("state" in JSON.parse(store.getById(stored.id)?.metadata ?? "{}")).toBe(false);

		const updated = await store.update(stored.id, {
			metadata: JSON.stringify({ ...before, temporal_date: "2023-10-20" }),
			expectedMetadata: store.getById(stored.id)?.metadata,
		});
		expect(updated).toBeDefined();
		const after = JSON.parse(store.getById(stored.id)?.metadata ?? "{}") as Record<string, unknown>;
		expect(after.temporal_date).toBe("2023-10-20");
	});
});
