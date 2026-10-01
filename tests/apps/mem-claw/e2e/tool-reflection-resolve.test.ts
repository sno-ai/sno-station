/** @file tool-reflection-resolve.test.ts
 * @purpose Validates the memory_reflection_resolve tool (#840): id resolve, dryRun, guards, query preview.
 * @boundary Tool registration + execution against a real DB; reflection-item metadata + resolvedAt writes.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { executeMemoryReflectionResolveTool } from "../../../../packages/memory/src/engine/bindings/memory-reflection-resolve-tool.ts";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

let reflectionSeedCounter = 0;

function nextReflectionMeta(): string {
	reflectionSeedCounter += 1;
	return JSON.stringify({
		type: "memory-reflection-item",
		itemKind: "invariant",
		agentId: "main",
		anti_pattern_signature: `sig-reflection-${reflectionSeedCounter}`,
	});
}

function readResolvedAt(store: MemoryStore, id: string): number | undefined {
	const entry = store.getById(id);
	if (!entry) return undefined;
	const meta = JSON.parse(entry.metadata) as { resolvedAt?: number };
	return meta.resolvedAt;
}

describe("tool: memory_reflection_resolve", () => {
	let dbPath: string;
	let cleanup: () => void;
	let context: ToolContext;
	let store: MemoryStore;
	let scope: string;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
		scope = "global";
		context = { store, embedder: testEmbedder, stateDir: dbPath,
			scopePolicy: createScopePolicy(), retriever: {} as never };

	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	async function seedReflectionItem(text: string): Promise<string> {
		const entry = await store.store({
			text,
			category: "lesson",
			projectId: scope,
			metadata: nextReflectionMeta(),
			offlineFamily: true,
		});
		return entry.id;
	}

	it("resolves a reflection item by id and sets resolvedAt", async () => {
		const id = await seedReflectionItem("Always run the migration before deploying the worker.");
		expect(readResolvedAt(store, id)).toBeUndefined();

		const result = asClawResult(await executeMemoryReflectionResolveTool(context, { agentId: "tool-reflection-resolve" }, "c1", { memoryId: id }));

		expect(result.isError).not.toBe(true);
		expect(result.details?.["action"]).toBe("resolved");
		expect(readResolvedAt(store, id)).toBeTypeOf("number");
	});

	it("is idempotent: a second resolve reports already_resolved", async () => {
		const id = await seedReflectionItem("Pin the embedder revision before benchmarking.");
		const first = asClawResult(await executeMemoryReflectionResolveTool(context, { agentId: "tool-reflection-resolve" }, "c5a", { memoryId: id }));
		expect(first.details?.["action"]).toBe("resolved");
		const firstResolvedAt = readResolvedAt(store, id);
		expect(firstResolvedAt).toBeTypeOf("number");

		const second = asClawResult(await executeMemoryReflectionResolveTool(context, { agentId: "tool-reflection-resolve" }, "c5b", { memoryId: id }));
		expect(second.details?.["action"]).toBe("already_resolved");
		// The original resolution timestamp is not overwritten.
		expect(readResolvedAt(store, id)).toBe(firstResolvedAt);
	});

	it("dryRun previews without writing resolvedAt", async () => {
		const id = await seedReflectionItem("Cache invalidation must follow the write, not precede it.");
		const result = asClawResult(await executeMemoryReflectionResolveTool(context, { agentId: "tool-reflection-resolve" }, "c2", { memoryId: id, dryRun: true }));

		expect(result.details?.["action"]).toBe("preview");
		expect(readResolvedAt(store, id)).toBeUndefined();
	});

	it("rejects a non-reflection memory", async () => {
		const entry = await store.store({
			text: "Plain durable fact with no reflection metadata.",
			category: "lesson",
			projectId: scope,
			metadata: JSON.stringify({ anti_pattern_signature: "sig-non-reflection" }),
			offlineFamily: true,
		});
		const result = asClawResult(await executeMemoryReflectionResolveTool(context, { agentId: "tool-reflection-resolve" }, "c3", { memoryId: entry.id }));

		expect(result.isError).toBe(true);
		expect(result.details?.["error"]).toBe("not_reflection_item");
		expect(readResolvedAt(store, entry.id)).toBeUndefined();
	});

	it("query mode previews an unresolved reflection item", async () => {
		const id = await seedReflectionItem("Rollbacks require a verified backup snapshot first.");
		const result = asClawResult(
			await executeMemoryReflectionResolveTool(context, { agentId: "tool-reflection-resolve" }, "c4", { query: "rollback backup snapshot", limit: 5 }),
		);

		expect(result.details?.["action"]).toBe("preview");
		const candidates = result.details?.["candidates"];
		expect(Array.isArray(candidates)).toBe(true);
		expect((candidates as Array<{ id: string }>).some((c) => c.id === id)).toBe(true);
		// Preview must not mutate.
		expect(readResolvedAt(store, id)).toBeUndefined();
	});
});
