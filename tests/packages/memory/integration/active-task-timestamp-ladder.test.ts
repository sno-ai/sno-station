/** @file active-task-timestamp-ladder.test.ts
 * @purpose Preserves effective-time precedence and replay through the lifecycle admission boundary.
 * @boundary Real encrypted SQLite; no wall-clock or storage mocks.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveTaskLifecycleEffectiveTime } from "../../../../packages/sno-station-mem/src/engine/extraction/task-lifecycle-assertion.ts";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import {
	buildTaskLifecycleCandidateSet,
	taskLifecycleCandidateSetVersion,
} from "../../../../packages/sno-station-mem/src/engine/extraction/task-lifecycle-resolver.ts";
import { routeTaskLifecycleAssertion } from "../../../../packages/sno-station-mem/src/engine/extraction/task-lifecycle-route.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const projectId = "timestamp-ladder";
const taskText = "file the quarterly expense report";
const occurrenceId = "quarterly-expense-report";

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
	firstResolutionNowMs: number;
	occurrence?: string;
	eventAt?: string;
	sessionTime?: string;
}) {
	const assertion = {
		kind: "task_lifecycle" as const,
		action: args.action,
		projectId,
		subject: "user" as const,
		description: taskText,
		occurrenceAnchors: {
			explicitOccurrenceId: args.occurrence ?? occurrenceId,
		},
		revisionDetails: {},
	};
	const effectiveTime = resolveTaskLifecycleEffectiveTime({
		...(args.eventAt === undefined ? {} : { eventAt: args.eventAt }),
		...(args.sessionTime === undefined ? {} : { sessionTime: args.sessionTime }),
		firstResolutionNowMs: args.firstResolutionNowMs,
	});
	const candidates = buildTaskLifecycleCandidateSet(
		{
			...assertion,
			commandId: "0".repeat(64),
			...effectiveTime,
		},
		args.store.readTaskLifecycleInstances(projectId),
	);
	const terminalTarget = args.action === "open_or_refine" ? undefined : candidates[0];
	return routeTaskLifecycleAssertion({
		assertion,
		source: {
			kind: "authorized_untraced",
			sessionKey: projectId,
			replayIdentity: args.replayIdentity,
			assertionOrdinal: 0,
		},
		...(args.eventAt === undefined ? {} : { eventAt: args.eventAt }),
		...(args.sessionTime === undefined ? {} : { sessionTime: args.sessionTime }),
		firstResolutionNowMs: args.firstResolutionNowMs,
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

function persistedTime(commandId: string): { effectiveAtMs: number; timeSource: string } {
	return fixture?.sqlite
		.prepare(
			`SELECT effective_at_ms AS effectiveAtMs, time_source AS timeSource
			FROM nodix_task_lifecycle_commands
			WHERE project_id = ? AND command_id = ?`,
		)
		.get(projectId, commandId) as { effectiveAtMs: number; timeSource: string };
}

describe("active-task timestamp ladder", () => {
	it("keeps direct identical occurrences distinct and their replays stable", async () => {
		const target = setup();
		const firstInput = {
			store: target,
			action: "open_or_refine" as const,
			replayIdentity: "occurrence-1",
			occurrence: "occurrence-1",
			firstResolutionNowMs: 100,
		};
		const secondInput = {
			store: target,
			action: "open_or_refine" as const,
			replayIdentity: "occurrence-2",
			occurrence: "occurrence-2",
			firstResolutionNowMs: 200,
		};
		const first = await route(firstInput);
		const second = await route(secondInput);
		const replay = await route({ ...firstInput, firstResolutionNowMs: 300 });

		expect(second.write.activeTaskId).not.toBe(first.write.activeTaskId);
		expect(replay).toEqual({
			...first,
			resolution: null,
			write: { ...first.write, replayed: true },
		});
		expect(persistedTime(first.write.commandId)).toEqual({
			effectiveAtMs: 100,
			timeSource: "first_resolution",
		});
	});

	it("uses persisted valid-at-now at the task mutation guard", async () => {
		const target = setup();
		const validAtNow = Date.parse("2030-01-02T03:04:05.000Z");
		const result = await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "missing-date-open",
			firstResolutionNowMs: validAtNow,
		});

		expect(result).toMatchObject({
			effectiveAtMs: validAtNow,
			timeSource: "first_resolution",
		});
		expect(persistedTime(result.write.commandId)).toEqual({
			effectiveAtMs: validAtNow,
			timeSource: "first_resolution",
		});
	});

	it("uses persisted valid-at-now at the completion guard", async () => {
		const target = setup();
		await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "initial-open",
			firstResolutionNowMs: Date.parse("2030-01-01T00:00:00.000Z"),
		});
		const validAtNow = Date.parse("2030-01-02T00:00:00.000Z");
		const completed = await route({
			store: target,
			action: "complete",
			replayIdentity: "missing-date-completion",
			firstResolutionNowMs: validAtNow,
		});

		expect(completed).toMatchObject({
			effectiveAtMs: validAtNow,
			timeSource: "first_resolution",
			write: { result: "completed" },
		});
		expect(persistedTime(completed.write.commandId)).toEqual({
			effectiveAtMs: validAtNow,
			timeSource: "first_resolution",
		});
		expect(
			fixture?.sqlite
				.prepare(
					"SELECT status, closed_at AS closedAt FROM nodix_todos WHERE project_id = ?",
				)
				.get(projectId),
		).toEqual({ status: "done", closedAt: validAtNow });
	});

	it("persists session date fallback at both guard sites", async () => {
		const target = setup();
		const openSessionDate = "2030-01-01T00:00:00.000Z";
		const opened = await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "session-date-open",
			firstResolutionNowMs: 1,
			sessionTime: openSessionDate,
		});
		const completionSessionDate = "2030-01-02T00:00:00.000Z";
		const completed = await route({
			store: target,
			action: "complete",
			replayIdentity: "session-date-completion",
			firstResolutionNowMs: 2,
			sessionTime: completionSessionDate,
		});

		expect(persistedTime(opened.write.commandId)).toEqual({
			effectiveAtMs: Date.parse(openSessionDate),
			timeSource: "session_time",
		});
		expect(persistedTime(completed.write.commandId)).toEqual({
			effectiveAtMs: Date.parse(completionSessionDate),
			timeSource: "session_time",
		});
		expect(completed.write.result).toBe("completed");
	});

	it("reuses an old completion time after the task is reopened", async () => {
		const target = setup();
		await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "initial-open",
			firstResolutionNowMs: Date.parse("2030-01-01T00:00:00.000Z"),
		});
		const firstCompletionAt = Date.parse("2030-01-02T00:00:00.000Z");
		const completionInput = {
			store: target,
			action: "complete" as const,
			replayIdentity: "stable-completion",
			firstResolutionNowMs: firstCompletionAt,
		};
		const firstCompletion = await route(completionInput);
		const reopened = await route({
			store: target,
			action: "open_or_refine",
			replayIdentity: "later-reopen",
			occurrence: "quarterly-expense-report-generation-2",
			firstResolutionNowMs: Date.parse("2030-01-03T00:00:00.000Z"),
		});
		const replay = await route({
			...completionInput,
			firstResolutionNowMs: Date.parse("2030-01-04T00:00:00.000Z"),
		});

		expect(replay.write).toEqual({ ...firstCompletion.write, replayed: true });
		expect(replay.effectiveAtMs).toBe(firstCompletionAt);
		expect(
			fixture?.sqlite
				.prepare(
					`SELECT status FROM nodix_active_task_instances
					WHERE project_id = ? AND active_task_id = ?`,
				)
				.get(projectId, reopened.write.activeTaskId),
		).toEqual({ status: "active" });
	});
});
