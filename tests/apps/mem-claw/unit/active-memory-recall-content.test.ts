import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executeMemoryRecallTool } from "../../../../packages/memory/src/engine/bindings/memory-recall-tool.ts";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";
import { asClawResult, type ClawToolResult } from "../helpers/tool-result.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

type ActiveMemoryReaders = {
	readStructuredMemoryEvidenceFromContent(content: unknown): boolean | undefined;
	readStructuredMemoryFailureFromContent(content: unknown): boolean | undefined;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const hostPromptPath = resolve(
	repoRoot,
	"node_modules/openclaw/dist/extensions/active-memory/prompt.js",
);

function insertRecallRow(store: MemoryStore): void {
	const timestamp = Date.parse("2026-09-02T12:00:00.000Z");
	store.sqlite
		.prepare(
			"INSERT INTO nodix_memories(id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, 'episodic', 'global', 0.7, ?, 'UTC', '{}', ?)",
		)
		.run(
			"active-memory-row",
			"active-memory-row",
			"ACTIVE_MEMORY_ROW remembers the cedar launch checklist.",
			timestamp,
			"active-memory-row-hash",
		);
	store.sqlite
		.prepare(
			"INSERT INTO nodix_memory_chunks(chunk_id, memory_id, chunk_index, chunk_text, dense_payload, start_offset, end_offset, token_count, content_type, chunking_version, embedder_provider, embedder_model, embedder_dim, created_at, updated_at) VALUES (?, ?, 0, ?, ?, 0, ?, 8, 'prose', 'test', 'test', 'test', 1024, ?, ?)",
		)
		.run(
			"active-memory-row:0",
			"active-memory-row",
			"ACTIVE_MEMORY_ROW remembers the cedar launch checklist.",
			"ACTIVE_MEMORY_ROW remembers the cedar launch checklist.",
			55,
			timestamp,
			timestamp,
		);
}

async function executeRecall(
	context: ToolContext,
	callId: string,
	params: Record<string, unknown>,
	agentId?: string,
): Promise<ClawToolResult> {
	return asClawResult(await executeMemoryRecallTool(context, { agentId }, callId, params, { name: "memory_recall", label: "Memory Recall", description: "" }));
}

describe("Active Memory memory_recall content contract", () => {
	let fixture: TestDb;
	let context: ToolContext;
	let readers: ActiveMemoryReaders;
	let rowResult: ClawToolResult;
	let aggregationZeroResult: ClawToolResult;
	let outOfScopeResult: ClawToolResult;
	let profileRoot: string;
	let previousProfile: string | undefined;

	beforeAll(async () => {
		readers = (await import(pathToFileURL(hostPromptPath).href)) as ActiveMemoryReaders;
		fixture = createTestDb();
		profileRoot = mkdtempSync(join(tmpdir(), "active-memory-recall-"));
		previousProfile = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = profileRoot;
		writeSettingsFixture(profileRoot, { mode: "local-first", store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey }, embedding: { cacheDir: "" }, recall: { auto: false }, capture: { ambient: false } });
		const embedder = await createTestEmbedder();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		insertRecallRow(store);

		context = {
			store, embedder, stateDir: profileRoot, scopePolicy: createScopePolicy(),
			retriever: createRetriever(store, embedder, { warn: () => {} }, {
				...DEFAULT_RETRIEVAL_CONFIG, rerank: "none",
			}),
		};
		rowResult = await executeRecall(context, "active-memory-row", {
			query: "cedar launch checklist",
			aggregation: { operation: "evidence", terms: ["ACTIVE_MEMORY_ROW"] },
			min_score: 0,
		}, "active-memory-agent");
		aggregationZeroResult = await executeRecall(context, "active-memory-aggregation-zero", {
			query: "missing launch checklist",
			aggregation: { operation: "evidence", terms: ["NO_SUCH_MEMORY_ROW"] },
			min_score: 0,
		}, "active-memory-agent");

		outOfScopeResult = await executeRecall(context, "active-memory-out-of-scope", {
			query: "cedar launch checklist",
		});
	}, 120_000);

	afterAll(async () => {
		try {
			await context?.store.close();
		} finally {
			fixture?.cleanup();
			if (previousProfile === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = previousProfile;
			if (profileRoot) rmSync(profileRoot, { recursive: true, force: true });
		}
	});

	it("lets OpenClaw distinguish rows from every successful zero-result path", () => {
		expect(readers.readStructuredMemoryEvidenceFromContent(rowResult.content)).toBe(true);
		expect(readers.readStructuredMemoryEvidenceFromContent(aggregationZeroResult.content)).toBe(
			false,
		);
		expect(readers.readStructuredMemoryEvidenceFromContent(outOfScopeResult.content)).toBe(false);

		for (const result of [rowResult, aggregationZeroResult, outOfScopeResult]) {
			expect(readers.readStructuredMemoryFailureFromContent(result.content)).toBeUndefined();
		}

		expect(rowResult.content).toHaveLength(2);
		const structuredRow = JSON.parse(rowResult.content[1]?.text ?? "null") as {
			count: number;
			memories: unknown[];
			status: string;
		};
		expect(structuredRow.memories).toHaveLength(structuredRow.count);
		expect(structuredRow).toEqual({
			status: "ok",
			count: 1,
			memories: ["active-memory-row"],
		});
		for (const result of [aggregationZeroResult, outOfScopeResult]) {
			expect(result.content).toHaveLength(2);
			expect(JSON.parse(result.content[1]?.text ?? "null")).toEqual({
				status: "no_results",
				count: 0,
				memories: [],
			});
		}
	});

	it("preserves the model text and details while adding structured content", () => {
		expect(rowResult.content[0]?.text).toBe(
			'<relevant-memories>\n<recall-result scope-row-count="1" returned-count="1" population-complete="true" truncated="false" />\nFound 1 memories:\n\n- [episodic] [current] ACTIVE_MEMORY_ROW remembers the cedar launch checklist. (100%)\n</relevant-memories>',
		);
		expect(JSON.stringify(rowResult.details)).toBe(
			'{"count":1,"scope":"global","memories":[{"id":"active-memory-row","text":"[current] ACTIVE_MEMORY_ROW remembers the cedar launch checklist.","category":"episodic:global","rawCategory":"episodic","scope":"global","importance":0.7,"timestamp":"2026-09-02T12:00:00.000Z"}],"scopeRowCount":1,"populationComplete":true,"truncated":false}',
		);
		expect(aggregationZeroResult.content[0]?.text).toBe(
			'<relevant-memories>\n<recall-result scope-row-count="0" returned-count="0" population-complete="true" truncated="false" />\nFound 0 memories.\n</relevant-memories>',
		);
		expect(JSON.stringify(aggregationZeroResult.details)).toBe(
			'{"count":0,"memories":[],"scope":"global","scopeRowCount":0,"populationComplete":true,"truncated":false}',
		);
		expect(outOfScopeResult.content[0]?.text).toBe("No relevant memories found.");
		expect(JSON.stringify(outOfScopeResult.details)).toBe(
			'{"count":0,"memories":[],"scope":"global"}',
		);
	});
});
