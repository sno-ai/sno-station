/** Real ONNX embedder + real SQLite. No mocks. Missing deps = FAIL. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	buildInsightMetadata,
	parseInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";
import { executeMemoryStoreTool } from "../../../../packages/memory/src/engine/bindings/memory-store-tool";
import { executeMemoryRecallTool } from "../../../../packages/memory/src/engine/bindings/memory-recall-tool";
import { executeMemoryUpdateTool } from "../../../../packages/memory/src/engine/bindings/memory-update-tool";
import { executeMemoryListTool } from "../../../../packages/memory/src/engine/bindings/memory-list-tool";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas";
import { DEFAULT_RETRIEVAL_CONFIG, createRetriever } from "../../../../packages/memory/src/engine/retrieval/retriever";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes";
import { StorageError } from "../../../../packages/memory/src/engine/shared/errors.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";
import { asClawResult } from "../helpers/tool-result.ts";

const TEST_AGENT_ID = "memory-tool-write-authority";
const TEST_SCOPE = `agent:${TEST_AGENT_ID}`;
const NOW = Date.parse("2026-05-20T12:00:00.000Z");

let testEmbedder: Embedder;


beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("memory tool write authority", () => {
	let context: ToolContext;
	let store: MemoryStore;
	let cleanupDb: () => void;
	let stateDir: string;
	let prevStateDir: string | undefined;


	beforeEach(async () => {
		const testDb = createTestDb();
		cleanupDb = testDb.cleanup;
		stateDir = mkdtempSync(join(tmpdir(), "mem-claw-tool-authority-"));
		prevStateDir = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = stateDir;

		store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
		context = { store, embedder: testEmbedder, stateDir: stateDir, agentId: TEST_AGENT_ID,
			retriever: createRetriever(store, testEmbedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" }),
			scopePolicy: createScopePolicy() };
	});

	afterEach(async () => {
		await store.close();
		cleanupDb();
		rmSync(stateDir, { recursive: true, force: true });
		if (prevStateDir === undefined) {
			delete process.env.SNO_PROFILE_DIR;
		} else {
			process.env.SNO_PROFILE_DIR = prevStateDir;
		}
	});

	it("rejects legacy and old category inputs at the tool schema", async () => {

		for (const category of ["fact", "identity"]) {
			const result = asClawResult(
				await executeMemoryStoreTool(context, { agentId: context.agentId }, `store-${category}`, {
					content: `This ${category} payload must not be accepted.`,
					category,
				}),
			);
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toMatch(/invalid/i);
		}

		const stats = await store.stats(TEST_SCOPE);
		expect(stats.total).toBe(0);
	});



	it("routes profile writes through the profile section writer", async () => {
		const result = asClawResult(
			await executeMemoryStoreTool(context, { agentId: context.agentId }, "store-profile", {
				content: "The user lives in Seattle.",
				category: "profile",
				metadata: { section_name: "identity" },
			}),
		);

		expect(result.isError).not.toBe(true);
		const row = store.getByFactKey(TEST_SCOPE, "profile:identity");
		if (!row) throw new Error("expected profile identity row");
		const metadata = parseInsightMetadata(row.metadata, row);
		expect(row.category).toBe("profile");
		expect(metadata.section_name).toBe("identity");
		expect(metadata.source).toBe("manual");
		expect(row.text.toLowerCase()).toContain("seattle");
	});



	it("requires offline-family authority for persona", async () => {
		const text = "The agent responds in concise engineering mode.";
		const metadata = stringifyInsightMetadata(
			buildInsightMetadata(
				{ text, category: "persona", timestamp: NOW },
				{
					asserted_at: NOW,
					source: "manual",
					section_name: "behavior_rules",
				},
			),
		);

		await expect(
			store.store({
				text,
				category: "persona",
				projectId: TEST_SCOPE,
				metadata,
				timestamp: NOW,
			}),
		).rejects.toThrow(StorageError);

		await expect(
			store.store({
				text,
				category: "persona",
				projectId: TEST_SCOPE,
				metadata,
				timestamp: NOW,
				trusted: true,
			}),
		).rejects.toThrow(StorageError);

		const offline = await store.store({
			text,
			category: "persona",
			projectId: TEST_SCOPE,
			metadata,
			timestamp: NOW,
			offlineFamily: true,
		});

		const parsed = parseInsightMetadata(offline.metadata, offline);
		expect(offline.category).toBe("persona");
		expect(parsed.section_name).toBe("behavior_rules");
		expect(parsed.asserted_at).toBe(NOW);
	});

	it("allows every offline category through offline-family authority", async () => {
		const inputs = [
			{
				category: "lesson",
				text: "When a file is missing, verify the working directory first.",
				metadata: {
					anti_pattern_signature: "manual:missing-file",
				},
			},
			{
				category: "persona",
				text: "The agent responds in concise engineering mode.",
				metadata: {
					section_name: "behavior_rules",
				},
			},
			{
				category: "summary",
				text: "The session established a verified deployment procedure.",
				metadata: {
					children_ids: ["source-row"],
					depth: 1,
				},
			},
		] as const;

		for (const input of inputs) {
			const stored = await store.store({
				text: input.text,
				category: input.category,
				projectId: TEST_SCOPE,
				metadata: stringifyInsightMetadata(
					buildInsightMetadata(
						{ text: input.text, category: input.category, timestamp: NOW },
						{
							asserted_at: NOW,
							source: "manual",
							...input.metadata,
						},
					),
				),
				timestamp: NOW,
				offlineFamily: true,
			});

			expect(stored.category).toBe(input.category);
		}

		const rows = await store.list({ projectId: TEST_SCOPE, limit: 10 });
		expect(rows.map((row) => row.category).sort()).toEqual(["lesson", "persona", "summary"]);
	});





	it("rejects old category inputs on update, recall, and list filters", async () => {
		const existing = await store.store({ text: "The release channel is the canary cluster.",
			category: "episodic", projectId: TEST_SCOPE });
		const updateResult = asClawResult(
			await executeMemoryUpdateTool(context, { agentId: context.agentId }, "update-old-input", {
				id: existing.id,
				category: "event",
			}),
		);
		const recallResult = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "recall-old-filter", {
				query: "deployment",
				category: "event",
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
		const listResult = asClawResult(
			await executeMemoryListTool(context, { agentId: context.agentId }, "list-old-filter", {
				category: "event",
			}),
		);

		expect(updateResult.isError).toBe(true);
		expect(store.getById(existing.id)?.category).toBe("episodic");
		expect(recallResult.isError).toBe(true);
		expect(listResult.isError).toBe(true);
	});
});
