import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MAX_CANDIDATE_POOL_SIZE } from "../../../../packages/memory/config/index.ts";
import { createSnoStationMemRemPorts } from "../../../../packages/memory/src/store/rem-sqlite-adapter.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("REM facet retrieval", () => {
	let testDb: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(() => {
		store?.close();
		testDb?.cleanup();
		store = undefined;
		testDb = undefined;
	});

	it("filters one normalized chunk index by current versus history policy", async () => {
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		const retired = await store.store({
			text: "The user preferred coffee before switching to tea.",
			category: "episodic",
			projectId: "global",
			importance: 0.8,
		});
		const successor = await store.store({
			text: "The user currently prefers tea.",
			category: "episodic",
			projectId: "global",
			importance: 0.8,
		});
		const ports = createSnoStationMemRemPorts({
			database: testDb.runtime.db,
		});
		const closed = await ports.conflict.softClose({
			rowId: retired.id,
			successorId: successor.id,
			plannedContentHash: retired.contentHash,
			plannedSuccessorContentHash: successor.contentHash,
			reason: "The successor is the current preference.",
			timestamp: "2026-08-05T17:00:00.000Z",
		});
		expect(closed.applied).toBe(true);
		expect(
			testDb.sqlite
				.prepare("SELECT facet FROM nodix_rem_memory_facets WHERE memory_id = ?")
				.all(retired.id),
		).toEqual([{ facet: "history" }]);
		testDb.sqlite
			.prepare("UPDATE nodix_memories SET text = ?, timestamp = ? WHERE id = ?")
			.run("The user currently prefers tea with honey.", 123, successor.id);
		expect(
			testDb.sqlite
				.prepare("SELECT text FROM nodix_rem_memory_facets WHERE memory_id = ? AND facet = 'current'")
				.get(successor.id),
		).toEqual({ text: "The user currently prefers tea with honey." });

		const vector = await embedder.embed("What does the user prefer to drink?");
		const current = await store.searchChunksSemantic(vector, {
			limit: 10,
			facetPolicy: "current-only",
		});
		const history = await store.searchChunksSemantic(vector, {
			limit: 10,
			facetPolicy: "include-history",
		});

		// The mechanism is intact; only its automatic caller is gone. A caller that knows it wants
		// one or the other still says so, and the store still obeys.
		//
		// HONEST LIMIT, so this case does not imply more than it proves: `c.facet` appears only in
		// the WHERE clauses (memory-store-chunk-search.ts:89 and :261), never in the SELECT lists
		// (:72 and :246). A consumer handed both rows cannot yet tell which value is current. In
		// the scored wave exactly one row across six persona stores was ever retired, so that is
		// not a live exposure today — but it becomes one the moment supersession starts working.
		expect(current.some((result) => result.parentMemoryId === retired.id)).toBe(false);
		expect(history.some((result) => result.parentMemoryId === retired.id)).toBe(true);

		const retriever = createRetriever(store, embedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			minScore: 0,
		});
		// `limit: 1` and two matching rows on purpose: a counting question reads the population, so
		// the reading budget must not decide membership. Asserting one row here is what a 2026-08-08
		// change made this assertion say, and the truncation it certified cost MPA 0.098.
		const aggregation = await retriever.retrieve({
			query: "How much did the user spend on coffee?",
			limit: 1,
			aggregation: { operation: "evidence", terms: ["tea"] },
		});
		expect(aggregation.map((result) => result.entry.id).sort()).toEqual(
			[retired.id, successor.id].sort(),
		);

		// THE RULE THIS CASE NOW PINS. Both wordings below used to hide the retired row, because
		// three regexes over the query text decided whether a question was allowed to see a
		// superseded value — "what tasks do I have" and "how many upcoming events" were listed as
		// current-only, "used to" was listed as history, and everything else fell through to
		// current-only. Measured 2026-08-19 that sent 372 of 540 real benchmark questions down the
		// hiding path, and 6 of 8 plausible "what did I used to..." probes never saw their own
		// history because only the literal phrase "used to" was on the list. Whether a question
		// needs a retired value is a question of meaning; scoring answers it, not a word list.
		for (const query of ["What tasks do I have?", "How many upcoming events do I have?"]) {
			const byWording = await retriever.retrieve({ query, limit: 10 });
			expect(
				byWording.some((result) => result.entry.id === retired.id),
				`"${query}" must not be what decides the retired value is invisible`,
			).toBe(true);
		}

		const historicalTasks = await retriever.retrieve({
			query: "What tasks were open last week?",
			limit: 10,
		});
		expect(historicalTasks.some((result) => result.entry.id === retired.id)).toBe(true);
	});

	it("serves every matching memory, past the retired ceiling and past the caller's budget", async () => {
		// One more than the ceiling this path used to impose, so the fixture can tell the two
		// designs apart: a store that stopped at the ceiling would score identically under both.
		const seeded = MAX_CANDIDATE_POOL_SIZE + 1;
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		const storedIds: string[] = [];
		for (let index = 0; index < seeded; index += 1) {
			const memory = await store.store({
				text: `Coffee purchase ${index}: $1.00.`,
				category: "episodic",
				projectId: "global",
				importance: 0.8,
			});
			storedIds.push(memory.id);
		}
		const retriever = createRetriever(store, embedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			minScore: 0,
		});

		const aggregation = await retriever.retrieve({
			query: "How much did the user spend on coffee?",
			limit: 1,
			aggregation: { operation: "evidence", terms: ["coffee"] },
		});

		// Membership, not just the count: a total is wrong in the same way whether rows are missing
		// or silently swapped, and the failure this path had was losing the newest rows specifically.
		expect(aggregation).toHaveLength(seeded);
		expect(aggregation.map((result) => result.entry.id).sort()).toEqual([...storedIds].sort());
	});
});
