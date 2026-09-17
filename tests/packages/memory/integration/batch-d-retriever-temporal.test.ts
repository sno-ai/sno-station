/** Real LLM API required. No mocking. Missing keys = FAIL. */

/**
 * D5 A/B Evaluation: Retriever temporal expiry filtering.
 *
 * Tests the retained expiry flag:
 * - temporalExpiry (default OFF): drops memories past valid_until
 *
 * Uses real embeddings + real SQLite store. No reranker (avoid external API).
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { createEmbedder, type Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	type RetrievalConfig,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-d5-eval-${Date.now()}`;
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface TestMemory {
	id: string;
	text: string;
	temporalType: "static" | "dynamic";
	validUntil: number | undefined;
	importance: number;
	/** Age in ms from NOW */
	ageMs: number;
}

/**
 * Test corpus per the D5 A/B evaluation plan.
 * IDs are assigned after store; indices are stable references.
 */
const CORPUS: Omit<TestMemory, "id">[] = [
	// Category A — True Dynamic, Expired (SHOULD be filtered by expiry)
	{
		text: "Today's standup was cancelled",
		temporalType: "dynamic",
		validUntil: NOW - 24 * HOUR,
		importance: 0.5,
		ageMs: 2 * DAY,
	},
	{
		text: "The server is currently down",
		temporalType: "dynamic",
		validUntil: NOW - 12 * HOUR,
		importance: 0.6,
		ageMs: DAY,
	},
	{
		text: "Tonight we have team dinner at 7pm",
		temporalType: "dynamic",
		validUntil: NOW - 6 * HOUR,
		importance: 0.5,
		ageMs: DAY,
	},

	// Category B — True Dynamic, Not Yet Expired
	{
		text: "Tomorrow's demo is at 2pm in the main conference room",
		temporalType: "dynamic",
		validUntil: NOW + 12 * HOUR,
		importance: 0.7,
		ageMs: 2 * HOUR,
	},
	{
		text: "This week we're doing sprint planning on Wednesday",
		temporalType: "dynamic",
		validUntil: NOW + 2 * DAY,
		importance: 0.6,
		ageMs: 4 * HOUR,
	},

	// Category C — Static / Permanent
	{
		text: "User prefers dark mode for all applications",
		temporalType: "static",
		validUntil: undefined,
		importance: 0.8,
		ageMs: 30 * DAY,
	},
	{
		text: "User's name is Alice Chen and she works as a senior engineer",
		temporalType: "static",
		validUntil: undefined,
		importance: 0.9,
		ageMs: 60 * DAY,
	},
	{
		text: "The main project uses PostgreSQL 16 as the primary database",
		temporalType: "static",
		validUntil: undefined,
		importance: 0.8,
		ageMs: 45 * DAY,
	},

	// Category D — Classifier edge cases
	{
		text: "Collateral damage from the refactor was minimal",
		temporalType: "static",
		validUntil: undefined,
		importance: 0.5,
		ageMs: 10 * DAY,
	},
	{
		text: "The bilateral trade agreement covers technology exports",
		temporalType: "static",
		validUntil: undefined,
		importance: 0.5,
		ageMs: 10 * DAY,
	},
	{
		text: "I'll handle the deployment configuration later this afternoon",
		temporalType: "dynamic",
		validUntil: undefined,
		importance: 0.5,
		ageMs: 2 * DAY,
	},
	{
		text: "He was born yesterday figuratively speaking about the new hire",
		temporalType: "dynamic",
		validUntil: NOW - 24 * HOUR,
		importance: 0.5,
		ageMs: 2 * DAY,
	},

	// Category E — Expired but still valuable (KEY evaluation targets)
	{
		text: "Meeting notes from yesterday covered the architecture review",
		temporalType: "dynamic",
		validUntil: NOW - 18 * HOUR,
		importance: 0.7,
		ageMs: DAY,
	},
	{
		text: "Last week's sprint velocity was 42 story points completed",
		temporalType: "dynamic",
		validUntil: NOW - 4 * DAY,
		importance: 0.6,
		ageMs: 5 * DAY,
	},
	{
		text: "Today I learned about Rust lifetimes and borrowing patterns",
		temporalType: "dynamic",
		validUntil: NOW - 18 * HOUR,
		importance: 0.8,
		ageMs: DAY,
	},
	{
		text: "Yesterday we decided to use gRPC instead of REST for the internal API",
		temporalType: "dynamic",
		validUntil: NOW - 24 * HOUR,
		importance: 0.9,
		ageMs: 2 * DAY,
	},
];

function buildMetadataJson(
	temporalType: "static" | "dynamic",
	validUntil: number | undefined,
): string {
	return JSON.stringify({
		source: "ambient-learning",
		memory_temporal_type: temporalType,
		valid_until: validUntil,
	});
}

function makeRetrieverConfig(
	overrides: Partial<RetrievalConfig>,
): RetrievalConfig {
	return {
		...DEFAULT_RETRIEVAL_CONFIG,
		rerank: "none",
		hardMinScore: 0,
		minScore: 0,
		...overrides,
	};
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("D5: Retriever temporal expiry filtering", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;
	let storedIds: string[];

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });

		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const texts = CORPUS.map((c) => c.text);
		const vectors = await embedder.embedMany(texts);

		const sqlite = (
			store as unknown as {
				sqlite: {
					prepare: (sql: string) => {
						run: (...args: unknown[]) => void;
					};
				};
			}
		).sqlite;

		storedIds = [];
		for (let i = 0; i < CORPUS.length; i++) {
			const entry = CORPUS[i];
			const vector = vectors[i];
			if (!entry || !vector) continue;

			const stored = await store.store({
				text: entry.text,
				vector,
				category: "episodic",
				projectId: "global",
				importance: entry.importance,
				metadata: buildMetadataJson(entry.temporalType, entry.validUntil),
			});
			storedIds.push(stored.id);

			// Override timestamp to simulate age
			const timestamp = NOW - entry.ageMs;
			sqlite
				.prepare("UPDATE nodix_memories SET timestamp = ? WHERE id = ?")
				.run(timestamp, stored.id);
		}
	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	it("temporalExpiry OFF: no memories are dropped", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const retriever = createRetriever(
			store,
			embedder,
			{ warn: () => {} },
			makeRetrieverConfig({
				temporalExpiry: false,
			}),
		);

		// Query that matches expired Category A memories
		const results = await retriever.retrieve({
			query: "what happened at standup",
			limit: 16,
		});

		// With expiry OFF, expired memories should still be present
		expect(results.length).toBeGreaterThan(0);

		// Specifically check that expired memory #0 ("standup cancelled") is in results
		const standupId = storedIds[0];
		const hasStandup = results.some((r) => r.entry.id === standupId);
		expect(hasStandup).toBe(true);
	});

	it("temporalExpiry ON: expired memories are dropped from results", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const retriever = createRetriever(
			store,
			embedder,
			{ warn: () => {} },
			makeRetrieverConfig({
				temporalExpiry: true,
			}),
		);

		// Query that matches expired Category A memories
		const results = await retriever.retrieve({
			query: "what happened at standup",
			limit: 16,
		});

		// Expired memory #0 ("standup cancelled") should NOT be in results
		const standupId = storedIds[0];
		const hasStandup = results.some((r) => r.entry.id === standupId);
		expect(hasStandup).toBe(false);
	});

	it("temporalExpiry ON: live dynamic memories survive", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const retriever = createRetriever(
			store,
			embedder,
			{ warn: () => {} },
			makeRetrieverConfig({
				temporalExpiry: true,
			}),
		);

		// Query that should match Category B #3 ("tomorrow's demo")
		const results = await retriever.retrieve({
			query: "when is the demo",
			limit: 16,
		});

		const demoId = storedIds[3];
		const hasDemo = results.some((r) => r.entry.id === demoId);
		expect(hasDemo).toBe(true);
	});

	it("temporalExpiry ON: static memories always survive", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const retriever = createRetriever(
			store,
			embedder,
			{ warn: () => {} },
			makeRetrieverConfig({
				temporalExpiry: true,
			}),
		);

		// Query for static Category C #7 ("PostgreSQL 16")
		const results = await retriever.retrieve({
			query: "what database does the project use",
			limit: 16,
		});

		const pgId = storedIds[7];
		const hasPg = results.some((r) => r.entry.id === pgId);
		expect(hasPg).toBe(true);
	});

	it("temporalExpiry ON: Category E knowledge/decisions are dropped (false positive cost)", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const retriever = createRetriever(
			store,
			embedder,
			{ warn: () => {} },
			makeRetrieverConfig({
				temporalExpiry: true,
			}),
		);

		// Query for #14 "Rust lifetimes" — expired KNOWLEDGE, not an event
		const rustResults = await retriever.retrieve({
			query: "what did I learn about Rust",
			limit: 16,
		});
		const rustId = storedIds[14];
		const hasRust = rustResults.some((r) => r.entry.id === rustId);

		// Query for #15 "gRPC decision" — expired DECISION, not an event
		const grpcResults = await retriever.retrieve({
			query: "what did we decide about the API",
			limit: 16,
		});
		const grpcId = storedIds[15];
		const hasGrpc = grpcResults.some((r) => r.entry.id === grpcId);

		// These ARE false positives — valuable memories dropped by expiry.
		// This test documents the behavior. If both are dropped, it confirms
		// the classifier is too coarse for hard filtering on knowledge/decisions.
		// The recommendation is to keep temporalExpiry OFF by default.
		expect(hasRust).toBe(false);
		expect(hasGrpc).toBe(false);
	});
});
