/** Real storage. No mocks. */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { MemoryScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { executeMemoryListTool } from "../../../../packages/memory/src/engine/bindings/memory-list-tool.ts";
import { resolveAgentAccess } from "../../../../packages/memory/src/engine/bindings/memory-tool-access.ts";
import type { MemoryCategory } from "../../../../packages/memory/src/engine/shared/types.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";

let testEmbedder: Embedder;

async function seedMemory(
	store: MemoryStore,
	scope: string,
	text: string,
	category: MemoryCategory = "episodic",
): Promise<void> {
	await store.store({
		text,
		projectId: scope,
		category,
		vector: new Float32Array(1024),
	});
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("memory_list scope filtering", () => {
	let store: MemoryStore;
	let cleanup: () => void;
	let stateDir: string;

	beforeEach(() => {
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath: testDb.dbPath, vectorDim: 1024, embedder: testEmbedder });
		stateDir = `/tmp/mem-claw-list-${Date.now()}`;
	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	it("lists across all accessible scopes when an agent can access more than one scope", async () => {
		await seedMemory(store, "scope-a", "alpha memory");
		await seedMemory(store, "scope-b", "beta memory");
		await seedMemory(store, "scope-c", "gamma memory");

		const scopePolicy = new MemoryScopePolicy({
			default: "scope-a",
			definitions: {
				"scope-a": {},
				"scope-b": {},
				"scope-c": {},
			},
			agentAccess: {
				worker: ["scope-a", "scope-b"],
			},
		});
		const context = { store, scopePolicy, stateDir, retriever: {} as never, embedder: testEmbedder };

		const result = asClawResult(await executeMemoryListTool(context, resolveAgentAccess("worker"), "list-multi", {}));
		expect(result.isError).not.toBe(true);

		const entries = JSON.parse(result.content[0]?.text ?? "[]") as Array<{
			scope: string;
			text: string;
		}>;
		expect(entries).toHaveLength(2);
		expect(entries.map((entry) => entry.scope).sort()).toEqual([
			"scope-a",
			"scope-b",
		]);
		expect(entries.map((entry) => entry.text).sort()).toEqual([
			"alpha memory",
			"beta memory",
		]);
	});

	it('treats the literal "undefined" agent ID as missing instead of a bypass', async () => {
		await seedMemory(store, "scope-a", "private memory");

		const scopePolicy = new MemoryScopePolicy({
			default: "global",
			definitions: {
				global: {},
				"scope-a": {},
			},
		});
		const context = { store, scopePolicy, stateDir, retriever: {} as never, embedder: testEmbedder };

		const result = asClawResult(await executeMemoryListTool(context, resolveAgentAccess("undefined"), "list-legacy-undefined", {}));
		expect(result.isError).not.toBe(true);

		const entries = JSON.parse(result.content[0]?.text ?? "[]") as Array<{
			scope: string;
		}>;
		expect(entries).toEqual([]);
	});
});
