/** @file active-task-crash-retry-removal.test.ts
 * @purpose Preserves task completion replay, ambiguity, and crash recovery after the hard cut.
 * @boundary Real encrypted SQLite through the atomic writer; no storage mocks.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { routeTaskLifecycleAssertion } from "../../../../packages/memory/src/engine/extraction/task-lifecycle-route.ts";
import {
	buildTaskLifecycleCandidateSet,
	taskLifecycleCandidateSetVersion,
} from "../../../../packages/memory/src/engine/extraction/task-lifecycle-resolver.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const scope = "active-task-crash-retry-removal";
const task = "review journal submissions";
const openedAt = Date.parse("2025-06-01T12:00:00Z");
const completedAt = Date.parse("2025-06-02T12:00:00Z");

let embedder: Embedder;
let fixture: TestDb | undefined;
let store: MemoryStore | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(() => {
	store?.closeSync();
	fixture?.cleanup();
	store = undefined;
	fixture = undefined;
});

function setup(): MemoryStore {
	fixture = createTestDb();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	return store;
}

function route(args: {
	store: MemoryStore;
	action: "open_or_refine" | "complete";
	replayIdentity: string;
	at: number;
	occurrenceId?: string;
}) {
	const assertion = {
		kind: "task_lifecycle" as const,
		action: args.action,
		projectId: scope,
		subject: "user" as const,
		description: task,
		occurrenceAnchors:
			args.occurrenceId === undefined
				? {}
				: { explicitOccurrenceId: args.occurrenceId },
		revisionDetails: {},
	};
	const candidates = buildTaskLifecycleCandidateSet(
		{
			...assertion,
			commandId: "0".repeat(64),
			effectiveAtMs: args.at,
			timeSource: "first_resolution",
		},
		args.store.readTaskLifecycleInstances(scope),
	);
	const terminalTarget =
		args.action === "complete" && args.occurrenceId !== undefined
			? candidates.find(
					(candidate) =>
						candidate.occurrenceAnchors.explicitOccurrenceId === args.occurrenceId,
				)
			: undefined;
	return routeTaskLifecycleAssertion({
		assertion,
		source: {
			kind: "authorized_untraced",
			sessionKey: scope,
			replayIdentity: args.replayIdentity,
			assertionOrdinal: 0,
		},
		firstResolutionNowMs: args.at,
		store: args.store,
		...(terminalTarget === undefined
			? {}
			: {
					precomputedJudgment: {
						status: "completed" as const,
						value: {
							result: "same_instance",
							activeTaskId: terminalTarget.activeTaskId,
						},
						candidateSetVersion: taskLifecycleCandidateSetVersion(candidates),
					},
			}),
	});
}

function terminalCount(activeTaskId?: string): number {
	return (
		fixture?.sqlite
			.prepare(
				`SELECT COUNT(*) AS count
				FROM nodix_active_task_transitions
				WHERE project_id = ? AND active_task_id = ?
					AND transition_kind IN ('complete', 'remove')`,
			)
			.get(scope, activeTaskId) as { count: number }
	).count;
}

function status(activeTaskId?: string): string {
	return (
		fixture?.sqlite
			.prepare(
				`SELECT status FROM nodix_active_task_instances
				WHERE project_id = ? AND active_task_id = ?`,
			)
			.get(scope, activeTaskId) as { status: string }
	).status;
}

function todoStatus(activeTaskId?: string): string {
	return (
		fixture?.sqlite
			.prepare(
				`SELECT status FROM nodix_todos
				WHERE project_id = ? AND active_task_id = ?`,
			)
			.get(scope, activeTaskId) as { status: string }
	).status;
}

describe("active-task crash retry removal", () => {
	it("removes the task once across every exact completion replay", async () => {
		const target = setup();
		const occurrenceId = "journal-review-generation-1";
		const opened = await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "crash-open",
			occurrenceId,
			at: openedAt,
		});
		const completionInput = {
			store: target,
			action: "complete" as const,
			replayIdentity: "crash-done",
			occurrenceId,
			at: completedAt,
		};
		const first = await route(completionInput);
		for (let retry = 0; retry < 3; retry++) {
			const replay = await route(completionInput);
			expect(replay.write).toEqual({ ...first.write, replayed: true });
		}
		expect(status(opened.write.activeTaskId ?? undefined)).toBe("completed");
		expect(terminalCount(opened.write.activeTaskId ?? undefined)).toBe(1);
		expect(todoStatus(opened.write.activeTaskId ?? undefined)).toBe("done");
	});

	it("leaves simultaneous indistinguishable recurring tasks active", async () => {
		const target = setup();
		await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "same-a",
			occurrenceId: "same-a",
			at: openedAt,
		});
		await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "same-b",
			occurrenceId: "same-b",
			at: openedAt + 1,
		});
		const terminal = await route({
			store: target,
			action: "complete",
			replayIdentity: "ambiguous-done",
			at: completedAt,
		});

		expect(terminal.write.result).toBe("uncertain");
		expect(
			fixture?.sqlite
				.prepare(
					`SELECT status FROM nodix_active_task_instances
					WHERE project_id = ? ORDER BY active_task_id`,
				)
				.all(scope),
		).toEqual([{ status: "active" }, { status: "active" }]);
		expect(
			fixture?.sqlite
				.prepare("SELECT status FROM nodix_todos WHERE project_id = ? ORDER BY active_task_id")
				.all(scope),
		).toEqual([{ status: "open" }, { status: "open" }]);
	});

	it("rolls back a failure before the terminal transition and converges on retry", async () => {
		const target = setup();
		const occurrenceId = "journal-transition-failure";
		const opened = await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "transition-open",
			occurrenceId,
			at: openedAt,
		});
		fixture?.sqlite.exec(`
			CREATE TRIGGER fail_terminal_transition
			BEFORE INSERT ON nodix_active_task_transitions
			WHEN NEW.transition_kind = 'complete'
			BEGIN
				SELECT RAISE(ABORT, 'task transition crash');
			END;
		`);
		const completionInput = {
			store: target,
			action: "complete" as const,
			replayIdentity: "transition-done",
			occurrenceId,
			at: completedAt,
		};

		await expect(route(completionInput)).rejects.toThrow("task transition crash");
		expect(status(opened.write.activeTaskId ?? undefined)).toBe("active");
		expect(todoStatus(opened.write.activeTaskId ?? undefined)).toBe("open");
		expect(terminalCount(opened.write.activeTaskId ?? undefined)).toBe(0);
		fixture?.sqlite.exec("DROP TRIGGER fail_terminal_transition");
		await route(completionInput);
		expect(status(opened.write.activeTaskId ?? undefined)).toBe("completed");
		expect(todoStatus(opened.write.activeTaskId ?? undefined)).toBe("done");
		expect(terminalCount(opened.write.activeTaskId ?? undefined)).toBe(1);
	});

	it("rolls back a to-do update failure and converges without state drift", async () => {
		const target = setup();
		const occurrenceId = "journal-projection-failure";
		const opened = await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "projection-open",
			occurrenceId,
			at: openedAt,
		});
		fixture?.sqlite.exec(`
			CREATE TRIGGER fail_todo_update
			BEFORE UPDATE ON nodix_todos
			WHEN NEW.status = 'done'
			BEGIN
				SELECT RAISE(ABORT, 'todo update crash');
			END;
		`);
		const completionInput = {
			store: target,
			action: "complete" as const,
			replayIdentity: "projection-done",
			occurrenceId,
			at: completedAt,
		};

		await expect(route(completionInput)).rejects.toThrow("todo update crash");
		expect(status(opened.write.activeTaskId ?? undefined)).toBe("active");
		expect(todoStatus(opened.write.activeTaskId ?? undefined)).toBe("open");
		expect(terminalCount(opened.write.activeTaskId ?? undefined)).toBe(0);
		fixture?.sqlite.exec("DROP TRIGGER fail_todo_update");
		await route(completionInput);
		expect(status(opened.write.activeTaskId ?? undefined)).toBe("completed");
		expect(todoStatus(opened.write.activeTaskId ?? undefined)).toBe("done");
		expect(terminalCount(opened.write.activeTaskId ?? undefined)).toBe(1);
	});
});
