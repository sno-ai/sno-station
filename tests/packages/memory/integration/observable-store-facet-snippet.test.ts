/**
 * Regression fence for the production wrapper, not the bare store.
 *
 * `ObservableMemoryStore` is what production instantiates
 * (`plugin/openclaw-runtime-registration.ts`). It once overrode
 * `getChunksByParent` with a one-parameter signature and dropped the
 * `facetPolicy` argument, so a `current-only` search had retired history
 * chunks reattached to its snippet and served to the user. TypeScript permits
 * an override that declares fewer parameters, so nothing flagged it, and the
 * existing snippet coverage (`recall-snippet.test.ts`) constructs a bare
 * `MemoryStore` and therefore cannot observe the wrapper at all.
 *
 * This case exists to fail if the wrapper ever again narrows what it wraps.
 * Real ONNX embedder, real encrypted storage, no mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	SNIPPET_NEIGHBOR_AFTER,
	SNIPPET_NEIGHBOR_BEFORE,
} from "../../../../apps/mem-claw/config/index.ts";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { PluginObservability } from "../../../../apps/mem-claw/src/observability/adapter.ts";
import { ObservableMemoryStore } from "../../../../apps/mem-claw/src/observability/observable-memory-store.ts";
import { pluginConfigSchema } from "../../../../apps/mem-claw/src/shared/plugin-config-schema.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";

const CURRENT_MARKER = "ZQCURRENTFACET41";
const RETIRED_MARKER = "ZQRETIREDFACET77";

/** Pads a passage past the chunker's minTokens so each one lands in its own chunk. */
function padPassage(passage: string): string {
	return `${passage} ${"This is filler content to push token count above the chunker's minTokens threshold so a fresh chunk is emitted at this passage boundary. ".repeat(16)}`.trimEnd();
}

interface ChunkRow {
	chunk_id: string;
	chunk_index: number;
	chunk_text: string;
	facet: string;
}

let embedder: Embedder;
let testDb: TestDb;
let store: ObservableMemoryStore;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("ObservableMemoryStore honours the facet policy on snippet hydration", () => {
	beforeAll(() => {
		testDb = createTestDb();
		const config = pluginConfigSchema.parse({ embedding: { provider: "local-onnx" } });
		store = new ObservableMemoryStore(
			{ dbPath: testDb.dbPath, embedder },
			new PluginObservability(config, process.cwd()),
			() => undefined,
			config.embedding,
		);
	});

	afterAll(() => {
		store.close();
		testDb.cleanup();
	});

	it(
		"excludes a retired neighbour chunk from a current-only snippet",
		{ timeout: 120_000 },
		async () => {
			const text = [
				padPassage(`The active preference is recorded under ${CURRENT_MARKER} for this account.`),
				padPassage(`The superseded preference is recorded under ${RETIRED_MARKER} for this account.`),
				padPassage("An unrelated third passage about commuting by train on weekday mornings."),
			].join("\n\n");

			const stored = await store.store({
				text,
				category: "episodic",
				projectId: "facet-wrapper",
				importance: 0.7,
			});
			expect(stored.id).toBeTruthy();

			// Read the chunk rows straight from storage rather than through the
			// class under test, so the fixture cannot inherit the defect it is
			// meant to detect.
			const chunks = testDb.sqlite
				.prepare(
					"SELECT chunk_id, chunk_index, chunk_text, facet FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY chunk_index",
				)
				.all(stored.id) as ChunkRow[];
			expect(chunks.length).toBeGreaterThanOrEqual(2);

			const currentChunk = chunks.find((c) => c.chunk_text.includes(CURRENT_MARKER));
			const retiredChunk = chunks.find((c) => c.chunk_text.includes(RETIRED_MARKER));
			if (!currentChunk || !retiredChunk) {
				throw new Error("expected both markers to land in distinct chunks");
			}
			expect(retiredChunk.chunk_id).not.toBe(currentChunk.chunk_id);

			// The instrument must be able to fire: a retired chunk outside the
			// snippet window would be absent for a reason that has nothing to do
			// with the facet policy, and the assertion below would pass against a
			// wrapper that still drops the argument.
			const distance = retiredChunk.chunk_index - currentChunk.chunk_index;
			expect(distance).toBeGreaterThanOrEqual(-SNIPPET_NEIGHBOR_BEFORE);
			expect(distance).toBeLessThanOrEqual(SNIPPET_NEIGHBOR_AFTER);

			// What the REM close path does to a superseded row: move its chunks to
			// the history facet, leaving the durable text untouched.
			testDb.sqlite
				.prepare("UPDATE nodix_memory_chunks SET facet = ? WHERE chunk_id = ? AND memory_id = ?")
				.run("history", retiredChunk.chunk_id, stored.id);
			const afterFlip = testDb.sqlite
				.prepare("SELECT facet FROM nodix_memory_chunks WHERE chunk_id = ?")
				.get(retiredChunk.chunk_id) as { facet: string } | undefined;
			expect(afterFlip?.facet).toBe("history");

			// The defect, asserted where it lives: snippet hydration asks the store
			// for this memory's chunks under a policy, and the wrapper is what
			// production hands that request to. A wrapper that drops the policy
			// returns the retired chunk here, and every snippet built from it
			// carries the retired text onward.
			const currentOnly = store.getChunksByParent([stored.id], "current-only");
			const currentTexts = (currentOnly.get(stored.id) ?? []).map((c) => c.chunkText);
			expect(currentTexts.join("\n")).toContain(CURRENT_MARKER);
			expect(currentTexts.join("\n")).not.toContain(RETIRED_MARKER);

			// The policy still has two directions: a history-shaped query must
			// keep seeing the retired chunk, so a wrapper that hard-codes
			// current-only would fail here rather than passing the assertion above.
			const withHistory = store.getChunksByParent([stored.id], "include-history");
			const historyTexts = (withHistory.get(stored.id) ?? []).map((c) => c.chunkText);
			expect(historyTexts.join("\n")).toContain(RETIRED_MARKER);
		},
	);

	it(
		"forwards refusal visibility through the production search wrapper",
		{ timeout: 120_000 },
		async () => {
			const scope = "observable-refusal-options";
			const clean = await store.store({
				text: "The user listens to chamber music on weekends.",
				category: "episodic",
				projectId: scope,
			});
			const refused = await store.store({
				text: "The user's colleague listens to chamber music at work.",
				category: "episodic",
				projectId: scope,
				dispositionReason: "subject_not_user",
				dispositionedAt: Date.parse("2026-06-04T12:00:00.000Z"),
			});

			const defaultResults = await store.searchKeyword("chamber music", {
				limit: 10,
				projectIdFilter: [scope],
			});
			const servingResults = await store.searchKeyword("chamber music", {
				limit: 10,
				projectIdFilter: [scope],
				includeRefused: false,
			});
			const explicitResults = await store.searchKeyword("chamber music", {
				limit: 10,
				projectIdFilter: [scope],
				includeRefused: true,
			});

			expect(defaultResults.map((result) => result.entry.id)).toEqual(
				expect.arrayContaining([clean.id, refused.id]),
			);
			expect(servingResults.map((result) => result.entry.id)).toContain(clean.id);
			expect(servingResults.map((result) => result.entry.id)).not.toContain(refused.id);
			expect(explicitResults.map((result) => result.entry.id)).toEqual(
				expect.arrayContaining([clean.id, refused.id]),
			);
		},
	);
});
