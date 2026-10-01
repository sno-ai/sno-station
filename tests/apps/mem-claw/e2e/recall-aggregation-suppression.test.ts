/** @file recall-aggregation-suppression.test.ts
 * @purpose Proves an aggregation/counting recall never reactivates suppressed memories, in any language.
 * @boundary memory_recall tool handler, retrieval pipeline, MemoryStore metadata, production embeddings.
 * @see tool-memory-recall.test.ts, store-update-metadata.test.ts.
 *
 * The rule: an ordinary recall is the user's explicit signal that a memory is still useful, so it
 * clears suppression. An aggregation recall ("how much did I spend", "总共花了多少") is not a
 * per-memory endorsement — it reads a whole population — so it must leave suppression alone.
 *
 * Why this file exists. The rule was enforced by an English-only predicate while the unbounded
 * aggregation read was selected by a multilingual one. A Chinese counting question satisfied the
 * second and failed the first, so it read the entire matching population and then cleared
 * `suppressed_until_ms` and `bad_recall_count` on every row of it — a read-only question silently
 * and permanently reviving superseded and bad memories. Nothing caught it: of the four suites that
 * touch `suppressed_until_ms`, none exercised this branch.
 *
 * Both directions are proved on purpose. "An aggregation recall did not clear suppression" would
 * also hold for an implementation whose reactivation is simply dead, which is a different bug, so
 * the ordinary-recall case is a required control rather than an extra.
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

const STATE_DIR = `/tmp/mem-claw-recall-suppression-state-${Date.now()}`;

/** Far enough ahead that the row stays suppressed for the whole run, and an exact value to assert. */
const SUPPRESSED_UNTIL_MS = 4_102_444_800_000; // 2100-01-01T00:00:00Z
const BAD_RECALL_COUNT = 3;

/** Seeded in both languages: a query only reaches a memory its own language embeds close to. */
const SEEDS = [
	{ key: "zh", text: "我这周在咖啡上花了 45 元，比上周多。" },
	{ key: "zh-other", text: "我这个月在午餐上花了 320 元。" },
	{ key: "en", text: "I spent 45 dollars on coffee this week, more than last week." },
	{ key: "en-other", text: "I spent 320 dollars on lunch this month." },
] as const;

type SeedKey = (typeof SEEDS)[number]["key"];

interface Suppression {
	suppressed_until_ms?: number;
	bad_recall_count?: number;
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("memory_recall: an aggregation recall must not reactivate suppressed memories", () => {
	let dbPath: string;
	let cleanup: () => void;
	let context: ToolContext;
	let ids: Record<SeedKey, string>;

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
			scopePolicy: createScopePolicy(), agentId: "recall-aggregation-suppression",
		};

		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);
		const vectors = await embedder.embedMany(SEEDS.map((s) => s.text));

		const seeded: Partial<Record<SeedKey, string>> = {};
		for (let i = 0; i < SEEDS.length; i++) {
			const seed = SEEDS[i];
			const vector = vectors[i];
			if (!seed || !vector) continue;
			const stored = await store.store({
				text: seed.text,
				vector,
				category: "episodic",
				projectId: "global",
			});
			seeded[seed.key] = stored.id;
			// Every seed starts suppressed and badly-recalled, so a run that clears the wrong row is
			// visible rather than masked by a neighbour that was never suppressed.
			await store.updateMetadata(stored.id, {
				suppressed_until_ms: SUPPRESSED_UNTIL_MS,
				bad_recall_count: BAD_RECALL_COUNT,
			});
		}

		ids = seeded as Record<SeedKey, string>;
		expect(Object.keys(ids)).toHaveLength(SEEDS.length);
	}, 30_000);

	afterEach(async () => {
		await context.store.close();
		cleanup();
	});

	/** Reads the persisted suppression fields, which are the observable effect under test. */
	const readSuppression = (id: string): Suppression =>
		JSON.parse(context.store.getById(id)?.metadata ?? "{}") as Suppression;

	const recall = async (
		callId: string,
		query: string,
		aggregation?: { operation: "evidence"; terms: string[] },
	) => {
		return asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, callId, { query, top_k: 10, min_score: 0.2, aggregation }, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
	};

	const returnedIds = (result: ReturnType<typeof asClawResult>): string[] =>
		getRecallMemories<{ id: string }>(result).map((m) => m.id);

	it("a Chinese counting question leaves suppression exactly as it was", async () => {
		const result = await recall("agg-zh", "我这个月总共花了多少钱？", {
			operation: "evidence",
			terms: ["花了"],
		});

		// Without this the case passes vacuously: a recall that returned nothing cannot have
		// cleared anything, and the assertion below would hold against a completely broken product.
		expect(returnedIds(result)).toContain(ids.zh);

		for (const id of returnedIds(result)) {
			const after = readSuppression(id);
			expect(after.suppressed_until_ms).toBe(SUPPRESSED_UNTIL_MS);
			expect(after.bad_recall_count).toBe(BAD_RECALL_COUNT);
		}
	}, 30_000);

	it("an English counting question leaves suppression exactly as it was", async () => {
		const result = await recall("agg-en", "How much did I spend in total this month?", {
			operation: "evidence",
			terms: ["spent"],
		});

		expect(returnedIds(result)).toContain(ids.en);

		for (const id of returnedIds(result)) {
			const after = readSuppression(id);
			expect(after.suppressed_until_ms).toBe(SUPPRESSED_UNTIL_MS);
			expect(after.bad_recall_count).toBe(BAD_RECALL_COUNT);
		}
	}, 30_000);

	it("an ordinary recall still clears suppression, so the guard is selective and not dead", async () => {
		const result = await recall("ordinary-zh", "我的咖啡消费记录");

		expect(returnedIds(result)).toContain(ids.zh);

		const after = readSuppression(ids.zh);
		expect(after.suppressed_until_ms).toBeUndefined();
		expect(after.bad_recall_count).toBe(0);
	}, 30_000);
});
