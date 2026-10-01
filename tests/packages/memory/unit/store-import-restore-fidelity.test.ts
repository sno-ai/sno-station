/** @file store-import-restore-fidelity.test.ts
 * @purpose Verifies importEntry restores a row's lane and fact identity unchanged.
 * @boundary Real SQLite via chokepoint; no mocks.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("MemoryStore.importEntry restore fidelity", () => {
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

	it("keeps a quarantined row out of the active lane on restore", async () => {
		const imported = await store.importEntry({
			id: "imported-quarantined-row",
			text: "A quarantined backup row with enough body for the chunker to accept it.",
			category: "episodic",
			projectId: "global",
			importance: 0.5,
			timestamp: 1_700_000_000_000,
			metadata: JSON.stringify({}),
			contentHash: "",
			lane: "quarantined",
			dispositionReason: "noise",
		});

		expect(imported.lane).toBe("quarantined");
		expect(store.getById("imported-quarantined-row")?.lane).toBe("quarantined");
	});

	it("keeps a replacement's fact identity instead of re-keying it to the row id", async () => {
		const imported = await store.importEntry({
			id: "replacement-row-id",
			factId: "original-fact-id",
			text: "A supersede replacement carrying its predecessor's fact identity on a new row.",
			category: "episodic",
			projectId: "global",
			importance: 0.5,
			timestamp: 1_700_000_000_000,
			metadata: JSON.stringify({}),
			contentHash: "",
			lane: "active",
		});

		expect(imported.factId).toBe("original-fact-id");
		expect(store.getById("replacement-row-id")?.factId).toBe("original-fact-id");
	});
});
