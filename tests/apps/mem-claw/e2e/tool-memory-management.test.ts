/** @file tool-memory-management.test.ts
 * @purpose Validates memory_stats and memory_list reporting across categories, scopes, and pagination.
 * @boundary Tool output JSON, MemoryStore aggregation, list ordering, and limit/offset handling.
 * @see tool-memory-store.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { executeMemoryStatsTool } from "../../../../packages/memory/src/engine/bindings/memory-stats-tool";
import { executeMemoryListTool } from "../../../../packages/memory/src/engine/bindings/memory-list-tool";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas";
import { DEFAULT_RETRIEVAL_CONFIG, createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-mgmt-state-${Date.now()}`;

/**
 * memory_stats and memory_list tools: 25 memories across 3 scopes (all episodic).
 * Verifies stats breakdown, list pagination newest-first.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("tool: memory_stats and memory_list", () => {
	let dbPath: string;
	let cleanup: () => void;
	let context: ToolContext;
	let store: MemoryStore;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;

		store = new MemoryStore({ dbPath, embedder: testEmbedder });
		context = { store, embedder: testEmbedder, stateDir: STATE_DIR,
			retriever: createRetriever(store, testEmbedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" }),
			scopePolicy: createScopePolicy({ default: "scope-a", definitions: {
				"scope-a": {}, "scope-b": {}, "scope-c": {},
			}, agentAccess: { manager: ["scope-a", "scope-b", "scope-c"] } }), agentId: "manager" };

		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		// 25 memories across 3 scopes, all seeded as the episodic kind
		const entries: Array<{
			text: string;
			scope: string;
			category: "episodic";
		}> = [
			// scope-a: 10 entries
			{
				text: "I prefer TypeScript for all new backend services.",
				scope: "scope-a",
				category: "episodic",
			},
			{
				text: "I prefer tabs over spaces in all TypeScript files.",
				scope: "scope-a",
				category: "episodic",
			},
			{
				text: "TypeScript strict mode is mandatory for our team.",
				scope: "scope-a",
				category: "episodic",
			},
			{
				text: "Our team uses Node.js as the primary JavaScript runtime.",
				scope: "scope-a",
				category: "episodic",
			},
			{
				text: "We decided to adopt Zod for all API validation.",
				scope: "scope-a",
				category: "episodic",
			},
			{
				text: "Decision: switch from npm to Node.js package manager.",
				scope: "scope-a",
				category: "episodic",
			},
			{
				text: "Project architect contact: John Smith at john@example.com",
				scope: "scope-a",
				category: "episodic",
			},
			{
				text: "Tech lead: Maria Garcia, responsible for TypeScript migration.",
				scope: "scope-a",
				category: "episodic",
			},
			{
				text: "Always use async/await over raw promises in new code.",
				scope: "scope-a",
				category: "episodic",
			},
			{
				text: "Database schema changes require migration files.",
				scope: "scope-a",
				category: "episodic",
			},

			// scope-b: 8 entries
			{
				text: "I love using Drizzle ORM for type-safe database access.",
				scope: "scope-b",
				category: "episodic",
			},
			{
				text: "Redis is our default caching solution for session data.",
				scope: "scope-b",
				category: "episodic",
			},
			{
				text: "We decided to use Docker for all service deployments.",
				scope: "scope-b",
				category: "episodic",
			},
			{
				text: "Team uses Kubernetes for container orchestration.",
				scope: "scope-b",
				category: "episodic",
			},
			{
				text: "I prefer GraphQL over REST for internal APIs.",
				scope: "scope-b",
				category: "episodic",
			},
			{
				text: "DevOps engineer: Carlos Rodriguez at carlos@example.com",
				scope: "scope-b",
				category: "episodic",
			},
			{
				text: "Never deploy on Fridays — team policy.",
				scope: "scope-b",
				category: "episodic",
			},
			{
				text: "Code reviews are mandatory before merging PRs.",
				scope: "scope-b",
				category: "episodic",
			},

			// scope-c: 7 entries
			{
				text: "I always write tests before implementation — TDD.",
				scope: "scope-c",
				category: "episodic",
			},
			{
				text: "Python is used for data pipeline automation scripts.",
				scope: "scope-c",
				category: "episodic",
			},
			{
				text: "We decided to migrate from Python 2 to Python 3.",
				scope: "scope-c",
				category: "episodic",
			},
			{
				text: "Data scientist: Priya Patel, ML team lead.",
				scope: "scope-c",
				category: "episodic",
			},
			{
				text: "Important: always validate external API responses.",
				scope: "scope-c",
				category: "episodic",
			},
			{
				text: "Machine learning models are retrained monthly.",
				scope: "scope-c",
				category: "episodic",
			},
			{
				text: "Never expose raw database credentials in environment files.",
				scope: "scope-c",
				category: "episodic",
			},
		];

		const vectors = await embedder.embedMany(entries.map((e) => e.text));
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const vector = vectors[i];
			if (!entry || !vector) continue;
			await store.store({
				text: entry.text,
				vector,
				category: entry.category,
				projectId: entry.scope,
			});
		}

		expect((await store.stats()).total).toBe(25);
	}, 30_000);

	afterEach(async () => {
		await store.close();
		cleanup();
	});

	it("memory_stats returns scope breakdown summing to 25 and category breakdown summing to 25", async () => {

		const result = asClawResult(await executeMemoryStatsTool(context, { agentId: context.agentId }, "stats-1", {}));

		expect(result.isError).not.toBe(true);
		expect(result.content.length).toBeGreaterThan(0);

		const text = result.content[0]?.text ?? "";
		const parsed = JSON.parse(text) as {
			total: number;
			scopeBreakdown: Record<string, number>;
			categoryBreakdown: Record<string, number>;
		};

		expect(parsed.total).toBe(25);

		// Scope breakdown sums to 25
		const scopeSum = Object.values(parsed.scopeBreakdown).reduce(
			(a, b) => a + b,
			0,
		);
		expect(scopeSum).toBe(25);

		// Category breakdown sums to 25
		const categorySum = Object.values(parsed.categoryBreakdown).reduce(
			(a, b) => a + b,
			0,
		);
		expect(categorySum).toBe(25);

		// Verify individual scope counts
		expect(parsed.scopeBreakdown["scope-a"]).toBe(10);
		expect(parsed.scopeBreakdown["scope-b"]).toBe(8);
		expect(parsed.scopeBreakdown["scope-c"]).toBe(7);
	});

	it("memory_list limit=5 offset=0 returns 5 results ordered newest-first", async () => {

		// memory_list defaults to DEFAULT_SCOPE, so this test passes an explicit custom scope.
		const result = asClawResult(
			await executeMemoryListTool(context, { agentId: context.agentId }, "list-1", {
				limit: 5,
				offset: 0,
				scope: "scope-a",
			}),
		);

		expect(result.isError).not.toBe(true);
		const text = result.content[0]?.text ?? "";
		const entries = JSON.parse(text) as Array<{
			timestamp: string;
			id: string;
		}>;

		expect(entries).toHaveLength(5);

		// Newest-first ordering permits equal timestamps from same-tick inserts.
		for (let i = 1; i < entries.length; i++) {
			const prev = entries[i - 1];
			const curr = entries[i];
			if (prev && curr) {
				const prevTs = new Date(prev.timestamp).getTime();
				const currTs = new Date(curr.timestamp).getTime();
				expect(prevTs).toBeGreaterThanOrEqual(currTs);
			}
		}
	});

	it("memory_list offset=5 scope=scope-a returns remaining 5 entries (page 2)", async () => {
		const first = asClawResult(await executeMemoryListTool(context, { agentId: context.agentId }, "list-first-page", {
			limit: 5, offset: 0, scope: "scope-a",
		}));
		expect(first.isError).not.toBe(true);
		const firstPage = JSON.parse(first.content[0]?.text ?? "[]") as Array<{ id: string }>;
		expect(firstPage).toHaveLength(5);

		const result = asClawResult(
			await executeMemoryListTool(context, { agentId: context.agentId }, "list-2", {
				limit: 5,
				offset: 5,
				scope: "scope-a",
			}),
		);

		expect(result.isError).not.toBe(true);
		const text = result.content[0]?.text ?? "";
		const entries = JSON.parse(text) as Array<{
			timestamp: string;
			id: string;
		}>;

		expect(entries).toHaveLength(5);
		expect(new Set([...firstPage, ...entries].map(entry => entry.id)).size).toBe(10);
	});
});
