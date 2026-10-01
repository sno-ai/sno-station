/** Real LLM API required. No mocking. Missing keys = FAIL. */

/**
 * memory_stats fail-closed for non-system principal.
 *
 * Recent fix (apps/mem-claw/src/plugin/memory-tool-registration.ts:1402–1409):
 *   useUnfiltered = !parsed.projectId
 *                && isSystemBypassId(access.agentId)
 *                && getStoreScopeFilterForTool(...) === undefined;
 *
 * Before the fix, the unfiltered branch fired whenever the scope filter
 * happened to be undefined — including for non-system principals — which
 * leaked total counts across scopes the principal should not see. The fix
 * adds the explicit `isSystemBypassId(...)` check so non-system principals
 * always traverse the per-scope loop.
 *
 * Verifies:
 *  1. Pre-fixture: insert rows under 2 different scopes so scoped vs
 *     unfiltered totals differ (without that the assertion has no signal).
 *  2. memory_stats with a non-system agentId returns counts scoped to the
 *     agent's accessible scopes only — NOT the full-store total.
 *  3. memory_stats with the system bypass id ("system") returns the full,
 *     unfiltered total (existing system-tooling behaviour preserved).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { executeMemoryStatsTool } from "../../../../packages/memory/src/engine/bindings/memory-stats-tool";
import { MemoryScopePolicy } from "../../../../packages/memory/src/engine/security/scopes";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

interface StatsPayload {
	total: number;
	scopeBreakdown: Record<string, number>;
	categoryBreakdown: Record<string, number>;
}

function parseStatsResult(rawText: string): StatsPayload {
	return JSON.parse(rawText) as StatsPayload;
}

describe("memory_stats scope fail-safe (non-system principal)", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;
	let prevStateDir: string | undefined;
	let stateDir: string;

	const PLUGIN_CONFIG_BASE = {
		embedding: { dimensions: 1024 },
		ambientLearning: false,
		autoRecall: false,
		enableManagementTools: true,
		scopes: {
			default: "scope-a",
			definitions: {
				"scope-a": {},
				"scope-b": {},
			},
			agentAccess: {
				// Non-system agent restricted to scope-a only.
				"alice": ["scope-a"],
			},
		},
	} as const;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		prevStateDir = process.env.SNO_PROFILE_DIR;
		stateDir = `/tmp/mem-claw-stats-state-${Date.now()}`;
		process.env.SNO_PROFILE_DIR = stateDir;

		// Seed 3 rows in scope-a and 2 rows in scope-b directly through MemoryStore
		// so the scoped-vs-unfiltered totals differ. Direct seeding bypasses the
		// scope manager, which is exactly the production state we need to probe.
		const seedStore = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			await seedStore.store({
				text: "TypeScript strict mode is mandatory in scope-a services.",
				category: "episodic",
				projectId: "scope-a",
			});
			await seedStore.store({
				text: "Always use Zod validation for scope-a request payloads.",
				category: "episodic",
				projectId: "scope-a",
			});
			await seedStore.store({
				text: "Decided to adopt better-sqlite3 across scope-a tooling.",
				category: "episodic",
				projectId: "scope-a",
			});
			await seedStore.store({
				text: "Python asyncio drives the scope-b ingestion pipeline.",
				category: "episodic",
				projectId: "scope-b",
			});
			await seedStore.store({
				text: "FastAPI is the preferred framework for scope-b APIs.",
				category: "episodic",
				projectId: "scope-b",
			});
			expect((await seedStore.stats()).total).toBe(5);
		} finally {
			seedStore.close();
			store = new MemoryStore({ dbPath, embedder: testEmbedder });
		}
	});

	afterEach(() => {
		store.closeSync();
		cleanup();
		if (prevStateDir === undefined) {
			delete process.env.SNO_PROFILE_DIR;
		} else {
			process.env.SNO_PROFILE_DIR = prevStateDir;
		}
	});

	it("non-system principal sees only accessible-scope totals (3), NOT full-store totals (5)", async () => {
		const result = asClawResult(await executeMemoryStatsTool({
			store, embedder: testEmbedder, stateDir,
			retriever: {} as never, scopePolicy: new MemoryScopePolicy(PLUGIN_CONFIG_BASE.scopes),
		}, { agentId: "alice" }, "stats-1", {}));
		expect(result.isError).not.toBe(true);

		const payload = parseStatsResult(result.content[0]?.text ?? "");
		// scope-a alone → 3 rows. If the unfiltered branch fired, this would be 5.
		expect(payload.total).toBe(3);
		expect(payload.scopeBreakdown["scope-a"]).toBe(3);
		expect(payload.scopeBreakdown["scope-b"]).toBeUndefined();
	});

	it("system bypass id returns full unfiltered totals (5) across all scopes", async () => {
		const result = asClawResult(await executeMemoryStatsTool({
			store, embedder: testEmbedder, stateDir,
			retriever: {} as never, scopePolicy: new MemoryScopePolicy(PLUGIN_CONFIG_BASE.scopes),
		}, { agentId: "system" }, "stats-2", {}));
		expect(result.isError).not.toBe(true);

		const payload = parseStatsResult(result.content[0]?.text ?? "");
		expect(payload.total).toBe(5);
		// Both scopes are visible to the system principal.
		expect(payload.scopeBreakdown["scope-a"]).toBe(3);
		expect(payload.scopeBreakdown["scope-b"]).toBe(2);
	});
});
