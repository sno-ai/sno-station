/** @file recall-aggregation-population-completeness.test.ts
 * @purpose Proves a counting question receives its WHOLE population, and that per-row metadata is
 *          never attached to a whole-population read.
 * @boundary memory_recall tool handler, retrieval pipeline, MemoryStore, production embeddings.
 * @see recall-aggregation-suppression.test.ts, tool-memory-recall.test.ts.
 *
 * The rule: answering "how many steps this week" requires every matching row. The tool's own
 * comment says the token budget is the only thing allowed to cut that population — so nothing may
 * spend that budget on bytes the counting consumer does not read.
 *
 * Why this file exists, measured 2026-08-17. A commit removed `&& !readsWholePopulation` from the
 * metadata branch, so every aggregation row began dragging its metadata blob. The budget is
 * `max(rendered text, JSON.stringify(details.memories))`, so the second term overflowed on the
 * serialized copy alone, truncation fired, and — because the same commit had also changed
 * truncation from "drop the tail" to "drop the head" — the survivors were the LAST rows of the
 * window. A seven-day counting question was answered from one day. All 38 whole-population
 * questions in the benchmark scored MPA 0.168 against 0.798 for ordinary questions, and the run's
 * headline fell 65.4 to 46.1. Nothing caught it: the aggregation suites next door prove what a
 * counting read must NOT do (reactivate suppressed rows), and none proved what it must DO.
 *
 * Both directions are proved on purpose. "An aggregation read carries no metadata" would also hold
 * if metadata were dead everywhere, which is a different bug and would silently break the REM
 * reader contract — so the ordinary-recall case is a required control, not an extra.
 */

import { beforeAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { executeMemoryRecallTool } from "../../../../packages/memory/src/engine/bindings/memory-recall-tool.ts";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult, getRecallMemories } from "../helpers/tool-result.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-aggregation-completeness-state-${Date.now()}`;

/**
 * One row per day of a seven-day window, phrased the way the benchmark's own corpus phrases it.
 * Seven is the point: the regression delivered the last day or two, so a fixture of two or three
 * rows could be fully delivered by the broken build and prove nothing.
 */
const DAILY_STEPS = [
	{ day: "2026-06-01", steps: 6200 },
	{ day: "2026-06-02", steps: 9100 },
	{ day: "2026-06-03", steps: 11450 },
	{ day: "2026-06-04", steps: 8300 },
	{ day: "2026-06-05", steps: 12980 },
	{ day: "2026-06-06", steps: 7592 },
	{ day: "2026-06-07", steps: 8437 },
] as const;

/**
 * Realistic per-row metadata. The regression is a SIZE effect, so a token-sized blob is part of the
 * fixture rather than decoration: an empty metadata object would not overflow any budget and the
 * test would pass against the broken build.
 */
const bulkyMetadata = (day: string): Record<string, unknown> => ({
	source_session_id: `session-${day}-8f14e45fceea167a5a36dedd4bea2543`,
	source_message_id: `msg-${day}-c9f0f895fb98ab9159f51fd0297e236d`,
	extraction_trace: {
		extractor_version: "atomic-2026-08",
		candidate_grounding: `The user reported a daily step total on ${day} during an activity check-in.`,
		evidence_span: { turn_index: 3, quote: `I hit my steps target on ${day}.` },
		rejected_alternatives: [
			"treat as a goal statement rather than an occurrence",
			"treat as a recurring habit rather than a dated event",
		],
	},
	importance_reason: "dated activity measurement retained for weekly totals",
});

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("memory_recall: a counting question receives its whole population", () => {
	let dbPath: string;
	let cleanup: () => void;
	let context: ToolContext;
	let seededIds: string[];

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;

		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		context = {
			store, embedder: testEmbedder, stateDir: STATE_DIR,
			retriever: createRetriever(store, testEmbedder, { warn: () => {} }, {
				...DEFAULT_RETRIEVAL_CONFIG, minScore: 0.2, rerank: "none",
			}),
			scopePolicy: createScopePolicy(), agentId: "recall-aggregation-completeness",
		};

		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const texts = DAILY_STEPS.map((d) => `On ${d.day} I walked ${d.steps} steps.`);
		const vectors = await embedder.embedMany(texts);

		const ids: string[] = [];
		for (let i = 0; i < DAILY_STEPS.length; i++) {
			const entry = DAILY_STEPS[i];
			const vector = vectors[i];
			const text = texts[i];
			if (!entry || !vector || !text) continue;
			const stored = await store.store({
				text,
				vector,
				category: "episodic",
				projectId: "global",
			});
			await store.updateMetadata(stored.id, bulkyMetadata(entry.day));
			ids.push(stored.id);
		}

		seededIds = ids;
		expect(seededIds).toHaveLength(DAILY_STEPS.length);
	}, 30_000);

	afterEach(async () => {
		await context.store.close();
		cleanup();
	});

	const recall = async (
		callId: string,
		query: string,
		aggregation?: { operation: "evidence"; terms: string[] },
	) => {
		return asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, callId, {
				query,
				top_k: 100,
				min_score: 0.2,
				aggregation,
				// The eval server and every REM reader ask for metadata. Asking for it here is what
				// makes this a regression test rather than a happy-path check: the broken build
				// honoured the request on a whole-population read and blew its own budget doing it.
				include_metadata: true,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
	};

	it("delivers every day of a seven-day window to a counting question", async () => {
		const result = await recall(
			"agg-steps",
			"How many total steps have I taken this week?",
			{ operation: "evidence", terms: ["steps"] },
		);
		const memories = getRecallMemories<{ id: string; text?: string }>(result);

		// The failing shape is specific and worth naming in the assertion: the broken build
		// delivered a contiguous TAIL of the window, so a plain length check could pass on a build
		// that dropped the middle. Assert the days themselves.
		const deliveredDays = DAILY_STEPS.filter((d) =>
			memories.some((m) => (m.text ?? "").includes(d.day)),
		).map((d) => d.day);

		expect(deliveredDays).toEqual(DAILY_STEPS.map((d) => d.day));
		expect(memories).toHaveLength(DAILY_STEPS.length);
	}, 30_000);

	it("attaches no per-row metadata to a whole-population read, even when asked for it", async () => {
		const result = await recall(
			"agg-steps-meta",
			"How many total steps have I taken this week?",
			{ operation: "evidence", terms: ["steps"] },
		);
		const memories = getRecallMemories<Record<string, unknown>>(result);

		expect(memories.length).toBeGreaterThan(0);
		for (const memory of memories) {
			expect(memory["metadata"]).toBeUndefined();
		}
	}, 30_000);

	it("still attaches metadata to an ordinary recall, so the guard is selective and not dead", async () => {
		const result = await recall("ordinary-steps", "What did I do on 2026-06-03?");
		const memories = getRecallMemories<Record<string, unknown>>(result);

		expect(memories.length).toBeGreaterThan(0);
		expect(memories.some((m) => m["metadata"] !== undefined)).toBe(true);
	}, 30_000);
});

/**
 * A population that is larger than the manual recall budget and smaller than the aggregation one.
 * `DEFAULT_RECALL_TOKEN_BUDGET` is 7,000 estimated tokens (one per four characters) and
 * `MAX_AGGREGATION_RESULT_TOKENS` is 32,768, so forty rows of about 1,200 characters sit between
 * them: the manual packer would cut the population roughly in half, the aggregation ceiling leaves
 * it whole. A shorter fixture would fit under both and could not tell the two ceilings apart.
 */
const SESSION_NOTE_COUNT = 40;
const sessionNote = (index: number): string => {
	const day = String(index + 1).padStart(2, "0");
	return (
		`On 2026-07-${day} the study group met for the regional energy reading session. ` +
		"The group worked through the assigned chapter on demand forecasting, compared the " +
		"seasonal adjustment each member had computed, and recorded the disagreements for the " +
		"following week. The facilitator noted that the winter peak estimate remains the most " +
		"contested figure in the chapter and asked every member to bring a written justification " +
		"for the value they chose. Attendance was recorded, the reading for the next session was " +
		"assigned, and the group agreed to keep the same meeting slot for the rest of the term. " +
		"The notes were circulated the same evening so that anyone who missed the session could " +
		`catch up before the next one. Session ${index + 1} of the regional energy reading group.`
	);
};

describe("memory_recall: the manual token budget does not cut a whole-population read", () => {
	let dbPath: string;
	let cleanup: () => void;
	let context: ToolContext;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;

		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		context = {
			store, embedder: testEmbedder, stateDir: STATE_DIR,
			retriever: createRetriever(store, testEmbedder, { warn: () => {} }, {
				...DEFAULT_RETRIEVAL_CONFIG, minScore: 0.2, rerank: "none",
			}),
			scopePolicy: createScopePolicy(), agentId: "recall-aggregation-completeness",
		};

		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const texts = Array.from({ length: SESSION_NOTE_COUNT }, (_, index) => sessionNote(index));
		const vectors = await embedder.embedMany(texts);
		for (let index = 0; index < texts.length; index++) {
			const text = texts[index];
			const vector = vectors[index];
			if (!text || !vector) continue;
			await store.store({ text, vector, category: "episodic", projectId: "global" });
		}

		const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
		// The fixture is only a fixture if it actually straddles the two budgets.
		expect(Math.ceil(totalChars / 4)).toBeGreaterThan(7_000);
		expect(Math.ceil(totalChars / 4)).toBeLessThan(32_768);
	}, 120_000);

	afterEach(async () => {
		await context.store.close();
		cleanup();
	});

	const call = async (
		callId: string,
		params: Record<string, unknown>,
	): Promise<Array<{ id: string; text?: string }>> => {
		return getRecallMemories<{ id: string; text?: string }>(
			asClawResult(await executeMemoryRecallTool(context, { agentId: context.agentId }, callId, params, { name: "memory_recall", label: "Memory Recall", description: "" })),
		);
	};

	const QUERY = "How many reading sessions did the study group hold?";
	const AGGREGATION = { operation: "evidence" as const, terms: ["session"] };

	it("serves the whole population even though it exceeds the manual recall budget", async () => {
		const memories = await call("agg-budget", {
			query: QUERY,
			min_score: 0.2,
			aggregation: AGGREGATION,
		});
		expect(memories).toHaveLength(SESSION_NOTE_COUNT);
	}, 60_000);

	it("ignores top_k on a whole-population read", async () => {
		const memories = await call("agg-budget-topk", {
			query: QUERY,
			top_k: 3,
			min_score: 0.2,
			aggregation: AGGREGATION,
		});
		expect(memories).toHaveLength(SESSION_NOTE_COUNT);
	}, 60_000);

	it("bounds an ordinary recall and honours its explicit top_k", async () => {
		const budgeted = await call("ordinary-budget", { query: QUERY, top_k: 100, min_score: 0.2 });
		expect(
			budgeted.length,
			"ordinary recall unexpectedly returned every seeded row",
		).toBeLessThan(SESSION_NOTE_COUNT);

		const topK = await call("ordinary-topk", { query: QUERY, top_k: 3, min_score: 0.2 });
		expect(topK, "an ordinary recall stopped honouring top_k").toHaveLength(3);
	}, 60_000);
});
