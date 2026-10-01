/** @file todo-recall.e2e.test.ts
 * @purpose Proves memory_recall prepends scoped to-dos without consuming ranked-memory slots.
 * @boundary Registered tool, real encrypted SQLite store, and production recall result shape.
 */

import { dirname } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_RECALLED_TODOS } from "../../../../packages/memory/config/index.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { executeMemoryRecallTool } from "../../../../packages/memory/src/engine/bindings/memory-recall-tool.ts";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";
import { asClawResult, getRecallMemories } from "../helpers/tool-result.ts";
import { routeTestTask } from "../integration/task-lifecycle-test-route.ts";

interface TodoSeed {
	id: string;
	description: string;
	status: "open" | "done" | "removed";
	openedAt: number;
	closedAt?: number;
	closeReason?: string;
}

let testEmbedder: Embedder;
const TODO_MIGRATION_CREATED_AT = 1_740_000_000_033;

function insertTodos(store: MemoryStore, todos: readonly TodoSeed[]): void {
	const insertIdentity = store.sqlite.prepare(
		`INSERT INTO nodix_active_task_instances(
			project_id, active_task_id, opening_command_id, canonical_tuple_json,
			identity_state, status, created_at_ms, terminal_at_ms
		) VALUES ('global', ?, NULL, '{}', 'normal', ?, ?, ?)`,
	);
	const insert = store.sqlite.prepare(
		`INSERT INTO nodix_todos(
			project_id, active_task_id, description, status, opened_at, transitioned_at,
			closed_at, close_reason, source_session, extraction_path
		) VALUES ('global', ?, ?, ?, ?, ?, ?, ?, 'todo-recall-test', 'agent_end')`,
	);
	store.sqlite.transaction(() => {
		for (const todo of todos) {
			insertIdentity.run(
				todo.id,
				todo.status === "open" ? "active" : todo.status === "done" ? "completed" : "removed",
				todo.openedAt,
				todo.closedAt ?? null,
			);
			insert.run(
				todo.id,
				todo.description,
				todo.status,
				todo.openedAt,
				todo.closedAt ?? todo.openedAt,
				todo.closedAt ?? null,
				todo.closeReason ?? null,
			);
		}
	})();
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("memory_recall to-do block", () => {
	let cleanup: () => void;
	let dbPath: string;
	let fixture: TestDb;
	let context: ToolContext;

	beforeEach(() => {
		const testDb = createTestDb();
		fixture = testDb;
		cleanup = testDb.cleanup;
		dbPath = testDb.dbPath;

	});

	afterEach(async () => {
		await context?.store.close();
		cleanup();
	});

	it("returns open to-dos by default and all statuses with history", async () => {
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			insertTodos(store, [
				{ id: "todo-open-1", description: "Book the venue", status: "open", openedAt: 10 },
				{ id: "todo-done", description: "Send the invite", status: "done", openedAt: 20, closedAt: 40, closeReason: "Sent it" },
				{ id: "todo-open-2", description: "Order the food", status: "open", openedAt: 30 },
				{ id: "todo-removed", description: "Hire a band", status: "removed", openedAt: 40, closedAt: 50, closeReason: "Cancelled the band" },
				{ id: "todo-open-3", description: "Print the signs", status: "open", openedAt: 50 },
			]);
			await store.store({
				text: "The event is at the community hall.",
				category: "episodic",
				projectId: "global",
			});
		} finally {
			await store.close();
		}
		const recallStore = new MemoryStore({ dbPath, embedder: testEmbedder });
		context = {
			store: recallStore, embedder: testEmbedder, stateDir: dirname(dbPath),
			retriever: createRetriever(recallStore, testEmbedder, { warn: () => {} }, {
				...DEFAULT_RETRIEVAL_CONFIG, minScore: 0, hardMinScore: 0, rerank: "none",
			}),
			scopePolicy: createScopePolicy(), agentId: "todo-recall-test",
		};

		const defaultResult = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "todo-default", { query: "What remains?", top_k: 1, min_score: 0 }, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
		const defaultText = defaultResult.content[0]?.text ?? "";
		expect(defaultText).toContain("To-dos:");
		expect(defaultText).toMatch(/\[open\].*Book the venue/);
		expect(defaultText).toMatch(/\[open\].*Order the food/);
		expect(defaultText).toMatch(/\[open\].*Print the signs/);
		expect(defaultText).not.toContain("Send the invite");
		expect(defaultText).not.toContain("Hire a band");
		expect(getRecallMemories(defaultResult)).toHaveLength(1);

		const historyResult = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "todo-history", {
				query: "What remains?",
				top_k: 1,
				min_score: 0,
				include_history: true,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
		const historyText = historyResult.content[0]?.text ?? "";
		expect(historyText).toMatch(/\[done\].*Send the invite.*closed_at=.*close_reason=Sent it/);
		expect(historyText).toMatch(/\[removed\].*Hire a band.*closed_at=.*close_reason=Cancelled the band/);
		expect(getRecallMemories(historyResult)).toHaveLength(1);
	});

	it("returns the oldest configured maximum and the true count", async () => {
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		try {
			insertTodos(
				store,
				Array.from({ length: MAX_RECALLED_TODOS + 1 }, (_, index) => ({
					id: `todo-${index}`,
					description: `Task ${index}`,
					status: "open" as const,
					openedAt: index,
				})),
			);
		} finally {
			await store.close();
		}
		const recallStore = new MemoryStore({ dbPath, embedder: testEmbedder });
		context = {
			store: recallStore, embedder: testEmbedder, stateDir: dirname(dbPath),
			retriever: createRetriever(recallStore, testEmbedder, { warn: () => {} }, {
				...DEFAULT_RETRIEVAL_CONFIG, minScore: 0, hardMinScore: 0, rerank: "none",
			}),
			scopePolicy: createScopePolicy(), agentId: "todo-recall-test",
		};

		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "todo-truncated", { query: "What remains?", min_score: 1 }, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
		const text = result.content[0]?.text ?? "";
		expect(text.match(/^\- \[open\]/gm)).toHaveLength(MAX_RECALLED_TODOS);
		expect(text).toContain(`showing ${MAX_RECALLED_TODOS} of ${MAX_RECALLED_TODOS + 1}`);
		expect(text).toContain("Task 0");
		expect(text).not.toContain(`Task ${MAX_RECALLED_TODOS}`);
	});

	it("keeps migrated terminal to-dos out of default recall", async () => {
		const store = new MemoryStore({ dbPath, embedder: testEmbedder });
		await routeTestTask({
			store,
			projectId: "global",
			action: "open_or_refine",
			description: "Keep this open",
			replayIdentity: "open-kept",
			at: 10,
		});
		await routeTestTask({
			store,
			projectId: "global",
			action: "open_or_refine",
			description: "Finish this task",
			replayIdentity: "open-done",
			at: 20,
		});
		await routeTestTask({
			store,
			projectId: "global",
			action: "complete",
			description: "Finish this task",
			replayIdentity: "close-done",
			at: 30,
		});
		await store.close();
		fixture.sqlite.exec(`
			DROP TABLE nodix_todo_migration_receipts;
			DROP TABLE nodix_todos;
			DELETE FROM __drizzle_migrations WHERE created_at = ${TODO_MIGRATION_CREATED_AT};
		`);

		const recallStore = new MemoryStore({ dbPath, embedder: testEmbedder });
		context = {
			store: recallStore, embedder: testEmbedder, stateDir: dirname(dbPath),
			retriever: createRetriever(recallStore, testEmbedder, { warn: () => {} }, {
				...DEFAULT_RETRIEVAL_CONFIG, minScore: 0, hardMinScore: 0, rerank: "none",
			}),
			scopePolicy: createScopePolicy(), agentId: "todo-recall-test",
		};
		const result = asClawResult(
			await executeMemoryRecallTool(context, { agentId: context.agentId }, "todo-migrated-default", {
				query: "What remains?",
				min_score: 1,
			}, { name: "memory_recall", label: "Memory Recall", description: "" }),
		);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("[open] Keep this open");
		expect(text).not.toContain("Finish this task");
		expect(text).not.toMatch(/\[(done|removed)\]/);
	});
});
