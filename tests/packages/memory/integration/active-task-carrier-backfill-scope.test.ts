/** @file active-task-carrier-backfill-scope.test.ts
 * @purpose An instance the legacy migration could not bind to a command has no opening command
 *   by design, and a carrier id is a function of that command. It must be held back and counted,
 *   not treated as a damaged row that fails the backfill for every other project.
 * @boundary Real encrypted SQLite and the real embedder; lifecycle rows are seeded directly.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { backfillActiveTaskCarriers } from "../../../../packages/memory/src/store/active-task-carrier-backfill";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const BOUND_PROJECT = "carrier-scope-bound";
const UNBOUND_PROJECT = "carrier-scope-unbound";
const CREATED_AT = Date.UTC(2026, 4, 2, 8, 0);

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterAll(() => {
	embedder?.dispose?.();
});

describe("active-task carrier backfill scope", () => {
	let testDb: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(async () => {
		await store?.close();
		testDb?.cleanup();
		store = undefined;
		testDb = undefined;
	});

	function seedBoundInstance(db: TestDb): void {
		db.sqlite
			.prepare(
				`INSERT INTO nodix_task_lifecycle_commands(
					project_id, command_id, canonical_tuple_json, identity_json, action,
					source_assertion_json, effective_at_ms, time_source, result,
					active_task_id, active_task_revision_id, diagnostics_json, created_at_ms
				) VALUES (?, 'cmd-bound', '[]', '{}', 'open_or_refine', '{}', ?, 'first_resolution',
					'created_instance', 'ati-bound', 'atr-bound', '{}', ?)`,
			)
			.run(BOUND_PROJECT, CREATED_AT, CREATED_AT);
		db.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_instances(
					project_id, active_task_id, opening_command_id, canonical_tuple_json,
					identity_state, status, created_at_ms
				) VALUES (?, 'ati-bound', 'cmd-bound', '[]', 'normal', 'active', ?)`,
			)
			.run(BOUND_PROJECT, CREATED_AT);
		db.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_revisions(
					project_id, active_task_revision_id, active_task_id, creating_command_id,
					canonical_tuple_json, description, occurrence_anchors_json,
					revision_details_json, created_at_ms, is_current
				) VALUES (?, 'atr-bound', 'ati-bound', 'cmd-bound', '[]',
					'Send the quarterly accessibility report.', '[]', '{}', ?, 1)`,
			)
			.run(BOUND_PROJECT, CREATED_AT);
	}

	/** What the legacy migration writes when nothing in the census bound the instance. */
	function seedUnboundInstance(db: TestDb): void {
		db.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_instances(
					project_id, active_task_id, opening_command_id, canonical_tuple_json,
					identity_state, status, created_at_ms
				) VALUES (?, 'ati-unbound', NULL, '[]', 'unresolved', 'active', ?)`,
			)
			.run(UNBOUND_PROJECT, CREATED_AT);
		db.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_revisions(
					project_id, active_task_revision_id, active_task_id, creating_command_id,
					canonical_tuple_json, description, occurrence_anchors_json,
					revision_details_json, created_at_ms, is_current
				) VALUES (?, 'atr-unbound', 'ati-unbound', NULL, '[]',
					'Chase the unbound legacy task.', '[]', '{}', ?, 1)`,
			)
			.run(UNBOUND_PROJECT, CREATED_AT);
	}

	it("still backfills every other project when one instance has no opening command", async () => {
		testDb = createTestDb();
		// Open first: the store's boot migrations count the rows they move, and lifecycle rows
		// seeded before boot make that count disagree with itself.
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		seedBoundInstance(testDb);
		seedUnboundInstance(testDb);

		const report = await backfillActiveTaskCarriers(store);

		// The bound instance gets its carrier: one damaged-looking neighbour does not cost it.
		expect(report.created).toBe(1);
		expect(report.createdByProject[BOUND_PROJECT]).toBe(1);
		// The unbound one is held back, and counted, so it can never read as "already done".
		expect(report.unresolved).toBe(1);
		expect(report.unresolvedByProject[UNBOUND_PROJECT]).toBe(1);
		expect(report.createdByProject[UNBOUND_PROJECT]).toBeUndefined();

		const carriers = testDb.sqlite
			.prepare(
				"SELECT project_id AS projectId FROM nodix_memories WHERE source = 'edge' AND extractor_version = 'active-task-carrier-backfill'",
			)
			.all() as { projectId: string }[];
		expect(carriers.map((row) => row.projectId)).toEqual([BOUND_PROJECT]);
	});
});
