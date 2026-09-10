/** @file todo-store-migration.test.ts
 * @purpose Proves task-state migration into the dedicated to-do store.
 * @boundary Real encrypted SQLite opened through MemoryStore; no storage substitutes.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";
import { routeTestTask } from "../../../apps/mem-claw/integration/task-lifecycle-test-route";

const TODO_MIGRATION_CREATED_AT = 1_740_000_000_033;

let embedder: Embedder;
let store: MemoryStore | undefined;
let testDb: TestDb | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(() => {
	store?.closeSync();
	testDb?.cleanup();
	store = undefined;
	testDb = undefined;
});

async function seedLegacyTaskState(): Promise<void> {
	testDb = createTestDb();
	store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
	await routeTestTask({
		store,
		projectId: "todo-open-scope",
		action: "open_or_refine",
		description: "Plan literary event attendance",
		replayIdentity: "open-literary-plan",
		at: 1_000,
	});
	await routeTestTask({
		store,
		projectId: "todo-done-scope",
		action: "open_or_refine",
		description: "Buy groceries",
		replayIdentity: "open-groceries",
		at: 2_000,
	});
	await routeTestTask({
		store,
		projectId: "todo-done-scope",
		action: "complete",
		description: "Buy groceries",
		replayIdentity: "completed-groceries",
		at: 3_000,
	});
	store.closeSync();
	store = undefined;

	testDb.sqlite.exec(`
		DROP TABLE IF EXISTS nodix_todo_migration_receipts;
		DROP TABLE IF EXISTS nodix_todos;
		DELETE FROM __drizzle_migrations
		WHERE created_at = ${TODO_MIGRATION_CREATED_AT};
	`);
}

function openMigratedStore(): void {
	if (!testDb) throw new Error("test database is unavailable");
	store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
}

describe("dedicated to-do store migration", () => {
	it("moves every task identity and removes task carriers from memory", async () => {
		await seedLegacyTaskState();
		openMigratedStore();
		if (!testDb) throw new Error("test database is unavailable");

		const receipt = testDb.sqlite
			.prepare(
				`SELECT before_count AS beforeCount, after_count AS afterCount
				FROM nodix_todo_migration_receipts`,
			)
			.get();
		expect(receipt).toEqual({ beforeCount: 2, afterCount: 2 });

		const todos = testDb.sqlite
			.prepare(
				`SELECT
					project_id AS projectId,
					active_task_id AS activeTaskId,
					description,
					status,
					opened_at AS openedAt,
					transitioned_at AS transitionedAt,
					closed_at AS closedAt,
					close_reason AS closeReason,
					source_session AS sourceSession,
					extraction_path AS extractionPath
				FROM nodix_todos
				ORDER BY project_id`,
			)
			.all() as Array<Record<string, unknown>>;
		expect(todos).toHaveLength(2);
		expect(todos[0]).toMatchObject({
			projectId: "todo-done-scope",
			description: "Buy groceries",
			status: "done",
			openedAt: 2_000,
			transitionedAt: 3_000,
			closedAt: 3_000,
			closeReason: "completed-groceries",
			sourceSession: "todo-done-scope",
			extractionPath: "authorized_untraced",
		});
		expect(todos[1]).toMatchObject({
			projectId: "todo-open-scope",
			description: "Plan literary event attendance",
			status: "open",
			openedAt: 1_000,
			transitionedAt: 1_000,
			closedAt: null,
			closeReason: null,
			sourceSession: "todo-open-scope",
			extractionPath: "authorized_untraced",
		});
		expect(todos.every((todo) => typeof todo.activeTaskId === "string")).toBe(true);
		expect(
			testDb.sqlite
				.prepare(
					`SELECT COUNT(*) AS count
					FROM nodix_memories
					WHERE json_valid(metadata)
						AND json_extract(metadata, '$.active_task_kind') IN ('task', 'projection')`,
				)
				.get(),
		).toEqual({ count: 0 });
	});

	it("refuses store open when task and to-do counts differ", async () => {
		await seedLegacyTaskState();
		openMigratedStore();
		if (!testDb) throw new Error("test database is unavailable");
		store?.closeSync();
		store = undefined;

		testDb.sqlite.transaction(() => {
			testDb?.sqlite
				.prepare(
					`INSERT INTO nodix_task_lifecycle_commands(
						project_id, command_id, canonical_tuple_json, identity_json, action,
						source_assertion_json, effective_at_ms, time_source, result,
						active_task_id, active_task_revision_id, diagnostics_json, created_at_ms
					) VALUES (?, ?, ?, ?, 'open_or_refine', ?, 4000, 'first_resolution',
						'created_instance', ?, NULL, '{}', 4000)`,
				)
				.run(
					"planted-scope",
					"planted-command",
					'["planted"]',
					'{"kind":"authorized_untraced","canonicalTuple":["task-lifecycle-command-v1","planted-scope","planted-session","planted-replay","0"]}',
					'{"kind":"task_lifecycle","action":"open_or_refine","projectId":"planted-scope","subject":"user","description":"Planted task","occurrenceAnchors":{},"revisionDetails":{}}',
					"planted-task",
				);
			testDb?.sqlite
				.prepare(
					`INSERT INTO nodix_active_task_instances(
						project_id, active_task_id, opening_command_id, canonical_tuple_json,
						identity_state, status, created_at_ms, terminal_at_ms
					) VALUES (?, ?, ?, ?, 'normal', 'active', 4000, NULL)`,
				)
				.run("planted-scope", "planted-task", "planted-command", '["planted"]');
		})();

		expect(
			() => new MemoryStore({ dbPath: testDb?.dbPath ?? "", embedder }),
		).toThrow("before=3, after=2");
	});
});
