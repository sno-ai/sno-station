/** @file memory-update-concurrency.test.ts
 * @purpose Proves memory_update refuses a stale metadata snapshot instead of overwriting it.
 * @boundary Real MemoryStore instances over one SQLite file; only embedding completion is gated.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { executeMemoryUpdateTool } from "../../../../packages/memory/src/engine/bindings/memory-update-tool.ts";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas.ts";
import { DEFAULT_RETRIEVAL_CONFIG, createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";

let baseEmbedder: Embedder;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
	baseEmbedder = await createTestEmbedder();
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("memory_update concurrent metadata writes", () => {
	it("preserves the stored timestamp pair when anchored text is non-temporal", async () => {
		const database = createTestDb();
		const stateDir = mkdtempSync(join(tmpdir(), "memory-update-static-time-"));
		const store = new MemoryStore({ dbPath: database.dbPath, embedder: baseEmbedder });
		cleanups.push(() => {
			store.closeSync();
			database.cleanup();
			rmSync(stateDir, { recursive: true, force: true });
		});
		const originalTimestamp = Date.parse("2024-01-15T09:30:00.000Z");
		const stored = await store.store({
			text: "The user prefers email updates.",
			category: "episodic",
			projectId: "global",
			timestamp: originalTimestamp,
			timezone: "+09:00",
		});
		store.sqlite.prepare("UPDATE nodix_memories SET extractor_version = NULL WHERE id = ?").run(stored.id);
		const context: ToolContext = {
			retriever: createRetriever(store, baseEmbedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" }),
			store,
			scopePolicy: createScopePolicy(),
			embedder: baseEmbedder,
			agentId: "memory-update-static-time",
			stateDir,
			sessionTimestamp: Date.parse("2026-08-28T17:00:00.000Z"),
			sessionTimezone: "UTC",
		};

		const result = asClawResult(
			await executeMemoryUpdateTool(context, { agentId: context.agentId }, "static-time-update", {
				id: stored.id,
				text: "The user still prefers email updates.",
			}),
		);

		expect(result.isError, JSON.stringify(result)).not.toBe(true);
		expect(store.getById(stored.id)).toMatchObject({
			text: "The user still prefers email updates.",
			timestamp: originalTimestamp,
			timezone: "+09:00",
		});
	});

	it("refuses a stale rebuilt snapshot without losing the newer metadata", async () => {
		let releaseEmbedding = () => {};
		let reportEmbeddingStarted = () => {};
		const embeddingStarted = new Promise<void>((resolve) => {
			reportEmbeddingStarted = resolve;
		});
		const embeddingReleased = new Promise<void>((resolve) => {
			releaseEmbedding = resolve;
		});
		const gatedEmbedder = Object.create(baseEmbedder) as Embedder;
		gatedEmbedder.embedChunks = async (texts: string[]) => {
			if (texts.some((text) => text.includes("replacement text waits here"))) {
				reportEmbeddingStarted();
				await embeddingReleased;
			}
			return baseEmbedder.embedChunks(texts);
		};

		const database = createTestDb();
		const stateDir = mkdtempSync(join(tmpdir(), "memory-update-concurrency-"));
		const toolStore = new MemoryStore({ dbPath: database.dbPath, embedder: gatedEmbedder });
		const concurrentStore = new MemoryStore({ dbPath: database.dbPath, embedder: baseEmbedder });
		cleanups.push(() => {
			concurrentStore.closeSync();
			toolStore.closeSync();
			database.cleanup();
			rmSync(stateDir, { recursive: true, force: true });
		});

		const stored = await toolStore.store({
			text: "The original text is current.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({ source: "manual", contexts: ["original"] }),
		});
		toolStore.sqlite.prepare("UPDATE nodix_memories SET extractor_version = NULL WHERE id = ?").run(stored.id);
		const context: ToolContext = {
			retriever: createRetriever(toolStore, gatedEmbedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" }),
			store: toolStore,
			scopePolicy: createScopePolicy(),
			embedder: gatedEmbedder,
			agentId: "memory-update-race",
			stateDir,
		};

		const staleUpdate = executeMemoryUpdateTool(context, { agentId: context.agentId }, "stale-update", {
			id: stored.id,
			text: "The replacement text waits here.",
			importance: 0.9,
		});
		await embeddingStarted;
		await concurrentStore.updateMetadata(stored.id, { contexts: ["concurrent"] });
		releaseEmbedding();
		const staleResult = asClawResult(await staleUpdate);

		expect(staleResult.isError).toBe(true);
		const finalEntry = concurrentStore.getById(stored.id);
		expect(JSON.parse(finalEntry?.metadata ?? "{}")).toMatchObject({
			contexts: ["concurrent"],
		});
	});
});
