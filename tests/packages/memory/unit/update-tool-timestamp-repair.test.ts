/** @file update-tool-timestamp-repair.test.ts
 * @purpose Both agent and host callers can move a row to its session timestamp.
 * @boundary Real SQLite via chokepoint; no mocks.
 */

import { dirname } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeMemoryUpdateTool } from "../../../../packages/memory/src/engine/bindings/memory-update-tool.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("memory_update timestamp", () => {
	let store: MemoryStore;
	let cleanup: () => void;
	let stateDir: string;
	const replayDay = Date.parse("2026-09-13T00:38:33Z");
	const sessionMoment = Date.parse("2023-06-09T19:55:00Z");

	beforeEach(() => {
		const td = createTestDb();
		cleanup = td.cleanup;
		stateDir = dirname(td.dbPath);
		store = new MemoryStore({ dbPath: td.dbPath, embedder });
	});

	afterEach(() => {
		store.closeSync();
		cleanup();
	});

	function context(systemCaller: boolean) {
		return {
			store,
			embedder,
			retriever: createRetriever(store, embedder),
			scopePolicy: createScopePolicy({ default: "global", agentAccess: { "conv-26": ["global"] } }),
			stateDir,
			...(systemCaller ? { systemCaller: true } : {}),
		};
	}

	it("lets an agent move the row to its session moment", async () => {
		const row = await store.store({
			text: "Caroline met up with her friends, family and mentors last week.",
			category: "episodic",
			projectId: "global",
			timestamp: replayDay,
			metadata: JSON.stringify({ kind: "episodic", memory_category: "episodic" }),
		});
		const result = await executeMemoryUpdateTool(context(false), { agentId: "conv-26" }, "agent-move", {
			id: row.id,
			timestamp: sessionMoment,
		});
		expect(result.isError).not.toBe(true);
		expect(store.getById(row.id)?.timestamp).toBe(1686340500000);
	});

	it("lets the host operator move the row to its session moment", async () => {
		const row = await store.store({
			text: "Caroline met up with her friends, family and mentors last week.",
			category: "episodic",
			projectId: "global",
			timestamp: replayDay,
			metadata: JSON.stringify({ kind: "episodic", memory_category: "episodic" }),
		});
		const result = await executeMemoryUpdateTool(context(true), { agentId: "conv-26" }, "operator-move", {
			id: row.id,
			timestamp: sessionMoment,
		});
		expect(result.isError).not.toBe(true);
		expect(store.getById(row.id)?.timestamp).toBe(sessionMoment);
		expect(store.getById(row.id)?.text).toBe("Caroline met up with her friends, family and mentors last week.");
	});
});
