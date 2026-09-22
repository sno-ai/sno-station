import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { randomUUID } from "node:crypto";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { stableHash } from "../../../../packages/memory/src/engine/shared/utils.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("MemoryStore deprecated vector inputs", () => {
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	it("ignores mismatched legacy StoreInput.vector values", async () => {
		const text =
			"Legacy parent vectors are ignored while MemoryStore embeds chunks from text.";

		const stored = await store.store({
			text,
			vector: new Float32Array(7),
			category: "episodic",
			projectId: "deprecated-vector-input",
		});

		expect(stored.text).toBe(text);
		expect(store.getById(stored.id)?.text).toBe(text);
	});

	it("ignores mismatched legacy UpdateChanges.vector values", async () => {
		const original = await store.store({
			text: "Original text before a legacy vector-only update.",
			category: "episodic",
			projectId: "deprecated-vector-update",
		});

		const vectorOnly = await store.update(original.id, {
			vector: new Float32Array(3),
		});

		expect(vectorOnly).not.toBeNull();
		expect(vectorOnly!.text).toBe(original.text);

		const nextText =
			"Updated text is re-embedded from text while legacy vector is ignored.";
		const textUpdate = await store.update(original.id, {
			text: nextText,
			vector: new Float32Array(5),
		});

		expect(textUpdate).not.toBeNull();
		expect(textUpdate!.text).toBe(nextText);
		expect(store.getById(original.id)?.text).toBe(nextText);
	});

	it("ignores mismatched legacy importEntry vector values", async () => {
		const id = randomUUID();
		const text =
			"Imported memories preserve identity and re-embed chunks from text, not legacy vectors.";

		const imported = await store.importEntry({
			id,
			text,
			category: "episodic",
			projectId: "deprecated-vector-import",
			importance: 0.7,
			timestamp: Date.now(),
			metadata: "{}",
			contentHash: stableHash(text),
			vector: new Float32Array(9),
		});

		expect(imported.id).toBe(id);
		expect(imported.text).toBe(text);
		expect(store.getById(id)?.text).toBe(text);
	});
});
