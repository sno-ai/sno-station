/** Real ONNX embedder + real encrypted SQLite. No mocking. Missing deps = FAIL. */

/**
 * A legacy row with malformed `metadata` JSON must not abort an entire
 * `excludeInvalidatedBefore` search batch (codex adversarial review
 * 2026-07-13): `json_extract` throws on invalid JSON, so the temporal-expiry
 * predicate in memory-store-chunk-search.ts guards it with `json_valid`
 * first — same idiom already used in memory-store-read-api.ts /
 * memory-store-lookup-api.ts for the same metadata column. A malformed row
 * is treated as "no invalidation info" (fail open), matching the
 * lazy-heal convention in memory-store-update-api.ts.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

const SCOPE = "chunk-search-malformed-metadata";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

interface Fixture {
	store: MemoryStore;
	cleanup: () => void;
}

function buildFixture(): Fixture {
	const testDb = createTestDb();
	const store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
	return {
		store,
		cleanup: () => {
			store.close();
			testDb.cleanup();
		},
	};
}

describe("chunk search tolerates malformed metadata under temporal-expiry filtering", () => {
	let fixture: Fixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("keyword and semantic search tolerate a malformed-metadata row instead of throwing", async () => {
		fixture = buildFixture();
		const { store } = fixture;

		const valid = await store.store({
			text: "Kubernetes pod eviction is triggered by memory pressure on the node.",
			category: "episodic",
			projectId: SCOPE,
		});
		const legacy = await store.store({
			text: "Kubernetes node pressure eviction policy overview for the platform team.",
			category: "episodic",
			projectId: SCOPE,
		});
		// Simulate a pre-existing legacy row whose metadata never passed JSON
		// validation (see memory-store-update-api.ts's own lazy-heal comment for
		// why this is a real, recurring condition, not a hypothetical one).
		store["sqlite"]
			.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
			.run("{not valid json", legacy.id);

		const queryVector = await testEmbedder.embed("Kubernetes pod eviction memory pressure");

		// The query must resolve (not throw) and, matching the repo-wide
		// "malformed JSON == no invalidation info" convention (see
		// memory-store-update-api.ts), both rows survive the temporal-expiry
		// predicate rather than the whole batch failing.
		const semanticResults = await store.searchChunksSemantic(queryVector, {
			projectIdFilter: [SCOPE],
			limit: 10,
			excludeInvalidatedBefore: Date.now(),
		});
		expect(semanticResults.some((r) => r.parentMemoryId === valid.id)).toBe(true);
		expect(semanticResults.some((r) => r.parentMemoryId === legacy.id)).toBe(true);

		const keywordResults = await store.searchChunksKeyword("Kubernetes eviction pressure", {
			projectIdFilter: [SCOPE],
			limit: 10,
			excludeInvalidatedBefore: Date.now(),
		});
		expect(keywordResults.some((r) => r.parentMemoryId === valid.id)).toBe(true);
		expect(keywordResults.some((r) => r.parentMemoryId === legacy.id)).toBe(true);
	});
});
