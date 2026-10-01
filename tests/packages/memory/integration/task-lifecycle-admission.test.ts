/** @file task-lifecycle-admission.test.ts
 * @purpose Proves replay-safe lifecycle command admission against real SQLite.
 * @boundary Command-input persistence only; no resolver, instance binding, or task-state mutation.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	admitTaskLifecycleAssertion,
	type AdmitTaskLifecycleAssertionInput,
	buildTaskLifecycleCommandClaim,
	type TaskLifecycleAssertionDraft,
	TaskLifecycleCommandMismatchError,
} from "../../../../packages/memory/src/engine/extraction/task-lifecycle-assertion";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { MemoryStore, TaskLifecycleTimestampCollisionError } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const baseDraft: TaskLifecycleAssertionDraft = {
	kind: "task_lifecycle",
	action: "open_or_refine",
	projectId: "work",
	subject: "user",
	description: "Submit the quarterly report",
	occurrenceAnchors: {
		explicitOccurrenceId: "quarterly-report-2033-q1",
	},
	revisionDetails: {
		deliverable: "quarterly report",
	},
};

describe("task lifecycle command admission", () => {
	let embedder: Embedder;
	let testDb: TestDb | undefined;
	let store: MemoryStore | undefined;

	beforeAll(async () => {
		embedder = await createTestEmbedder();
	});

	afterEach(async () => {
		await store?.close();
		testDb?.cleanup();
		store = undefined;
		testDb = undefined;
	});

	function setup(): { store: MemoryStore; testDb: TestDb } {
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		return { store, testDb };
	}

	function counts(sqlite: TestDb["sqlite"]): { timestamps: number; memories: number } {
		const timestamps = sqlite
			.prepare(
				"SELECT COUNT(*) AS count FROM nodix_memory_extraction_timestamps WHERE time_source IS NOT NULL",
			)
			.get() as { count: number };
		const memories = sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get() as {
			count: number;
		};
		return { timestamps: timestamps.count, memories: memories.count };
	}

	function admit(
		target: MemoryStore,
		input: Omit<AdmitTaskLifecycleAssertionInput, "commandClaim">,
	) {
		return admitTaskLifecycleAssertion(target, {
			...input,
			commandClaim: buildTaskLifecycleCommandClaim({
				assertion: input.assertion,
				source: input.source,
			}),
		});
	}

	it("persists all three time sources and returns the first resolution on replay", () => {
		const target = setup();
		const event = admit(target.store, {
			assertion: baseDraft,
			source: {
				kind: "authorized_untraced",
				sessionKey: "time-event",
				replayIdentity: "time-event-open",
				assertionOrdinal: 0,
			},
			eventAt: "2033-01-01T00:00:00.000Z",
			sessionTime: "2033-01-02T00:00:00.000Z",
			firstResolutionNowMs: 1_988_323_200_000,
		});
		expect(event.assertion).toMatchObject({
			commandId: "7a12286dc116a5ff1cc8646f9307ed76442e1dc7622ca376e1f1ee9976de28e3",
			effectiveAtMs: 1_988_150_400_000,
			timeSource: "event_at",
		});

		const session = admit(target.store, {
			assertion: baseDraft,
			source: {
				kind: "authorized_untraced",
				sessionKey: "time-session",
				replayIdentity: "time-session-open",
				assertionOrdinal: 0,
			},
			sessionTime: "2033-01-02T00:00:00.000Z",
			firstResolutionNowMs: 1_988_323_200_000,
		});
		expect(session.assertion).toMatchObject({
			commandId: "c027bf5bced4f075ec1cd726ca708ca76d020013b02fef5768b3573672effbe9",
			effectiveAtMs: 1_988_236_800_000,
			timeSource: "session_time",
		});

		const first = admit(target.store, {
			assertion: baseDraft,
			source: {
				kind: "authorized_untraced",
				sessionKey: "time-first",
				replayIdentity: "time-first-open",
				assertionOrdinal: 0,
			},
			firstResolutionNowMs: 1_988_323_200_000,
		});
		const replay = admit(target.store, {
			assertion: baseDraft,
			source: {
				kind: "authorized_untraced",
				sessionKey: "time-first",
				replayIdentity: "time-first-open",
				assertionOrdinal: 0,
			},
			firstResolutionNowMs: 1_988_409_600_000,
		});
		expect(first).toMatchObject({
			created: true,
			assertion: {
				effectiveAtMs: 1_988_323_200_000,
				timeSource: "first_resolution",
			},
		});
		expect(replay).toMatchObject({
			created: false,
			assertion: {
				effectiveAtMs: 1_988_323_200_000,
				timeSource: "first_resolution",
			},
		});
		expect(counts(target.testDb.sqlite)).toEqual({ timestamps: 3, memories: 0 });

		const persisted = target.testDb.sqlite
			.prepare(
				"SELECT resolved_at_ms AS effectiveAtMs, time_source AS timeSource FROM nodix_memory_extraction_timestamps WHERE project_id = ? AND replay_key = ?",
			)
			.get("work", first.assertion.commandId);
		expect(persisted).toEqual({
			effectiveAtMs: 1_988_323_200_000,
			timeSource: "first_resolution",
		});
	});

	it("rejects effective-time value and source collisions without task mutation", () => {
		const target = setup();
		const admitted = admit(target.store, {
			assertion: baseDraft,
			source: {
				kind: "authorized_untraced",
				sessionKey: "collision-session",
				replayIdentity: "collision-open",
				assertionOrdinal: 0,
			},
			sessionTime: "2033-01-02T00:00:00.000Z",
			firstResolutionNowMs: 1_988_323_200_000,
		});
		for (const conflicting of [
			{
				effectiveAtMs: admitted.assertion.effectiveAtMs + 1,
				timeSource: admitted.assertion.timeSource,
			},
			{
				effectiveAtMs: admitted.assertion.effectiveAtMs,
				timeSource: "event_at" as const,
			},
		]) {
			expect(() =>
				target.store.resolveTaskLifecycleTimestamp({
					projectId: "work",
					commandId: admitted.assertion.commandId,
					...conflicting,
				}),
			).toThrow(TaskLifecycleTimestampCollisionError);
			expect(counts(target.testDb.sqlite)).toEqual({ timestamps: 1, memories: 0 });
		}
	});

	it("rejects in-call command claim mismatches before timestamp persistence", () => {
		const target = setup();
		const source = {
			kind: "authorized_untraced",
			sessionKey: "claim-session",
			replayIdentity: "claim-open",
			assertionOrdinal: 0,
		} as const;
		const commandClaim = buildTaskLifecycleCommandClaim({
			assertion: baseDraft,
			source,
		});
		for (const conflicting of [
			{ commandId: "f".repeat(64) },
			{ identityJson: `${commandClaim.identityJson} ` },
			{ action: "complete" as const },
			{ sourceAssertionJson: `${commandClaim.sourceAssertionJson} ` },
		]) {
			expect(() =>
				admitTaskLifecycleAssertion(target.store, {
					assertion: baseDraft,
					source,
					commandClaim: { ...commandClaim, ...conflicting },
					firstResolutionNowMs: 1_988_323_200_000,
				}),
			).toThrow(TaskLifecycleCommandMismatchError);
			expect(counts(target.testDb.sqlite)).toEqual({ timestamps: 0, memories: 0 });
		}
	});

	it("fails closed when a canonical command already has a null-source timestamp", () => {
		const source = {
			kind: "authorized_untraced",
			sessionKey: "legacy-session",
			replayIdentity: "legacy-open",
			assertionOrdinal: 0,
		} as const;
		const commandClaim = buildTaskLifecycleCommandClaim({
			assertion: baseDraft,
			source,
		});
		testDb = createTestDb();
		testDb.sqlite
			.prepare(
				"INSERT INTO nodix_memory_extraction_timestamps (project_id, replay_key, resolved_at_ms) VALUES (?, ?, ?)",
			)
			.run("work", commandClaim.commandId, 1_988_323_200_000);
		const targetStore = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		store = targetStore;

		expect(() =>
			admitTaskLifecycleAssertion(targetStore, {
				assertion: baseDraft,
				source,
				commandClaim,
				firstResolutionNowMs: 1_988_409_600_000,
			}),
		).toThrow(TaskLifecycleTimestampCollisionError);
		expect(
			testDb.sqlite
				.prepare(
					"SELECT resolved_at_ms AS resolvedAtMs, time_source AS timeSource FROM nodix_memory_extraction_timestamps WHERE project_id = ? AND replay_key = ?",
				)
				.get("work", commandClaim.commandId),
		).toEqual({ resolvedAtMs: 1_988_323_200_000, timeSource: null });
		expect(counts(testDb.sqlite)).toEqual({ timestamps: 0, memories: 0 });
	});

	it.each([
		{ category: "profile", sectionName: "active_tasks", content: "ordinary candidate" },
		{ ...baseDraft, subject: "assistant" },
		{ ...baseDraft, action: "snooze" },
		{ ...baseDraft, extraField: true },
	])("rejects malformed input before persistence %#", (assertion) => {
		const target = setup();
		expect(() =>
			admit(target.store, {
				assertion,
				source: {
					kind: "authorized_untraced",
					sessionKey: "reject-session",
					replayIdentity: "reject-input",
					assertionOrdinal: 0,
				},
				firstResolutionNowMs: 1_988_323_200_000,
			}),
		).toThrow();
		expect(counts(target.testDb.sqlite)).toEqual({ timestamps: 0, memories: 0 });
	});
});
