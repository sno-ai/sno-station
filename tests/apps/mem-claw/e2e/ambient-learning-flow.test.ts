/** @file ambient-learning-flow.test.ts
 * @purpose Validates Ambient Learning from agent_end message arrays into persisted memory entries.
 * @boundary Plugin hook registration, capture filtering, production embedding path, and MemoryStore persistence.
 * @see auto-recall-flow.test.ts, session-memory-flow.test.ts, plugin-full-lifecycle.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { CJK_I18N_FIXTURE_MATRIX } from "../../../fixtures/cjk-fixtures.ts";

let testEmbedder: Embedder;

/** E2E guard for factual capture, noise rejection, and content hash persistence. */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("Ambient Learning flow (agent_end hook)", () => {
	let dbPath: string;
	let cleanup: () => void;
	let harness: OpenClawPluginApiHarness;
	const runtimeHarnesses: OpenClawPluginApiHarness[] = [];

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;

		harness = new OpenClawPluginApiHarness({
			embedding: {
				dimensions: 1024,
			},
			dbPath,
			ambientLearning: true,
			autoRecall: false,
			mode: "local-first",
		});

		runtimeHarnesses.push(harness);
		await memClawPlugin.register(harness);
	});


	afterEach(async () => {
		for (const runtimeHarness of runtimeHarnesses) await runtimeHarness.stopServices();
		runtimeHarnesses.length = 0;
		cleanup();
	});


	it.each(["agent-native"] as const)(
		"does not persist deterministic ambient capture in %s",
		async (mode) => {
		await harness.stopServices();
		const agentId = `${mode}-deterministic-boundary`;
		const agentNativeHarness = new OpenClawPluginApiHarness({
			embedding: { dimensions: 1024 },
			dbPath,
			ambientLearning: true,
			autoRecall: false,
			mode,
		});
		runtimeHarnesses.push(agentNativeHarness);
		await memClawPlugin.register(agentNativeHarness);

		const agentEndHandler = agentNativeHarness.getOnHookHandler("agent_end");
		expect(agentEndHandler).toBeDefined();

		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		await (
			agentEndHandler as (
				event: unknown,
				ctx: { agentId: string; sessionKey: string },
			) => Promise<void>
		)(
			{
				messages: [
					{
						role: "user",
						content: "We will use Zod always for schema validation. It is important for type safety.",
					},
				],
				success: true,
			},
			{ agentId, sessionKey: `agent:${agentId}:test` },
		);

		const rows = await store.list({ limit: 10 });
		const rowsWithoutModelExtractionTrace = rows.filter((row) => {
			const metadata: unknown = row.metadata ? JSON.parse(row.metadata) : {};
			return (
				typeof metadata !== "object" ||
				metadata === null ||
				Reflect.get(metadata, "extraction_source") !== "llm-conversation-chunk"
			);
		});
		expect(rowsWithoutModelExtractionTrace).toEqual([]);
		store.close();
		},
	);

	it("does not fall back to local capture when the Agent Native host transport is unavailable", async () => {
		await harness.stopServices();
		const agentNativeHarness = new OpenClawPluginApiHarness({
			embedding: { dimensions: 1024 },
			dbPath,
			ambientLearning: true,
			autoRecall: false,
			mode: "agent-native",
		});
		runtimeHarnesses.push(agentNativeHarness);
		await memClawPlugin.register(agentNativeHarness);

		const agentEndHandler = agentNativeHarness.getOnHookHandler("agent_end");
		if (!agentEndHandler) throw new Error("expected agent_end hook");
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		const countBefore = (await store.stats()).total;

		await agentEndHandler(
			{
				messages: [
					{
						role: "user",
						content:
							"We will use Zod always for release-candidate schema validation. It is important for type safety.",
					},
				],
				success: true,
			},
			{
				agentId: "agent-native-host-unavailable",
				sessionKey: "agent:agent-native-host-unavailable:test",
			},
		);

		const rows = await store.list({ limit: 10 });
		expect((await store.stats()).total - countBefore).toBe(0);
		expect(rows).toEqual([]);
		store.close();
	});
});
