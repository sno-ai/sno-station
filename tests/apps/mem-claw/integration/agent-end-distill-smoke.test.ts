/** @file agent-end-distill-smoke.test.ts
 * @purpose Phase 0 verify gate (memora-fama-execution-stage1-prd §2): a real
 *   conversation routed through the production agent_end ambient-learning hook
 *   in rem-enhanced mode must run the insight-distill pipeline
 *   end-to-end and record an audit `llm_distill_extracted` entry with non-zero
 *   created/merged counts.
 * @boundary agent_end hook → insight-distill pipeline (real Sno GPU extract
 *   LLM, real SQLite, real embeddings) → audit trail. No FAMA at this gate.
 * @see e2e/ambient-learning-flow.test.ts (local-first capture path).
 *
 * Real LLM API required (mem_claw/sno_ai_extract → Sno GPU). Missing keys =
 * FAIL. The test profile's settings.json supplies the Sno GPU address and key.
 */

import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { flushAuditWrites } from "../../../../packages/memory/src/engine/operations/runtime-audit-log.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { getAuditLogPath } from "../../../../packages/memory/src/store/data-paths.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { countTodoTransitionsWithoutSource } from "../../../../packages/memory/src/store/todo-store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

interface AuditLine {
	event: string;
	hook?: string;
	resultStatus: string;
	decision?: string;
	details?: Record<string, unknown>;
}

/** Reads audit.jsonl and returns parsed lines; empty array if the file is absent. */
function readAuditLines(path: string): AuditLine[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as AuditLine);
}

describe("agent_end insight-distill smoke (Phase 0 verify gate)", () => {
	let dbPath: string;
	let cleanup: () => void;
	let harness: OpenClawPluginApiHarness;

	beforeEach(async () => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;

		// Mirror the Memora eval-server config: rem-enhanced mode pinned to
		// the Sno GPU extract route, capture driven through the agent_end hook.
		harness = new OpenClawPluginApiHarness(
			{
				embedding: { dimensions: 1024 },
				dbPath,
				ambientLearning: true,
				autoRecall: false,
				selfImprovement: { enabled: false },
				sessionStrategy: "none",
				mode: "rem-enhanced",
				extraction: {
					llm: { preset: "mem_claw/sno_ai_extract" },
				},
			},
			{ runtimeAgentId: "memora-distill-smoke" },
		);

		await memClawPlugin.register(harness);
	});

	afterEach(() => {
		cleanup();
	});

	it("distills a real conversation and records llm_distill_extracted with created/merged > 0", async () => {
		const agentEndHandler = harness.getOnHookHandler("agent_end");
		expect(agentEndHandler).toBeDefined();

		// Four durable, distillable user facts across identity / preference /
		// event categories — a fresh DB makes every candidate a `create`.
		const messages = [
			{
				role: "user",
				content:
					"My name is Daniel Park and I work as a backend engineer at a fintech startup in Seattle.",
			},
			{
				role: "user",
				content:
					"I strongly prefer Rust over Go for any new backend service we build.",
			},
			{
				role: "user",
				content:
					"I adopted a golden retriever puppy named Biscuit last weekend.",
			},
			{
				role: "user",
				content: "My partner Elena lives in Tokyo.",
			},
			{
				role: "user",
				content: "I need to submit the quarterly report tomorrow.",
			},
		];

		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		const totalBefore = (await store.stats()).total;

		await (
			agentEndHandler as (
				event: unknown,
				ctx: { agentId: string; sessionKey: string },
			) => Promise<void>
		)(
			{ messages, success: true },
			{
				agentId: "memora-distill-smoke",
				sessionKey: "agent:memora-distill-smoke:test",
			},
		);

		// Audit writes are async-queued; drain before reading audit.jsonl.
		await flushAuditWrites();

		const auditLines = readAuditLines(getAuditLogPath());
		const distillEntries = auditLines.filter(
			(line) => line.event === "ambient_learning" && line.hook === "agent_end",
		);
		expect(distillEntries.length).toBeGreaterThan(0);

		// The pipeline must have reached the success branch, not llm_distill_failed
		// (failure stamps the redacted LLM/Zod error into details.error).
		const latest = distillEntries[distillEntries.length - 1];
		expect(
			latest?.decision,
			`expected llm_distill_extracted, got ${latest?.decision} ${JSON.stringify(latest?.details)}`,
		).toBe("llm_distill_extracted");

		const created = Number(latest?.details?.["created"] ?? 0);
		const merged = Number(latest?.details?.["merged"] ?? 0);
		expect(created + merged).toBeGreaterThan(0);
		expect(latest?.details?.["todoTransitionsWithoutSourceCount"]).toBe(0);

		// Round-trip check: the audit count must reflect rows actually written —
		// the distiller persisted at least `created` new memories to SQLite.
		const totalAfter = (await store.stats()).total;
		expect(totalAfter - totalBefore).toBeGreaterThanOrEqual(created);
		expect(totalAfter).toBeGreaterThan(0);
		expect(
			store.sqlite
				.prepare("SELECT COUNT(*) AS count FROM nodix_todos WHERE status = 'open'")
				.get(),
		).toEqual({ count: 1 });
		expect(
			store.sqlite
				.prepare(
					`SELECT COUNT(*) AS count FROM nodix_memories
					WHERE json_valid(metadata)
						AND json_extract(metadata, '$.active_task_kind') IS NOT NULL`,
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			store.sqlite
				.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE text LIKE 'Active task%'")
				.get(),
		).toEqual({ count: 0 });

		const activeTodo = store.sqlite
			.prepare("SELECT project_id AS projectId, active_task_id AS activeTaskId FROM nodix_todos")
			.get() as { projectId: string; activeTaskId: string };
		store.sqlite.transaction(() => {
			store.sqlite
				.prepare(
					`INSERT INTO nodix_task_lifecycle_commands(
						project_id, command_id, canonical_tuple_json, identity_json, action,
						source_assertion_json, effective_at_ms, time_source, result,
						active_task_id, active_task_revision_id, diagnostics_json, created_at_ms
					) VALUES (?, 'missing-source-command', NULL, '{}', 'open_or_refine', '{}',
						5000, 'first_resolution', 'refined', ?, NULL, '{}', 5000)`,
				)
				.run(activeTodo.projectId, activeTodo.activeTaskId);
			store.sqlite
				.prepare(
					`INSERT INTO nodix_active_task_transitions(
						project_id, command_id, active_task_id, transition_kind,
						from_status, to_status, effective_at_ms
					) VALUES (?, 'missing-source-command', ?, 'refine', 'active', 'active', 5000)`,
				)
				.run(activeTodo.projectId, activeTodo.activeTaskId);
		})();
		expect(countTodoTransitionsWithoutSource(store.sqlite)).toBe(1);

		store.close();
	});
});
