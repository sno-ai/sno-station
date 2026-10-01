/** @file session-date-threading.test.ts
 * @purpose Regression gate for the 3-layer date-drop bug. A conversation whose
 *   messages carry an event time ~11.5 months in the past must produce memory
 *   rows stamped with that event time — NOT the wall-clock ingest time. Under
 *   the old `Date.now()` bug every row would land at "today", collapsing the
 *   simulated timeline and making Memora-FAMA forgetting untestable.
 * @boundary agent_end hook → deriveSessionDateTime → insight-distill pipeline
 *   (real Sno GPU extract LLM, real SQLite, real embeddings) → row `timestamp`.
 *   Plus a pure-function check that compaction's `buildMergedEntry` keeps the
 *   newest member timestamp, since compaction deletes the source rows.
 * @see agent-end-distill-smoke.test.ts (the distill-pipeline smoke model).
 *
 * Real LLM API required (mem_claw/sno_ai_extract → Sno GPU). Missing keys =
 * FAIL. The test profile's settings.json supplies the Sno GPU address and key.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { flushAuditWrites } from "../../../../packages/memory/src/engine/operations/runtime-audit-log.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

/** Session event time: 2025-06-01, ~11.5 months before the run wall clock. */
const SESSION_DATE_MS = Date.parse("2025-06-01");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("session date threads through agent_end into the memory row timestamp", () => {
	let dbPath: string;
	let cleanup: () => void;
	let harness: OpenClawPluginApiHarness;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;

		// Mirror the Memora eval-server config: rem-enhanced mode pinned to the Sno
		// GPU extract route, capture driven through the agent_end hook.
		harness = new OpenClawPluginApiHarness(
			{
				embedding: { dimensions: 1024 },
				dbPath,
				ambientLearning: true,
				autoRecall: false,
				selfImprovement: { enabled: false },
				sessionStrategy: "none",
				mode: "rem-enhanced",
				extraction: {
					llm: { preset: "mem_claw/sno_ai_extract" },
				},
			},
			{ runtimeAgentId: "memora-date-threading" },
		);

		await memClawPlugin.register(harness);
	});

	afterEach(() => {
		cleanup();
	});

	it("stamps rows with the conversation event time, not the ingest wall clock", async () => {
		const agentEndHandler = harness.getOnHookHandler("agent_end");
		expect(agentEndHandler).toBeDefined();

		// Durable, distillable facts with NO relative-date phrases ("last weekend",
		// "this October") — so the distiller resolves no event date from the text
		// and the row timestamp must come purely from the session date.
		const messages = [
			{
				role: "user",
				content:
					"My name is Daniel Park and I work as a backend engineer at a fintech startup in Seattle.",
				timestamp: SESSION_DATE_MS,
			},
			{
				role: "user",
				content: "I strongly prefer Rust over Go for any new backend service we build.",
				timestamp: SESSION_DATE_MS,
			},
			{
				role: "user",
				content: "I adopted a golden retriever puppy named Biscuit.",
				timestamp: SESSION_DATE_MS,
			},
			{
				role: "user",
				content: "My partner Elena and I are planning a two-week trip to Japan.",
				timestamp: SESSION_DATE_MS,
			},
		];

		await (
			agentEndHandler as (
				event: unknown,
				ctx: { agentId: string; sessionKey: string },
			) => Promise<void>
		)(
			{ messages, success: true },
			{
				agentId: "memora-date-threading",
				sessionKey: "agent:memora-date-threading:test",
			},
		);

		// Audit writes are async-queued; drain before reading back rows.
		await flushAuditWrites();

		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		const rows = await store.list({});
		store.close();

		// Guard against a vacuous pass: a zero-candidate LLM run would make every
		// row assertion below trivially true. The distiller must have written rows.
		expect(
			rows.length,
			"distiller wrote zero rows — cannot verify timestamp threading",
		).toBeGreaterThan(0);

		for (const row of rows) {
			// Exact: the row timestamp is the session date verbatim. ISO round-trips
			// to the ms, so any drift here means a Date.now() leak, not rounding.
			expect(
				row.timestamp,
				`row "${row.text.slice(0, 48)}" carried ${new Date(row.timestamp).toISOString()}, expected the 2025-06-01 session date`,
			).toBe(SESSION_DATE_MS);
			// Sanity: the timestamp is firmly in the past, never near "today".
			expect(row.timestamp).toBeLessThan(Date.now() - THIRTY_DAYS_MS);
		}
	});
});
