/** @file auto-recall-flow.test.ts
 * @purpose Validates before_prompt_build auto-recall injection and topic isolation.
 * @boundary Plugin hook return contract, retrieval timeout propagation, embeddings, and MemoryStore records.
 * @see ambient-learning-flow.test.ts, auto-recall-session-state.test.ts, tool-memory-recall.test.ts.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createEmbedder,
	type Embedder,
} from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

/**
 * Auto-recall flow: before_prompt_build hook retrieves relevant memories
 * and injects them into the event context. Verifies topic isolation.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("auto-recall flow (before_prompt_build hook)", () => {
	const AUTO_RECALL_TIMEOUT_MS = 4321;
	let dbPath: string;
	let cleanup: () => void;
	let harness: OpenClawPluginApiHarness;
	let stateDir: string;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		stateDir = `/tmp/mem-claw-state-${Date.now()}`;
		cleanup = () => {
			testDb.cleanup();
		};

		harness = new OpenClawPluginApiHarness({
			embedding: {
				dimensions: 1024,
			},
			dbPath,
			ambientLearning: false,
			autoRecall: true,
			autoRecallTimeoutMs: AUTO_RECALL_TIMEOUT_MS,
			retrieval: { recallTopK: 5 },
		});

		await memClawPlugin.register(harness);
	});

	afterEach(() => {
		cleanup();
	});

	it("injects topic-1 content and excludes topic-2/3 content after seeding 20 memories", async () => {
		// Seed three topical clusters so retrieval quality is measured by isolation, not count alone.
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		const embedder = createEmbedder(
			{
				dimensions: 1024,
			},
			stateDir,
		);

		// Topic cluster 1 establishes the expected positive match set for the query.
		const topic1Texts = [
			"Node.js 22 is the standard JavaScript runtime for plugin execution.",
			"Node.js 22 runs TypeScript entrypoints through tsx during development.",
			"Vitest is the Node.js 22 test runner used for plugin verification.",
			"Node.js 22 resolves ESM modules using the standard Node loader.",
			"better-sqlite3 is the SQLite driver used by Node.js 22 storage.",
			"I prefer Node.js 22 for all released plugins.",
			"Node.js 22 uses the V8 JavaScript engine.",
		];

		// Topic cluster 2 is semantically distinct and must stay out of Node recall results.
		const topic2Texts = [
			"Python asyncio provides coroutine-based concurrency.",
			"asyncio.gather() runs multiple coroutines concurrently in Python.",
			"FastAPI is built on asyncio and Starlette for Python APIs.",
			"Python's GIL limits true parallelism in CPU-bound asyncio tasks.",
			"uvicorn is the recommended ASGI server for FastAPI applications.",
			"aiohttp is a popular async HTTP library for Python.",
			"Python 3.11 improved asyncio task performance significantly.",
		];

		// Topic cluster 3 guards against broad technical-neighbor false positives.
		const topic3Texts = [
			"PostgreSQL supports JSON columns for flexible schema designs.",
			"SQLite is a serverless embedded database perfect for small projects.",
			"Database indexes dramatically improve query performance on large tables.",
			"Foreign key constraints enforce referential integrity in relational DBs.",
			"VACUUM in SQLite reclaims space from deleted records.",
			"PostgreSQL's MVCC enables high-concurrency without lock contention.",
		];

		// Persist every fixture through production embeddings to exercise the real vector path.
		const allMemories = [
			...topic1Texts.map((text) => ({ text, marker: "topic1" })),
			...topic2Texts.map((text) => ({ text, marker: "topic2" })),
			...topic3Texts.map((text) => ({ text, marker: "topic3" })),
		];

		const vectors = await embedder.embedMany(allMemories.map((m) => m.text));
		for (let i = 0; i < allMemories.length; i++) {
			const memory = allMemories[i];
			const vector = vectors[i];
			if (!memory || !vector) continue;
			await store.store({
				text: memory.text,
				vector,
				category: "episodic",
				projectId: "global",
			});
		}

		expect((await store.stats()).total).toBe(20);

		// Query against the Node cluster to prove auto-recall is relevance-driven.
		const beforeAgentStartHandler =
			harness.getOnHookHandler("before_prompt_build");
		expect(beforeAgentStartHandler).toBeDefined();

		const eventRecord = {
			prompt:
				"How does Node.js 22 handle TypeScript and what runtime engine does it use?",
			messages: [] as unknown[],
		};

		// The hook contract returns context explicitly instead of mutating the event payload.
		const result = await (
			beforeAgentStartHandler as (
				event: unknown,
				ctx: { agentId: string; sessionKey: string },
			) => Promise<{ prependContext?: string } | undefined>
		)(eventRecord, {
			agentId: "auto-recall-flow",
			sessionKey: "agent:auto-recall-flow:test",
		});

		// prependContext is the SDK-facing carrier for retrieved memory context.
		expect(result).toBeDefined();
		expect(result?.prependContext).toBeDefined();
		if (!result?.prependContext) {
			throw new Error("expected prependContext from auto-recall hook");
		}
		const content = result.prependContext;

		// The untrusted-data preamble preserves the prompt-injection boundary.
		expect(content).toMatch(/untrusted/i);

		// Wrapper tags make the injected memory block parseable by downstream prompt assembly.
		expect(content).toMatch(/<relevant-memories>/);
		expect(content).toMatch(/<\/relevant-memories>/);

		// Isolate line content so format assertions do not accidentally match wrapper text.
		const innerMatch = content.match(
			/<relevant-memories>\n([\s\S]*?)\n<\/relevant-memories>/,
		);
		expect(innerMatch).not.toBeNull();
		const innerText = innerMatch?.[1];
		if (!innerText) {
			throw new Error("expected relevant memories block content");
		}
		const memoryLines = innerText
			.split("\n")
			.filter((l: string) => l.trim().length > 0);
		expect(memoryLines.length).toBeGreaterThan(0);
		for (const line of memoryLines) {
			// Each line follows the stable formatRelevantMemoriesContext output contract: the
			// category, then the day the row's event happened or the day it was said, then the text.
			expect(line).toMatch(
				/^memory \d+: \{"category":"(episodic|profile|persona|lesson|summary)",(?:"(event_date|said_on)":"\d{4}-\d{2}-\d{2}",)?"text":".+"\}$/,
			);
		}

		const injectedContent = content.toLowerCase();

		// Node memories must appear because they are the direct semantic target.
		expect(injectedContent).toMatch(/node\.js 22|node/i);

		// Python asyncio memories must stay excluded to preserve topic isolation.
		expect(injectedContent).not.toMatch(/asyncio|coroutine|fastapi|uvicorn/i);

		// SQL database memories must stay excluded to avoid broad technical drift.
		expect(injectedContent).not.toMatch(/postgresql|vacuum|mvcc/i);

		store.close();
	});

});
