/** @file active-tasks-completion-cas.test.ts
 * @purpose Preserves concurrent completion convergence through the lifecycle transaction.
 * @boundary Two real stores share one encrypted SQLite database; no storage mocks.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { parseInsightMetadata } from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";
import type { MemoryEntry } from "../../../../packages/memory/src/engine/shared/types.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";
import { routeTestTask } from "../../../apps/mem-claw/integration/task-lifecycle-test-route.ts";

const SCOPE = "active-tasks-completion-cas";
const OPENED_AT = Date.parse("2026-07-19T12:00:00.000Z");
const COMPLETED_AT = Date.parse("2026-07-19T12:05:00.000Z");
const TASK = "publish the Project Atlas release notes";
const OCCURRENCE_ID = "project-atlas-release-notes";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("active-task completion compare-and-swap", () => {
	let storeA: MemoryStore | undefined;
	let storeB: MemoryStore | undefined;
	let testDb: TestDb | undefined;

	afterEach(() => {
		storeA?.closeSync();
		storeB?.closeSync();
		testDb?.cleanup();
		storeA = undefined;
		storeB = undefined;
		testDb = undefined;
	});

	it("converges concurrent completions on one transition and keeps later writes healthy", async () => {
		testDb = createTestDb();
		storeA = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		storeB = new MemoryStore({ dbPath: testDb.dbPath, embedder });

		const opened = await routeTestTask({
			store: storeA,
			projectId: SCOPE,
			action: "open_or_refine",
			description: TASK,
			replayIdentity: "task-open",
			occurrenceId: OCCURRENCE_ID,
			at: OPENED_AT,
		});
		const activeTaskId = opened.write.activeTaskId;
		if (!activeTaskId) throw new Error("expected one seeded active task");

		const completions = await Promise.allSettled(
			[
				{ store: storeA, sourceId: "task-done-a" },
				{ store: storeB, sourceId: "task-done-b" },
			].map(({ sourceId, store }) =>
				routeTestTask({
					store,
					projectId: SCOPE,
					action: "complete",
					description: TASK,
					replayIdentity: sourceId,
					occurrenceId: OCCURRENCE_ID,
					at: COMPLETED_AT,
				}),
			),
		);

		expect(completions.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
		expect(
			testDb.sqlite
				.prepare(
					`SELECT status, terminal_at_ms AS terminalAtMs
					FROM nodix_active_task_instances
					WHERE project_id = ? AND active_task_id = ?`,
				)
				.get(SCOPE, activeTaskId),
		).toEqual({ status: "completed", terminalAtMs: COMPLETED_AT });
		expect(
			testDb.sqlite
				.prepare(
					`SELECT COUNT(*) AS count
					FROM nodix_active_task_transitions
					WHERE project_id = ? AND active_task_id = ? AND transition_kind = 'complete'`,
				)
				.get(SCOPE, activeTaskId),
		).toEqual({ count: 1 });
		expect(
			testDb.sqlite
				.prepare(
					`SELECT COUNT(*) AS count
					FROM nodix_active_task_evidence
					WHERE project_id = ? AND active_task_id = ?`,
				)
				.get(SCOPE, activeTaskId),
		).toEqual({ count: 3 });
		const projection = storeA.getByFactKey(SCOPE, "profile:active_tasks");
		expect(parseInsightMetadata(projection?.metadata, projection as MemoryEntry).active_task_ids).toEqual(
			[],
		);

		await routeTestTask({
			store: storeB,
			projectId: SCOPE,
			action: "open_or_refine",
			description: "verify the Project Atlas release notes",
			replayIdentity: "task-after-cas",
			occurrenceId: "verify-project-atlas-release-notes",
			at: COMPLETED_AT + 1,
		});
		const current = storeA.getByFactKey(SCOPE, "profile:active_tasks");
		expect(parseInsightMetadata(current?.metadata, current as MemoryEntry).active_task_ids).toHaveLength(
			1,
		);
	});
});
