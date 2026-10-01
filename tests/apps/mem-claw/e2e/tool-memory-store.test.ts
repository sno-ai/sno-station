/** @file tool-memory-store.test.ts
 * @purpose Validates memory_store persistence, duplicate detection, CJK text handling, and noise rejection.
 * @boundary Tool input validation, capture filtering, production embeddings, and MemoryStore content hashes.
 * @see tool-memory-recall.test.ts, ambient-learning-flow.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import type { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestEmbedder } from "../helpers/test-db.ts";
import { createMemUpdateFixture } from "../../../packages/memory/fixtures/mem-update-fixture";
import { asClawResult } from "../helpers/tool-result.ts";

let testEmbedder: Embedder;

/**
 * memory_store tool: normal, CJK, duplicate dedup, noise rejection, short rejection.
 * Four distinct explicit values are stored; a duplicate reuses its id and legacy inputs fail.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("tool: memory_store", () => {
	let fixture: Awaited<ReturnType<typeof createMemUpdateFixture>>;
	let harness: OpenClawPluginApiHarness;
	let store: MemoryStore;

	beforeEach(async () => {
		fixture = await createMemUpdateFixture(testEmbedder, { capture: { ambient: false }, recall: { auto: false } });
		store = fixture.store;
		harness = new OpenClawPluginApiHarness({}, { runtimeAgentId: "tool-memory-store" });
		memClawPlugin.register(harness);
	});

	afterEach(async () => {
		await harness.stopServices();
		await fixture.close();
	});

	it("stores normal text, CJK, deduplicates hash, keeps explicit stores — final count = 4", async () => {
		const storeTool = harness.getRegisteredTool("memory_store");
		expect(storeTool).toBeDefined();
		if (!storeTool) throw new Error("memory_store was not registered");

		// Case 1 stores normal durable text through the production embedding path.
		const result1 = asClawResult(
			await storeTool.execute("call-1", {
				content:
					"I always prefer TypeScript over JavaScript for new projects due to strict typing.",
			}),
		);
		expect(result1.isError).not.toBe(true);
		const firstId = result1.content[0]?.text ?? "";
		expect(store.getById(firstId)?.text).toBe("I always prefer TypeScript over JavaScript for new projects due to strict typing.");

		// Case 2 proves CJK content survives validation and production embedding.
		const result2 = asClawResult(
			await storeTool.execute("call-2", {
				content: "记住：总是使用TypeScript严格模式，避免隐式any类型的问题。",
			}),
		);
		expect(result2.isError).not.toBe(true);
		expect(store.getById(result2.content[0]?.text ?? "")?.text).toBe("记住：总是使用TypeScript严格模式，避免隐式any类型的问题。");

		// Count verifies both durable inputs were accepted before dedup/noise cases.
		const statsAfterTwo = await store.stats();
		expect(statsAfterTwo.total).toBe(2);

		// Case 3 reuses Case 1 text to exercise content_hash deduplication.
		const result3 = asClawResult(
			await storeTool.execute("call-3", {
				content:
					"I always prefer TypeScript over JavaScript for new projects due to strict typing.",
			}),
		);
		// Duplicate content returns the existing memory instead of writing a new row.
		expect(result3.isError).not.toBe(true);
		expect(result3.content[0]?.text).toBe(firstId);

		// Case 4: A denial-shaped sentence. The manual tool path stores it: the caller
		// already made the judgement, and the keyword gate that used to drop these was
		// removed on 2026-08-19 after it destroyed 14 real memories on the live corpus.
		const result4 = asClawResult(
			await storeTool.execute("call-4", {
				content:
					"I don't have any information about your previous conversations.",
			}),
		);
		expect(result4.isError).not.toBe(true);
		expect(store.getById(result4.content[0]?.text ?? "")?.text).toBe("I don't have any information about your previous conversations.");
		expect((await store.stats()).total).toBe(3);

		// Case 5: two characters. The manual path stops only on an empty envelope or a
		// prompt injection, and "ok" is neither, so the caller's explicit store stands.
		const result5 = asClawResult(
			await storeTool.execute("call-5", {
				content: "ok",
			}),
		);
		expect(result5.isError).not.toBe(true);
		const count5 = (await store.stats()).total;
		expect(count5).toBe(4);

		// The model interface accepts content only; internal profile writing has separate tests.
		const result6 = asClawResult(await storeTool.execute("call-6", {
			content: "Ship the Q3 report by Friday", category: "profile",
			metadata: { section_name: "active_tasks" },
		}));
		expect(result6.isError).toBe(true);
		expect(result6.content[0]?.text).toBe("invalid-input");
		expect(store.listUnplacedCandidates()).toHaveLength(0);

		// The duplicate and rejected legacy payload do not add rows.

		const finalStats = await store.stats();
		expect(finalStats.total).toBe(4);
	});
});
