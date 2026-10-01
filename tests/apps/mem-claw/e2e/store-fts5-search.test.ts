/** @file store-fts5-search.test.ts
 * @purpose Validates keyword search stability across FTS5 tokenization, special characters, and empty queries.
 * @boundary SQLite FTS5 query sanitization, MemoryStore keywordSearch(), and persisted embedding-backed entries.
 * @see precision-recall-fusion.test.ts, store-vector-search-quality.test.ts.
 */

import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createEmbedder,
	type Embedder,
} from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-fts-state-${Date.now()}`;

/**
 * FTS5 keyword search: store 20 entries through the production embedding path,
 * then verify special-character queries remain sanitized and non-throwing.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("store FTS5 keyword search", () => {
	let dbPath: string;
	let sqlite: BetterSqlite3.Database;
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		sqlite = testDb.sqlite;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });

		const embedder = createEmbedder(
			{
				dimensions: 1024,
			},
			STATE_DIR,
		);

		// Seed 20 entries with production embeddings
		const texts = [
			"TypeScript strict mode eliminates implicit any types and enables strict null checks.",
			"Node.js runtime provides native SQLite support through better-sqlite3 module.",
			"Zod schema validation offers type-safe parsing for API inputs.",
			"React hooks replaced class components for state management.",
			"Rust ownership prevents dangling pointers and use-after-free bugs.",
			"PostgreSQL full-text search supports stemming and language dictionaries.",
			"Redis cache enables sub-millisecond response times for frequent queries.",
			"Docker container isolation separates application processes.",
			"Kubernetes pod scheduling distributes workloads across nodes.",
			"Git branching strategy with feature branches and pull requests.",
			"Jest testing framework provides snapshot testing and mocking.",
			"ESLint linting catches common JavaScript mistakes before runtime.",
			"Webpack bundles modules and handles code splitting automatically.",
			"GraphQL query language reduces over-fetching compared to REST APIs.",
			"OAuth2 authorization flow issues access tokens for API authentication.",
			"SSL certificate validation prevents man-in-the-middle attacks.",
			"SQL injection attacks exploit unsanitized user input in queries.",
			"Memory leak detection requires profiling heap allocations over time.",
			"Algorithm complexity measured in Big O notation for worst case analysis.",
			"Machine learning model training requires gradient descent optimization.",
		];

		const vectors = await embedder.embedMany(texts);
		for (let i = 0; i < texts.length; i++) {
			const text = texts[i];
			const vector = vectors[i];
			if (!text || !vector) continue;
			await store.store({
				text,
				vector,
				category: "episodic",
				projectId: "global",
			});
		}
	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	it(
		"keyword search remains non-throwing with FTS5 special chars and returns valid results",
		{ timeout: 20_000 },
		async () => {
			// Test cases with FTS5 special tokens that must be sanitized
			const dangerousQueries = [
				// FTS5 AND operator - must be removed
				"TypeScript AND strict",
				// FTS5 OR operator - must be removed
				"Node OR TypeScript",
				// FTS5 NEAR operator - must be removed
				"NEAR(TypeScript strict)",
				// FTS5 exact phrase - quotes must be sanitized
				'"TypeScript strict mode"',
				// Unbalanced quotes - must remain non-throwing
				'TypeScript"strict',
				// Pure operators only - sanitizes to empty
				"AND OR NOT",
			];

			for (const query of dangerousQueries) {
				// Must not throw (no SQL injection)
				let results: Awaited<ReturnType<typeof store.searchKeyword>>;
				try {
					results = await store.searchKeyword(query, { limit: 5 });
				} catch (err) {
					throw new Error(`searchKeyword threw on query "${query}": ${err}`);
				}
				// Reserved-only terms can sanitize to an empty query and return no rows.
				expect(Array.isArray(results)).toBe(true);
			}
		},
	);

	it(
		"keyword search finds relevant entry in top-3 for a valid keyword",
		{ timeout: 20_000 },
		async () => {
			// The top result set must include the TypeScript fixture.
			const results = await store.searchKeyword("TypeScript", { limit: 3 });
			expect(results.length).toBeGreaterThan(0);

			const texts = results.map((r) => r.entry.text.toLowerCase());
			const hasTypescript = texts.some((t) => t.includes("typescript"));
			expect(hasTypescript).toBe(true);
		},
	);

	it(
		"keyword search for Node SQLite finds the Node entry in top-3",
		{ timeout: 20_000 },
		async () => {
			const results = await store.searchKeyword("Node SQLite", { limit: 3 });
			expect(results.length).toBeGreaterThan(0);

			const topTexts = results.map((r) => r.entry.text.toLowerCase());
			const hasNode = topTexts.some(
				(t) => t.includes("node") || t.includes("better-sqlite3"),
			);
			expect(hasNode).toBe(true);
		},
	);

	it(
		"keyword search remains non-throwing with empty string",
		{ timeout: 20_000 },
		async () => {
			const results = await store.searchKeyword("", { limit: 5 });
			expect(Array.isArray(results)).toBe(true);
			expect(results).toHaveLength(0);
		},
	);

	it(
		"chunk keyword score ranks a stronger BM25 match above a weaker one",
		{ timeout: 20_000 },
		async () => {
			// Regression guard for the BM25 rank -> score sign inversion (fixed 2026-07-04):
			// SQLite's bm25() is more-negative-for-better-match. The conversion into
			// this store's "higher = better" score must not re-invert that. Two chunks
			// sharing a rare token, one repeating it densely in a short payload (strong
			// match), the other mentioning it once in a long payload (weak match, more
			// length-normalization penalty) — a naive re-introduction of `1/(1+|rank|)`
			// would score the weak match higher and this test would catch it.
			const now = Date.now();
			sqlite
				.prepare(
					"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id) VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?)",
				)
				.run(
					"fts-strong-match-memory",
					"strong match fixture",
					"episodic",
					"global",
					0.7,
					now,
					"{}",
					"fts-strong-match-hash",
					"fts-strong-match-memory",
				);
			sqlite
				.prepare(
					"INSERT INTO nodix_memory_chunks (chunk_id, memory_id, chunk_index, chunk_text, dense_payload, summary, entities, tags, source, start_offset, end_offset, token_count, content_type, chunking_version, embedder_provider, embedder_model, embedder_dim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"fts-strong-match-chunk",
					"fts-strong-match-memory",
					0,
					"strong match fixture",
					"zzqxvbn zzqxvbn zzqxvbn rare token repeated densely",
					null,
					null,
					null,
					null,
					0,
					10,
					8,
					"prose",
					"test-chunking-version",
					"test-provider",
					"test-model",
					1024,
					now,
					now,
				);

			sqlite
				.prepare(
					"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id) VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?)",
				)
				.run(
					"fts-weak-match-memory",
					"weak match fixture",
					"episodic",
					"global",
					0.7,
					now,
					"{}",
					"fts-weak-match-hash",
					"fts-weak-match-memory",
				);
			sqlite
				.prepare(
					"INSERT INTO nodix_memory_chunks (chunk_id, memory_id, chunk_index, chunk_text, dense_payload, summary, entities, tags, source, start_offset, end_offset, token_count, content_type, chunking_version, embedder_provider, embedder_model, embedder_dim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"fts-weak-match-chunk",
					"fts-weak-match-memory",
					0,
					"weak match fixture",
					"zzqxvbn appears exactly one single time in this much longer payload that spends most of its words on entirely unrelated filler content padding out the document length so the term frequency stays low",
					null,
					null,
					null,
					null,
					0,
					10,
					40,
					"prose",
					"test-chunking-version",
					"test-provider",
					"test-model",
					1024,
					now,
					now,
				);

			const results = await store.searchChunksKeyword("zzqxvbn", {
				limit: 5,
				projectIdFilter: ["global"],
			});

			expect(results).toHaveLength(2);
			const strong = results.find((r) => r.chunkId === "fts-strong-match-chunk");
			const weak = results.find((r) => r.chunkId === "fts-weak-match-chunk");
			expect(strong).toBeDefined();
			expect(weak).toBeDefined();
			expect(strong?.score ?? 0).toBeGreaterThan(weak?.score ?? 1);
			expect(results[0]?.chunkId).toBe("fts-strong-match-chunk");
		},
	);

	it(
		"chunk FTS indexes dense payload instead of raw chunk text",
		{ timeout: 20_000 },
		async () => {
			const now = Date.now();
			sqlite
				.prepare(
					"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id) VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?)",
				)
				.run(
					"fts-dense-payload-memory",
					"Original chunk text mentions chunktextonlytoken.",
					"episodic",
					"global",
					0.7,
					now,
					"{}",
					"fts-dense-payload-hash",
					"fts-dense-payload-memory",
				);
			sqlite
				.prepare(
					"INSERT INTO nodix_memory_chunks (chunk_id, memory_id, chunk_index, chunk_text, dense_payload, summary, entities, tags, source, start_offset, end_offset, token_count, content_type, chunking_version, embedder_provider, embedder_model, embedder_dim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"fts-dense-payload-chunk",
					"fts-dense-payload-memory",
					0,
					"Original chunk text mentions chunktextonlytoken.",
					"Enriched retrieval payload mentions payloadonlytoken.",
					null,
					null,
					null,
					null,
					0,
					45,
					8,
					"prose",
					"test-chunking-version",
					"test-provider",
					"test-model",
					1024,
					now,
					now,
				);

			const densePayloadResults = await store.searchChunksKeyword(
				"payloadonlytoken",
				{
					limit: 5,
					projectIdFilter: ["global"],
				},
			);
			expect(densePayloadResults).toHaveLength(1);
			expect(densePayloadResults[0]?.chunkText).toContain("chunktextonlytoken");
			expect(densePayloadResults[0]?.densePayload).toContain(
				"payloadonlytoken",
			);

			const rawChunkTextResults = await store.searchChunksKeyword(
				"chunktextonlytoken",
				{
					limit: 5,
					projectIdFilter: ["global"],
				},
			);
			expect(rawChunkTextResults).toHaveLength(0);
		},
	);
});
