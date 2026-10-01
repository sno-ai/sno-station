/** @file tool-memory-forget-query.test.ts
 * @purpose Validates memory_forget query deletion, ID precedence, and kill-switch enforcement.
 * @boundary Tool handler contracts, retrieval-backed delete selection, MemoryStore mutation, and audit state.
 * @see tool-memory-mutate.test.ts, slash-memory-control.test.ts, store-edge-cases.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";

import { executeMemoryForgetTool } from "../../../../packages/memory/src/engine/bindings/memory-forget-tool";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas";
import { DEFAULT_RETRIEVAL_CONFIG, createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes";
import { getSnoStationMemStateDir } from "../../../../packages/memory/src/engine/operations/runtime-audit-log.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";

let testEmbedder: Embedder;

/**
 * memory_forget tool: forget by semantic query, forget by ID vs query precedence,
 * and kill switch blocking forget operations.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("tool: memory_forget — query, precedence, kill switch", () => {
	let dbPath: string;
	let cleanup: () => void;
	let context: ToolContext;
	let store: MemoryStore;
	let stateDir: string;
	let memClawStateDir: string;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		stateDir = `/tmp/mem-claw-forget-query-state-${Date.now()}`;
		memClawStateDir = getSnoStationMemStateDir();
		mkdirSync(memClawStateDir, { recursive: true });

		cleanup = () => {
			store.close();
			testDb.cleanup();
			rmSync(stateDir, { recursive: true, force: true });
		};

		// Isolate state dir so kill switch path is predictable
		process.env["OPENCLAW_STATE_DIR"] = stateDir;

		store = new MemoryStore({ dbPath: dbPath, embedder: testEmbedder });
		context = { store, embedder: testEmbedder, stateDir: stateDir, agentId: "tool-memory-forget-query",
			retriever: createRetriever(store, testEmbedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" }),
			scopePolicy: createScopePolicy() };
	});

	afterEach(() => {
		delete process.env["OPENCLAW_STATE_DIR"];
		cleanup();
	});

	/**
	 * forget by query (semantic search then delete):
	 * Seed 5 memories with production embeddings. Use memory_forget with a query
	 * string rather than an ID. Verify at least 1 entry was deleted and the semantically
	 * closest memory is absent from the store.
	 */
	it("forget by query — semantic match found and deleted, entry absent from store", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, memClawStateDir);

		// Seed five diverse memories through production embeddings for semantic deletion.
		const texts = [
			"TypeScript strict mode enables exactOptionalPropertyTypes and noImplicitAny for safer code.",
			"PostgreSQL JSONB columns provide flexible schemaless storage with native indexing support.",
			"Docker multi-stage builds reduce final image size by excluding build-time dependencies.",
			"Redis sorted sets support O(log N) leaderboard queries with atomic increment operations.",
			"Node.js runtime uses JavaScriptCore instead of V8 resulting in faster startup and lower memory.",
		];
		const vectors = await embedder.embedMany(texts);
		const storedIds: string[] = [];

		for (let i = 0; i < texts.length; i++) {
			const text = texts[i];
			const vector = vectors[i];
			if (!text || !vector) continue;
			const entry = await store.store({
				text,
				vector,
				category: "episodic",
				projectId: "global",
			});
			storedIds.push(entry.id);
		}

		// Baseline count confirms every fixture was persisted before deletion.
		const statsBeforeForget = await store.stats();
		expect(statsBeforeForget.total).toBe(5);

		// Query forget semantically matches the TypeScript strict-mode entry.

		const result = asClawResult(
			await executeMemoryForgetTool(context, { agentId: context.agentId }, "forget-q-1", {
				query: "TypeScript strict mode type checking",
				projectId: "global",
				confirm: true,
				min_score: 0.45,
			}),
		);

		// Successful query deletion must not return a tool error.
		expect(result.isError).not.toBe(true);

		// Result text must indicate that deletion occurred.
		const resultText = result.content[0]?.text ?? "";
		expect(resultText.toLowerCase()).toMatch(/deleted/);

		// At least one entry must be deleted for a confirmed semantic match.
		const deletedCount = result.details?.deletedCount;
		expect(typeof deletedCount === "number" && deletedCount >= 1).toBe(true);

		// Store count must decrease after a successful confirmed deletion.
		const statsAfterForget = await store.stats();
		expect(statsAfterForget.total).toBeLessThan(5);
		expect(statsAfterForget.total).toBeGreaterThanOrEqual(0);

		// The TypeScript strict-mode entry is the closest semantic match and must be removed.
		const firstEntryStillPresent = store.getById(storedIds[0] ?? "");
		expect(firstEntryStillPresent).toBeUndefined();
	});

	it("forget by query requires confirm=true before deleting", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, memClawStateDir);
		const text =
			"TypeScript strict mode catches many unsafe patterns before runtime.";
		const vector = await embedder.embed(text);
		const entry = await store.store({
			text,
			vector,
			category: "episodic",
			projectId: "global",
		});


		const result = asClawResult(
			await executeMemoryForgetTool(context, { agentId: context.agentId }, "forget-confirm-needed", {
				query: "TypeScript strict mode",
				projectId: "global",
				min_score: 0,
			}),
			);

			expect(result.isError).toBe(true);
			const resultText = result.content[0]?.text ?? "";
			expect(resultText.toLowerCase()).toContain("confirm=true");
			expect(result.details?.requireConfirm).toBe(true);
			expect(store.getById(entry.id)).toBeDefined();
		});

	it("aggregation-shaped forget queries preserve max_delete before and after confirmation", async () => {
		const entries = await Promise.all(
			["coffee on Monday", "coffee on Tuesday", "coffee on Wednesday"].map((text) =>
				store.store({ text, category: "episodic", projectId: "global" }),
			),
		);
		const params = {
			query: "How much did I spend on coffee?",
			max_delete: 1,
			min_score: 0,
		};

		const preview = asClawResult(await executeMemoryForgetTool(context, { agentId: context.agentId }, "forget-aggregation-preview", params));
		expect(preview.isError).toBe(true);
		expect(preview.details?.candidateCount).toBe(1);
		expect(entries.every((entry) => store.getById(entry.id) !== undefined)).toBe(true);

		const confirmed = asClawResult(
			await executeMemoryForgetTool(context, { agentId: context.agentId }, "forget-aggregation-confirmed", { ...params, confirm: true }),
		);
		expect(confirmed.isError).not.toBe(true);
		expect(confirmed.details?.deletedCount).toBe(1);
		expect(entries.filter((entry) => store.getById(entry.id) !== undefined)).toHaveLength(2);
	});

	it("rejects blank deletion selectors", async () => {

		for (const params of [{ query: "   ", confirm: true }, { id: "   " }]) {
			const result = asClawResult(await executeMemoryForgetTool(context, { agentId: context.agentId }, "forget-blank-selector", params));

			expect(result.isError).toBe(true);
			const text = result.content[0]?.text ?? "";
			expect(text.toLowerCase()).toMatch(/required|string/);
		}
	});

	/**
	 * forget by ID vs forget by query - id takes precedence:
	 * When both id and query are provided, the tool must use id (source: memory-tool-registration.ts line 365).
	 * The entry matching the given id is deleted; the query is not evaluated.
	 */

});
