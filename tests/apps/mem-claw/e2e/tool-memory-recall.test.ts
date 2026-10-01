/** @file tool-memory-recall.test.ts
 * @purpose Validates memory_recall ranking, result schema, threshold handling, and validation errors.
 * @boundary Tool handler contract, retrieval pipeline, MemoryStore search, and production embeddings.
 * @see auto-recall-flow.test.ts, store-vector-search-quality.test.ts, retriever-pipeline-bugs.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { countTokens } from "@snoai/chunking";
import { MAX_AGGREGATION_RESULT_TOKENS } from "../../../../packages/memory/config/index.ts";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { executeMemoryRecallTool } from "../../../../packages/memory/src/engine/bindings/memory-recall-tool";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { buildActiveTaskCarrierRow } from "../../../../packages/memory/src/store/active-task-carrier-row.ts";
import { recordTokenCounter } from "../../../../packages/memory/src/store/memory-store-write-validation.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult, type ClawToolResult, getRecallMemories } from "../helpers/tool-result.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-recall-state-${Date.now()}`;
/** The same view production budgets: the larger consumer's payload, never the sum of both. */
function consumerTokens(result: ClawToolResult): number {
	return Math.max(
		countTokens(result.content.map((part) => part.text ?? "").join("\n")),
		countTokens(JSON.stringify(result.details?.["memories"] ?? [])),
	);
}

function insertAggregationRows(
	store: MemoryStore,
	rows: Array<{ id: string; text: string; timestamp: number }>,
): void {
	const insertMemory = store.sqlite.prepare(
		// `timezone` has no default and a trigger refuses an empty one — a stored memory always
		// carries the zone its timestamp was read in. A raw insert has to say it, as production does.
		"INSERT INTO nodix_memories(id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, 'episodic', 'global', 0.7, ?, 'UTC', '{}', ?)",
	);
	const insertChunk = store.sqlite.prepare(
		"INSERT INTO nodix_memory_chunks(chunk_id, memory_id, chunk_index, chunk_text, dense_payload, start_offset, end_offset, token_count, content_type, chunking_version, embedder_provider, embedder_model, embedder_dim, created_at, updated_at) VALUES (?, ?, 0, ?, ?, 0, ?, 1, 'prose', 'test', 'test', 'test', 1024, ?, ?)",
	);
	store.sqlite.transaction(() => {
		for (const row of rows) {
			insertMemory.run(row.id, row.id, row.text, row.timestamp, row.id);
			insertChunk.run(
				`${row.id}:0`,
				row.id,
				row.text,
				row.text,
				row.text.length,
				row.timestamp,
				row.timestamp,
			);
		}
	})();
}

/**
 * memory_recall tool: tests exact match, related-but-different, scope-filtered
 * (mismatch -> 0 results), and empty query edge case.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("tool: memory_recall", () => {
	let dbPath: string;
	let cleanup: () => void;
	let context: ToolContext;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;

		const toolStore = new MemoryStore({ dbPath, embedder: testEmbedder });
		context = { store: toolStore, embedder: testEmbedder, agentId: "tool-memory-recall", stateDir: STATE_DIR,
			scopePolicy: createScopePolicy(), retriever: createRetriever(toolStore, testEmbedder,
				{ warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, minScore: 0.2, rerank: "none" }) };

		// Seed 10 memories directly so recall exercises production embeddings and retrieval only.
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		const texts = [
			{
				text: "TypeScript strict mode prevents implicit any and null reference errors.",
				projectId: "global",
			},
			{
				text: "Node.js runtime includes a built-in SQLite driver for fast database access.",
				projectId: "global",
			},
			{
				text: "React hooks provide state management without class components.",
				projectId: "global",
			},
			{
				text: "Zod schema validation offers compile-time type safety for API inputs.",
				projectId: "global",
			},
			{
				text: "Rust ownership system prevents memory leaks and use-after-free bugs.",
				projectId: "global",
			},
			{
				text: "Redis in-memory store enables microsecond response times for caching.",
				projectId: "global",
			},
			{
				text: "Docker containers isolate application processes with their dependencies.",
				projectId: "global",
			},
			{
				text: "PostgreSQL MVCC enables high concurrency without explicit locking.",
				projectId: "global",
			},
			{
				text: "Kubernetes pod autoscaling adjusts replica counts based on CPU load.",
				projectId: "global",
			},
			{
				text: "Git feature branches enable parallel development with clean merges.",
				projectId: "other-scope",
			},
		];

		const vectors = await embedder.embedMany(texts.map((t) => t.text));
		for (let i = 0; i < texts.length; i++) {
			const t = texts[i];
			const v = vectors[i];
			if (!t || !v) continue;
			await store.store({
				text: t.text,
				vector: v,
				category: "episodic",
				projectId: t.projectId,
			});
		}
		store.close();
	}, 30_000);

	afterEach(async () => {
		await context.store.close();
		cleanup();
	});

	it("exact match query returns results containing TypeScript info", async () => {

		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "call-1", {
				query: "TypeScript strict mode null checks",
				top_k: 5,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);

		expect(result.content.length).toBeGreaterThan(0);
		const text = result.content[0]?.text ?? "";
		expect(result.isError).not.toBe(true);
		expect(text).not.toBe("No relevant memories found.");
		expect(text.length).toBeGreaterThan(0);

		const memories = getRecallMemories<{
			id: string;
			text: string;
			category: string;
			rawCategory?: string;
			scope: string;
			importance: number;
			timestamp: string;
		}>(result);
		expect(memories.length).toBeGreaterThan(0);

		// The top result must contain the seeded TypeScript strict-mode text.
		const topMemory = memories[0];
		if (!topMemory) throw new Error("exact recall returned no memories");
		expect(topMemory.text).toContain("TypeScript strict mode");
		expect(topMemory.category).toBe("episodic:global");
		expect(topMemory.rawCategory).toBe("episodic");
		expect(topMemory.scope).toBe("global");
		expect(typeof topMemory.id).toBe("string");
		expect(topMemory.id.length).toBeGreaterThan(0);
		expect(typeof topMemory.importance).toBe("number");
		expect(topMemory.importance).toBeGreaterThan(0);
		// Timestamps are serialized as ISO strings for downstream clients.
		expect(Number.isNaN(Date.parse(topMemory.timestamp))).toBe(false);
	});

	it("carries the fact id on every recalled row", async () => {
		// The recall SELECT once omitted fact_id, so every returned row came back without
		// one. Nothing downstream could tell that apart from a row that genuinely has no
		// fact id, and the recall usage events were dropped silently — the Sno Observe
		// recall stream went empty for six agent phases before anyone read the reason.
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			const semantic = await store.searchSemantic(
				await testEmbedder.embed("TypeScript strict mode null checks"),
				{ limit: 5 },
			);
			expect(semantic.length).toBeGreaterThan(0);
			for (const row of semantic) {
				expect(row.entry.factId).toBeTypeOf("string");
			}

			const keyword = await store.searchKeyword("TypeScript", { limit: 5 });
			expect(keyword.length).toBeGreaterThan(0);
			for (const row of keyword) {
				expect(row.entry.factId).toBeTypeOf("string");
			}

			const firstSemantic = semantic[0];
			if (!firstSemantic) throw new Error("semantic recall returned no memories");
			expect(store.getById(firstSemantic.entry.id)?.factId).toBeTypeOf("string");
		} finally {
			store.close();
		}
	});

	it("related-but-different query still returns valid results with non-empty text", async () => {

		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "call-2", {
				query: "JavaScript runtime database performance",
				top_k: 3,
				// This test verifies that a related-but-not-exact query returns valid,
				// schema-conforming results — not that the default score threshold is
				// lenient. With this suite's 10 seeds, RRF fusion dilutes the top score
				// for this deliberately weak query below DEFAULT_MIN_SCORE (0.45), so we
				// pin a permissive threshold to exercise the result-shape contract.
				min_score: 0.2,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);

		expect(result.content.length).toBeGreaterThan(0);
		const text = result.content[0]?.text ?? "";
		expect(result.isError).not.toBe(true);
		expect(text).not.toBe("No relevant memories found.");

		const memories = getRecallMemories<{
			id: string;
			text: string;
			category: string;
			rawCategory?: string;
			scope: string;
			importance: number;
			timestamp: string;
		}>(result);
		expect(memories.length).toBeGreaterThan(0);
		expect(memories.length).toBeLessThanOrEqual(3); // respects top_k

		// Every returned memory must satisfy the public recall result schema.
		for (const memory of memories) {
			expect(typeof memory.id).toBe("string");
			expect(memory.id.length).toBeGreaterThan(0);
			expect(typeof memory.text).toBe("string");
			expect(memory.text.length).toBeGreaterThan(0);
			expect(memory.category).toBe("episodic:global");
			expect(memory.rawCategory).toBe("episodic");
			expect(memory.scope).toBe("global");
		}

		// The Node.js runtime entry is the closest semantic match for this query.
		const nodeEntry = memories.find((m) => m.text.includes("Node.js runtime"));
		expect(nodeEntry).toBeDefined();
	});

	it("reads the complete structured coffee population", async () => {
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			// beforeEach stores nine globally readable rows; add 312 more to reach 321.
			insertAggregationRows(store, [
				{ id: "oldest-aggregation", text: "OLDEST_AGGREGATION_SENTINEL", timestamp: 1 },
				...Array.from({ length: 311 }, (_, index) => ({
					id: `coffee-${index}`,
					text: `Coffee purchase ${index}: $1.00.`,
					timestamp: Date.now() + 60_000 + index,
				})),
			]);
		} finally {
			store.close();
		}
		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "aggregation-overflow", {
				query: "How much did I spend on coffee?",
				aggregation: { operation: "evidence", terms: ["coffee"] },
				top_k: 10,
				min_score: 0,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);

		expect(result.isError).not.toBe(true);
		const memories = getRecallMemories<{ text: string }>(result);
		// Structured evidence returns every matching coffee row and excludes the unrelated seed rows.
		expect(memories).toHaveLength(311);
		expect(memories.some((memory) => memory.text.includes("Coffee purchase 0:"))).toBe(true);
		expect(memories.some((memory) => memory.text.includes("Coffee purchase 310"))).toBe(true);
		expect(memories.some((memory) => memory.text.includes("OLDEST_AGGREGATION_SENTINEL"))).toBe(
			false,
		);
		expect(result.details?.truncated).toBe(false);
		expect(result.details?.scopeRowCount).toBe(311);
		expect(result.content[0]?.text).toContain('scope-row-count="311"');
		expect(result.content[0]?.text).toContain(`returned-count="${memories.length}"`);
		expect(result.content[0]?.text).toContain('truncated="false"');
		// The budget is TOKENS against what ONE consumer receives — the larger of the two views,
		// never their sum. `JSON.stringify(result).length` was the old assertion and it embodied the
		// defect: the rendered text and `memories` carry the same rows, the OpenClaw host reads only
		// the first and the eval only the second, so charging each for the other's copy is what
		// shrank the real budget.
		// The exact length and population-complete marker above prove the budget did not cut the set.
		expect(consumerTokens(result)).toBeLessThanOrEqual(MAX_AGGREGATION_RESULT_TOKENS);
	});

	it("answers structured first, last, and count aggregations beyond the row ceiling", async () => {
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			insertAggregationRows(store, [
				...Array.from({ length: 330 }, (_, index) => ({
					id: `unrelated-${index}`,
					text: `Unrelated archive row ${index}.`,
					timestamp: index + 1,
				})),
				...[
					{ marker: "FIRST_BLUE_HERON_VISIT", timestamp: 5 },
					{ marker: "MIDDLE_BLUE_HERON_VISIT", timestamp: 170 },
					{ marker: "LAST_BLUE_HERON_VISIT", timestamp: 328 },
				].map((visit) => ({
					id: visit.marker.toLowerCase(),
					text: `${visit.marker}: Blue Heron observatory. ${"Long bounded evidence. ".repeat(700)}`,
					timestamp: visit.timestamp,
				})),
			]);
		} finally {
			store.close();
		}
		const execute = async (operation: "count" | "evidence" | "first" | "last") =>
			asClawResult(
				await executeMemoryRecallTool(context, { agentId: context.agentId }, `structured-${operation}`, {
					query: `${operation} Blue Heron visit`,
					aggregation: { operation, terms: ["Blue Heron"] },
					min_score: operation === "count" ? 1 : 0,
				}, { name: "memory_recall", label: "Memory Recall", description: "" }),
			);

		const first = await execute("first");
		const last = await execute("last");
		const count = await execute("count");
		const evidence = await execute("evidence");

		expect(getRecallMemories<{ text: string }>(first)[0]?.text).toContain(
			"FIRST_BLUE_HERON_VISIT",
		);
		expect(getRecallMemories<{ text: string }>(last)[0]?.text).toContain(
			"LAST_BLUE_HERON_VISIT",
		);
		expect(count.details?.scopeRowCount).toBe(3);
		expect(getRecallMemories<{ text: string }>(evidence)).toHaveLength(3);
		for (const result of [first, last, count, evidence]) {
			expect(result.details?.populationComplete).toBe(true);
			expect(result.details?.truncated).toBe(true);
			expect(consumerTokens(result)).toBeLessThanOrEqual(MAX_AGGREGATION_RESULT_TOKENS);
		}
	}, 30_000);

	it("keeps the highest-ranked aggregation prefix when the token budget cuts rows", async () => {
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			insertAggregationRows(
				store,
				Array.from({ length: 320 }, (_, index) => ({
					id: `ranked-overflow-${index}`,
					text: `${index === 0 ? "TOP_RANKED_SENTINEL" : index === 319 ? "TAIL_RANKED_SENTINEL" : `RANKED_${index}`} priority evidence ${"bounded filler ".repeat(200)}`,
					timestamp: index + 1,
				})),
			);
		} finally {
			store.close();
		}
		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "ranked-aggregation-overflow", {
				query: "Show priority evidence",
				aggregation: { operation: "evidence", terms: ["priority evidence"] },
				min_score: 0,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
		const memories = getRecallMemories<{ text: string }>(result);

		expect(result.details?.truncated).toBe(true);
		expect(memories.length).toBeGreaterThan(0);
		expect(memories.length).toBeLessThan(320);
		expect(memories[0]?.text).toContain("TOP_RANKED_SENTINEL");
		expect(getRecallMemories<{ id: string }>(result).map(memory => memory.id))
			.toEqual(Array.from({ length: memories.length }, (_, index) => `ranked-overflow-${index}`));
		expect(memories.some((memory) => memory.text.includes("TAIL_RANKED_SENTINEL"))).toBe(
			false,
		);
		expect(consumerTokens(result)).toBeLessThanOrEqual(MAX_AGGREGATION_RESULT_TOKENS);
	}, 30_000);

	it("matches any token within one structured aggregation term", async () => {
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			await store.store({
				text: "I recorded one step today.",
				category: "episodic",
				projectId: "global",
			});
		} finally {
			store.close();
		}
		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "structured-multi-word-term", {
				query: "Count my daily step records",
				aggregation: { operation: "count", terms: ["daily step count"] },
				min_score: 0,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);

		expect(result.details?.scopeRowCount).toBe(1);
		expect(result.details?.populationComplete).toBe(true);
	});

	it("labels current and historical facets in aggregation evidence", async () => {
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			const stored = await store.store({
				text: "HISTORY_FACET_DISTRACTOR: The budget was $400.",
				category: "episodic",
				projectId: "global",
			});
			const row = store.sqlite
				.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?")
				.get(stored.id) as { content_hash: string };
			await store.applyRemTextVersion({
				attemptId: "aggregation-facet-attempt",
				jobId: "aggregation-facet-test",
				jobType: "rem-update",
				rowId: stored.id,
				plannedContentHash: row.content_hash,
				replacementText: "CURRENT_FACET_TARGET: The budget is $500.",
				historyText: stored.text,
				reason: "Verify aggregation rendering preserves facet labels.",
				timestamp: "2026-08-13T20:00:00.000Z",
			});

			const results = await store.searchAggregationEvidence({
				projectIdFilter: ["global"],
				facetPolicy: "include-history",
			});
			const result = results.find(({ entry }) => entry.id === stored.id);
			expect(result?.snippet).toContain("[current] CURRENT_FACET_TARGET");
			expect(result?.snippet).toContain("[history] HISTORY_FACET_DISTRACTOR");
			const defaultCurrentAggregation = asClawResult(
				await executeMemoryRecallTool(context, { agentId: context.agentId }, "aggregation-default-current", {
					query: "What is my current budget?",
					aggregation: { operation: "count", terms: ["CURRENT_FACET_TARGET"] },
					min_score: 0,
				}, { name: "memory_recall", label: "Memory Recall", description: "" }),
			);
			const defaultHistoryAggregation = asClawResult(
				await executeMemoryRecallTool(context, { agentId: context.agentId }, "aggregation-default-history", {
					query: "What was my previous budget?",
					aggregation: { operation: "count", terms: ["HISTORY_FACET_DISTRACTOR"] },
					min_score: 0,
				}, { name: "memory_recall", label: "Memory Recall", description: "" }),
			);
			const explicitHistoryAggregation = asClawResult(
				await executeMemoryRecallTool(context, { agentId: context.agentId }, "aggregation-explicit-history", {
					query: "What was my previous budget?",
					aggregation: { operation: "count", terms: ["HISTORY_FACET_DISTRACTOR"] },
					include_history: true,
					min_score: 0,
				}, { name: "memory_recall", label: "Memory Recall", description: "" }),
			);
			expect(defaultCurrentAggregation.details?.scopeRowCount).toBe(1);
			expect(defaultHistoryAggregation.details?.scopeRowCount).toBe(0);
			expect(explicitHistoryAggregation.details?.scopeRowCount).toBe(1);

			const recall = asClawResult(
				await executeMemoryRecallTool(context, { agentId: context.agentId }, "aggregation-facet-labels", {
					query: "How much did I spend previously?",
					min_score: 0,
				}, { name: "memory_recall", label: "Memory Recall", description: "" }),
			);
			const recalled = getRecallMemories<{ id: string; text: string }>(recall).find(
				(memory) => memory.id === stored.id,
			);
			// Owner ruling 2026-08-26: a rewritten row answers with its current value only.
			// The aggregation call above asks for `include-history` explicitly and still gets
			// both, labelled; plain recall must not hand a reader the value REM just retired.
			// The row itself is still returned — this is about its text, not its visibility.
			expect(recalled?.text).toContain("CURRENT_FACET_TARGET");
			expect(recalled?.text).not.toContain("HISTORY_FACET_DISTRACTOR");

			const historicalRecall = asClawResult(
				await executeMemoryRecallTool(context, { agentId: context.agentId }, "historical-facet-labels", {
					query: "How much did I spend previously?",
					include_history: true,
					min_score: 0,
				}, { name: "memory_recall", label: "Memory Recall", description: "" }),
			);
			const historical = getRecallMemories<{ id: string; text: string }>(
				historicalRecall,
			).find((memory) => memory.id === stored.id);
			expect(historical?.text).toContain("[current] CURRENT_FACET_TARGET");
			expect(historical?.text).toContain("[history] HISTORY_FACET_DISTRACTOR");
		} finally {
			store.close();
		}
	});

	it("does not derive an active-only task population from query wording", async () => {
		const countRecordTokens = await recordTokenCounter(testEmbedder);
		const activeTask = buildActiveTaskCarrierRow(
			{
				projectId: "global",
				activeTaskId: "ati_recall_active",
				commandId: "cmd_recall_active",
				openingCommandId: "cmd_recall_active",
				description: "ACTIVE_TASK_TARGET: Submit the quarterly compliance report.",
				openingDescription: "Submit the quarterly compliance report.",
				createdAtMs: 100,
				status: "active",
				transitionedAtMs: 100,
				timestampMs: 100,
			},
			"task-population-test",
			countRecordTokens,
		);
		const completedTask = buildActiveTaskCarrierRow(
			{
				projectId: "global",
				activeTaskId: "ati_recall_completed",
				commandId: "cmd_recall_completed",
				openingCommandId: "cmd_recall_completed_open",
				description: "COMPLETED_TASK_DISTRACTOR: Archive the old report.",
				openingDescription: "Archive the old report.",
				createdAtMs: 80,
				status: "completed",
				transitionedAtMs: 90,
				timestampMs: 90,
			},
			"task-population-test",
			countRecordTokens,
		);
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			for (const task of [activeTask, completedTask]) {
				await store.store({
					text: task.text,
					category: "profile",
					projectId: "global",
					metadata: task.metadata,
					trusted: true,
				});
			}
			expect(
				await store.searchAggregationEvidence({
					taskCarrierPopulation: "all",
					facetPolicy: "include-history",
				}),
			).toHaveLength(2);
		} finally {
			store.close();
		}
		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "late-task-evidence", {
				query: "Show my current tasks",
				aggregation: { operation: "evidence", terms: ["report"] },
				include_history: true,
				min_score: 0,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);

		// Narrowing the task population from the question's wording was removed on
		// 2026-08-21: three regex banks read the query and picked active/terminal/all, and
		// turning that off moved the nine task and calendar questions from 0.533 to 0.633
		// with none worse. A caller that wants one population passes it explicitly, so both
		// carriers reach this explicit history read even though the query says "current".
		// Structured evidence reads the complete matching population, so ranking cannot hide
		// one carrier and imitate a wording-derived population filter.
		const text = result.content[0]?.text ?? "";
		expect(getRecallMemories(result)).toHaveLength(2);
		expect(text).toContain("ACTIVE_TASK_TARGET");
		expect(text).toContain("COMPLETED_TASK_DISTRACTOR");

		const zeroMatch = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "current-task-zero-match", {
				query: "Count my current Blue Heron tasks",
				aggregation: { operation: "count", terms: ["Blue Heron"] },
				min_score: 0,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
		expect(getRecallMemories(zeroMatch)).toHaveLength(0);
		expect(zeroMatch.details?.scopeRowCount).toBe(0);
		expect(zeroMatch.details?.populationComplete).toBe(true);
	});

	it("performs ranked recall of task wording without requesting a task population", async () => {
		const target = "LEGACY_TASK_TARGET: We agreed to renew the security certificate.";
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			await store.store({
				text: target,
				category: "episodic",
				projectId: "global",
			});
		} finally {
			store.close();
		}
		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "legacy-task-fallback", {
				query: "What tasks did we agree on?",
				top_k: 3,
				min_score: 0,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);

		const memories = getRecallMemories<{ text: string }>(result);
		expect(memories.some((memory) => memory.text.includes("LEGACY_TASK_TARGET"))).toBe(true);
		expect(memories).toHaveLength(3);
		// truncated/populationComplete describe a whole-population read. A ranked recall is
		// bounded by the caller's own top_k, so it reports neither.
		expect(result.details).toMatchObject({ count: 3, scope: "global" });
		expect(result.details?.truncated).toBeUndefined();
		expect(result.details?.scopeRowCount).toBeUndefined();
		// The <recall-result …/> header reports population coverage and is emitted only by a
		// whole-population read; a ranked recall carries no coverage claim to make.
		expect(result.content[0]?.text).not.toContain("<recall-result");
	});

	it("scope-filtered query with scope mismatch returns 0 results", async () => {

		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "call-3", {
				query: "TypeScript strict mode",
				scope: "nonexistent-scope-xyz",
				top_k: 5,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);

		expect(result.content.length).toBeGreaterThan(0);
		const text = result.content[0]?.text ?? "";
		expect(result.isError).toBe(true);
		expect(text).toBe("Scope not accessible: nonexistent-scope-xyz");
		expect(result.details?.["errorCode"]).toBe("invalid_scope");
	});

	it("empty query string causes a validation error (without throwing)", async () => {

		// Empty query violates z.string().min(1) and returns a tool error.
		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "call-4", {
				query: "",
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);

		expect(result.content.length).toBeGreaterThan(0);
		// Validation failure is represented as an error response without throwing.
		expect(result.isError).toBe(true);
	});
});
