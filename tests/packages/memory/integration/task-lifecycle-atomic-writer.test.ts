/** @file task-lifecycle-atomic-writer.test.ts
 * @purpose Proves lifecycle command, state, evidence, and to-do atomicity.
 * @boundary Real encrypted SQLite and real local embeddings; no repository substitutes or model replies.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	admitTaskLifecycleAssertion,
	allocateActiveTaskId,
	allocateActiveTaskRevisionId,
	buildTaskLifecycleCommandClaim,
	type TaskLifecycleAssertionDraft,
	type TaskLifecycleCommandClaim,
} from "../../../../packages/sno-station-mem/src/engine/extraction/task-lifecycle-assertion";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	buildTaskLifecycleCandidateSet,
	resolveTaskLifecycle,
	taskLifecycleCandidateSetVersion,
	type TaskLifecycleCanonicalRevisionDetails,
	type TaskLifecycleInstanceSnapshot,
} from "../../../../packages/sno-station-mem/src/engine/extraction/task-lifecycle-resolver";
import {
	MemoryStore,
	TaskLifecycleCommandCollisionError,
	TaskLifecycleStaleResolutionError,
	type TaskLifecycleWriteInput,
	type TaskLifecycleWriteResult,
} from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const projectId = "lifecycle-writer";
const firstAt = 2_000_000_000_000;

interface LifecycleCounts {
	commands: number;
	instances: number;
	revisions: number;
	transitions: number;
	evidence: number;
	openTodos: number;
	memoryTaskRows: number;
}

interface TodoProjectionRow {
	taskId: string;
	title: string;
}

interface SnapshotRow {
	projectId: string;
	activeTaskId: string;
	currentRevisionId: string;
	currentDescription: string;
	occurrenceAnchorsJson: string;
	revisionDetailsJson: string;
	createdAtMs: number;
	terminalAtMs: number | null;
}

function draft(
	description: string,
	overrides: Partial<TaskLifecycleAssertionDraft> = {},
): TaskLifecycleAssertionDraft {
	return {
		kind: "task_lifecycle",
		action: "open_or_refine",
		projectId,
		subject: "user",
		description,
		occurrenceAnchors: {},
		revisionDetails: {},
		...overrides,
	};
}

function lifecycleCounts(sqlite: TestDb["sqlite"], scope: string = projectId): LifecycleCounts {
	const count = (table: string): number => {
		const row = sqlite
			.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`)
			.get(scope) as { count: number };
		return row.count;
	};
	const openTodos = sqlite
		.prepare(
			"SELECT COUNT(*) AS count FROM nodix_todos WHERE project_id = ? AND status = 'open'",
		)
		.get(scope) as { count: number };
	const memoryTaskRows = sqlite
		.prepare(
			"SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.active_task_kind') IS NOT NULL",
		)
		.get(scope) as { count: number };
	return {
		commands: count("nodix_task_lifecycle_commands"),
		instances: count("nodix_active_task_instances"),
		revisions: count("nodix_active_task_revisions"),
		transitions: count("nodix_active_task_transitions"),
		evidence: count("nodix_active_task_evidence"),
		openTodos: openTodos.count,
		memoryTaskRows: memoryTaskRows.count,
	};
}

function readSnapshots(sqlite: TestDb["sqlite"], scope: string = projectId) {
	const rows = sqlite
		.prepare(
			`SELECT
				i.project_id AS projectId,
				i.active_task_id AS activeTaskId,
				r.active_task_revision_id AS currentRevisionId,
				r.description AS currentDescription,
				r.occurrence_anchors_json AS occurrenceAnchorsJson,
				r.revision_details_json AS revisionDetailsJson,
				i.created_at_ms AS createdAtMs,
				i.terminal_at_ms AS terminalAtMs
			FROM nodix_active_task_instances i
			JOIN nodix_active_task_revisions r
				ON r.project_id = i.project_id
				AND r.active_task_id = i.active_task_id
				AND r.created_at_ms = (
					SELECT MAX(r2.created_at_ms)
					FROM nodix_active_task_revisions r2
					WHERE r2.project_id = i.project_id
						AND r2.active_task_id = i.active_task_id
				)
			WHERE i.project_id = ?
			ORDER BY i.created_at_ms, i.active_task_id`,
		)
		.all(scope) as SnapshotRow[];
	return rows.map(
		(row): TaskLifecycleInstanceSnapshot => ({
			projectId: row.projectId,
			activeTaskId: row.activeTaskId,
			currentRevisionId: row.currentRevisionId,
			currentDescription: row.currentDescription,
			occurrenceAnchors: JSON.parse(row.occurrenceAnchorsJson) as TaskLifecycleInstanceSnapshot["occurrenceAnchors"],
			revisionDetails: JSON.parse(
				row.revisionDetailsJson,
			) as TaskLifecycleCanonicalRevisionDetails,
			createdAtMs: row.createdAtMs,
			...(row.terminalAtMs === null ? {} : { terminalAtMs: row.terminalAtMs }),
		}),
	);
}

function currentTodoProjection(
	sqlite: TestDb["sqlite"],
	scope: string = projectId,
): { taskIds: string[]; titles: string[] } {
	const rows = sqlite
		.prepare(
			"SELECT active_task_id AS taskId, description AS title FROM nodix_todos WHERE project_id = ? AND status = 'open' ORDER BY opened_at, active_task_id",
		)
		.all(scope) as TodoProjectionRow[];
	return {
		taskIds: rows.map((row) => row.taskId),
		titles: rows.map((row) => row.title),
	};
}

describe("task lifecycle atomic writer", () => {
	let embedder: Embedder;
	let testDb: TestDb | undefined;
	let store: MemoryStore | undefined;
	let sequence = 0;

	beforeAll(async () => {
		embedder = await createTestEmbedder();
	});

	afterEach(() => {
		store?.closeSync();
		testDb?.cleanup();
		store = undefined;
		testDb = undefined;
		sequence = 0;
	});

	function setup(): { store: MemoryStore; sqlite: TestDb["sqlite"] } {
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		return { store, sqlite: testDb.sqlite };
	}

	function prepareWrite(
		target: MemoryStore,
		sqlite: TestDb["sqlite"],
		assertionDraft: TaskLifecycleAssertionDraft,
		options: {
			at?: number;
			scope?: string;
			judgment?: Parameters<typeof resolveTaskLifecycle>[0]["judgment"];
			replayIdentity?: string;
			instances?: TaskLifecycleInstanceSnapshot[];
		} = {},
	): TaskLifecycleWriteInput {
		const ordinal = sequence++;
		const source = {
			kind: "authorized_untraced" as const,
			sessionKey: `writer-session-${ordinal}`,
			replayIdentity: options.replayIdentity ?? `writer-assertion-${ordinal}`,
			assertionOrdinal: ordinal,
		};
		const commandClaim = buildTaskLifecycleCommandClaim({
			assertion: assertionDraft,
			source,
		});
		const admission = admitTaskLifecycleAssertion(target, {
			assertion: assertionDraft,
			source,
			commandClaim,
			sessionTime: new Date(options.at ?? firstAt + ordinal * 1_000).toISOString(),
			firstResolutionNowMs: options.at ?? firstAt + ordinal * 1_000,
		});
		const instances =
			options.instances ?? readSnapshots(sqlite, options.scope ?? assertionDraft.projectId);
		const candidates = buildTaskLifecycleCandidateSet(admission.assertion, instances);
		const [soleCandidate] = candidates;
		const terminalJudgment =
			assertionDraft.action === "open_or_refine" || candidates.length !== 1 || !soleCandidate
				? { status: "absent" as const }
				: {
						status: "completed" as const,
						value: {
							result: "same_instance",
							activeTaskId: soleCandidate.activeTaskId,
						},
						candidateSetVersion: taskLifecycleCandidateSetVersion(candidates),
					};
		const resolution = resolveTaskLifecycle({
			assertion: admission.assertion,
			instances,
			judgment: options.judgment ?? terminalJudgment,
		});
		return { admission, commandClaim, resolution };
	}

	async function apply(
		target: MemoryStore,
		input: TaskLifecycleWriteInput,
	): Promise<TaskLifecycleWriteResult> {
		return target.applyTaskLifecycleResolution(input);
	}

	it("persists open, material refinement, evidence-only refinement, replay, and collision rules", async () => {
		const target = setup();
		const occurrenceAnchors = { explicitOccurrenceId: "report-2033-q1" };
		const opening = prepareWrite(
			target.store,
			target.sqlite,
			draft("Submit the quarterly report", {
				occurrenceAnchors,
				revisionDetails: { deadline: "2033-01-10", deliverable: "quarterly report" },
				evidenceMemoryId: "evidence-open",
			}),
		);
		const opened = await apply(target.store, opening);
		const expectedTaskId = allocateActiveTaskId(
			projectId,
			opening.admission.assertion.commandId,
		);
		const expectedRevisionId = allocateActiveTaskRevisionId(
			expectedTaskId,
			opening.admission.assertion.commandId,
		);
		expect(opened).toMatchObject({
			replayed: false,
			result: "created_instance",
			activeTaskId: expectedTaskId,
			activeTaskRevisionId: expectedRevisionId,
		});
		expect(currentTodoProjection(target.sqlite).taskIds).toEqual([expectedTaskId]);

		const material = prepareWrite(
			target.store,
			target.sqlite,
			draft("Submit the quarterly report", {
				occurrenceAnchors,
				revisionDetails: { deadline: "2033-01-12" },
				evidenceMemoryId: "evidence-material",
			}),
		);
		const refined = await apply(target.store, material);
		expect(refined).toMatchObject({
			result: "refined",
			activeTaskId: expectedTaskId,
			activeTaskRevisionId: allocateActiveTaskRevisionId(
				expectedTaskId,
				material.admission.assertion.commandId,
			),
		});

		const evidenceOnly = prepareWrite(
			target.store,
			target.sqlite,
			draft("Submit the quarterly report", {
				occurrenceAnchors,
				revisionDetails: { deadline: "2033-01-12" },
				evidenceMemoryId: "evidence-only",
			}),
		);
		const todoBeforeEvidence = currentTodoProjection(target.sqlite);
		expect(await apply(target.store, evidenceOnly)).toMatchObject({
			result: "evidence_only",
			activeTaskId: expectedTaskId,
			activeTaskRevisionId: null,
		});
		expect(currentTodoProjection(target.sqlite)).toEqual(todoBeforeEvidence);

		const countsBeforeReplay = lifecycleCounts(target.sqlite);
		expect(await apply(target.store, material)).toEqual({
			...refined,
			replayed: true,
		});
		expect(lifecycleCounts(target.sqlite)).toEqual(countsBeforeReplay);

		const conflictingClaim: TaskLifecycleCommandClaim = {
			...material.commandClaim,
			sourceAssertionJson: `${material.commandClaim.sourceAssertionJson} `,
		};
		await expect(
			apply(target.store, { ...material, commandClaim: conflictingClaim }),
		).rejects.toBeInstanceOf(TaskLifecycleCommandCollisionError);
		expect(lifecycleCounts(target.sqlite)).toEqual(countsBeforeReplay);
		expect(lifecycleCounts(target.sqlite)).toMatchObject({
			commands: 3,
			instances: 1,
			revisions: 2,
			transitions: 2,
			evidence: 3,
			openTodos: 1,
			memoryTaskRows: 0,
		});
	});

	it("reads the current revision after a delayed refinement with an earlier timestamp", async () => {
		const target = setup();
		const occurrenceAnchors = { explicitOccurrenceId: "delayed-current-revision" };
		await apply(
			target.store,
			prepareWrite(
				target.store,
				target.sqlite,
				draft("Submit the delayed report", { occurrenceAnchors }),
				{ at: firstAt },
			),
		);
		await apply(
			target.store,
			prepareWrite(
				target.store,
				target.sqlite,
				draft("Submit the delayed report", {
					occurrenceAnchors,
					revisionDetails: { deadline: "2033-01-20" },
				}),
				{ at: firstAt + 2_000 },
			),
		);
		const delayed = await apply(
			target.store,
			prepareWrite(
				target.store,
				target.sqlite,
				draft("Submit the delayed report", {
					occurrenceAnchors,
					revisionDetails: { deadline: "2033-01-10" },
				}),
				{ at: firstAt + 1_000 },
			),
		);

		const instances = target.store.readTaskLifecycleInstances(projectId);
		expect(instances).toHaveLength(1);
		expect(instances[0]?.currentRevisionId).toBe(delayed.activeTaskRevisionId);

		const completion = prepareWrite(
			target.store,
			target.sqlite,
			draft("Submit the delayed report", {
				action: "complete",
				occurrenceAnchors,
			}),
			{ at: firstAt + 3_000, instances },
		);
		await expect(apply(target.store, completion)).resolves.toMatchObject({
			result: "completed",
			activeTaskId: delayed.activeTaskId,
		});
	});

	it("rejects a terminal transition effective before the task opening", async () => {
		const target = setup();
		const occurrenceAnchors = { explicitOccurrenceId: "terminal-before-opening" };
		await apply(
			target.store,
			prepareWrite(
				target.store,
				target.sqlite,
				draft("Submit the chronological report", { occurrenceAnchors }),
				{ at: firstAt },
			),
		);
		const terminal = prepareWrite(
			target.store,
			target.sqlite,
			draft("Submit the chronological report", {
				action: "complete",
				occurrenceAnchors,
			}),
			{ at: firstAt + 1_000 },
		);
		const staleTerminal: TaskLifecycleWriteInput = {
			...terminal,
			admission: {
				...terminal.admission,
				assertion: {
					...terminal.admission.assertion,
					effectiveAtMs: firstAt - 1_000,
				},
			},
		};

		await expect(apply(target.store, staleTerminal)).rejects.toBeInstanceOf(
			TaskLifecycleStaleResolutionError,
		);
		expect(
			target.sqlite
				.prepare(
					"SELECT status, terminal_at_ms AS terminalAtMs FROM nodix_active_task_instances WHERE project_id = ?",
				)
				.get(projectId),
		).toEqual({ status: "active", terminalAtMs: null });
	});

	it("applies complete and remove once and attaches later evidence without a second terminal transition", async () => {
		const target = setup();
		const completeAnchors = { explicitOccurrenceId: "permit-a" };
		const completeOpen = prepareWrite(
			target.store,
			target.sqlite,
			draft("File permit renewal A", { occurrenceAnchors: completeAnchors }),
		);
		const completeOpened = await apply(target.store, completeOpen);
		const complete = prepareWrite(
			target.store,
			target.sqlite,
			draft("File permit renewal A", {
				action: "complete",
				occurrenceAnchors: completeAnchors,
				evidenceMemoryId: "evidence-complete",
			}),
		);
		expect(await apply(target.store, complete)).toMatchObject({
			result: "completed",
			activeTaskId: completeOpened.activeTaskId,
		});

		const laterEvidence = prepareWrite(
			target.store,
			target.sqlite,
			draft("File permit renewal A", {
				action: "complete",
				occurrenceAnchors: completeAnchors,
				evidenceMemoryId: "evidence-complete-again",
			}),
			{ at: complete.admission.assertion.effectiveAtMs },
		);
		const transitionsBeforeEvidence = lifecycleCounts(target.sqlite).transitions;
		expect(await apply(target.store, laterEvidence)).toMatchObject({
			result: "terminal_evidence_only",
			activeTaskId: completeOpened.activeTaskId,
		});
		expect(lifecycleCounts(target.sqlite).transitions).toBe(transitionsBeforeEvidence);

		const removeAnchors = { explicitOccurrenceId: "permit-b" };
		const removeOpen = prepareWrite(
			target.store,
			target.sqlite,
			draft("File permit renewal B", { occurrenceAnchors: removeAnchors }),
		);
		const removeOpened = await apply(target.store, removeOpen);
		const remove = prepareWrite(
			target.store,
			target.sqlite,
			draft("File permit renewal B", {
				action: "remove",
				occurrenceAnchors: removeAnchors,
				evidenceMemoryId: "evidence-remove",
			}),
		);
		expect(await apply(target.store, remove)).toMatchObject({
			result: "removed",
			activeTaskId: removeOpened.activeTaskId,
		});
		expect(currentTodoProjection(target.sqlite).taskIds).toEqual([]);
		expect(
			target.sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM nodix_active_task_revisions WHERE project_id = ? AND is_current = 1",
				)
				.get(projectId),
		).toEqual({ count: 0 });
	});

	it("persists a backdated material refinement without reactivating a later-terminal instance", async () => {
		const target = setup();
		const occurrenceAnchors = { explicitOccurrenceId: "backdated-refine" };
		const opened = await apply(
			target.store,
			prepareWrite(
				target.store,
				target.sqlite,
				draft("Prepare the backdated report", { occurrenceAnchors }),
				{ at: firstAt },
			),
		);
		await apply(
			target.store,
			prepareWrite(
				target.store,
				target.sqlite,
				draft("Prepare the backdated report", {
					action: "complete",
					occurrenceAnchors,
				}),
				{ at: firstAt + 2_000 },
			),
		);
		const backdated = prepareWrite(
			target.store,
			target.sqlite,
			draft("Prepare the backdated report", {
				occurrenceAnchors,
				revisionDetails: { deadline: "2033-03-01" },
			}),
			{ at: firstAt + 1_000 },
		);
		expect(backdated.resolution).toMatchObject({
			result: "same_instance",
			revisionIntent: { kind: "successor_revision" },
		});

		const result = await apply(target.store, backdated);
		expect(result).toMatchObject({
			result: "refined",
			activeTaskId: opened.activeTaskId,
		});
		expect(
			target.sqlite
				.prepare(
					"SELECT status, terminal_at_ms AS terminalAtMs FROM nodix_active_task_instances WHERE project_id = ? AND active_task_id = ?",
				)
				.get(projectId, opened.activeTaskId),
		).toEqual({ status: "completed", terminalAtMs: firstAt + 2_000 });
		expect(
			target.sqlite
				.prepare(
					"SELECT is_current AS isCurrent FROM nodix_active_task_revisions WHERE project_id = ? AND active_task_revision_id = ?",
				)
				.get(projectId, result.activeTaskRevisionId),
		).toEqual({ isCurrent: 0 });
		expect(currentTodoProjection(target.sqlite).taskIds).toEqual([]);
	});

	it("reconciles two queued terminal commands into one terminal transition", async () => {
		const target = setup();
		if (!testDb) throw new Error("expected initialized test database");
		const competingStore = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		const occurrenceAnchors = { explicitOccurrenceId: "concurrent-terminal" };
		const opened = await apply(
			target.store,
			prepareWrite(
				target.store,
				target.sqlite,
				draft("Close the concurrent task", { occurrenceAnchors }),
			),
		);
		const complete = prepareWrite(
			target.store,
			target.sqlite,
			draft("Close the concurrent task", {
				action: "complete",
				occurrenceAnchors,
				evidenceMemoryId: "concurrent-complete",
			}),
		);
		const remove = prepareWrite(
			target.store,
			target.sqlite,
			draft("Close the concurrent task", {
				action: "remove",
				occurrenceAnchors,
				evidenceMemoryId: "concurrent-remove",
			}),
		);

		try {
			const results = await Promise.all([
				apply(target.store, complete),
				apply(competingStore, remove),
			]);
			const terminalResults = results.filter(
				(result) => result.result === "completed" || result.result === "removed",
			);
			expect(terminalResults).toHaveLength(1);
			expect(results.map((result) => result.result)).toContain("terminal_evidence_only");
			expect(lifecycleCounts(target.sqlite)).toEqual({
				commands: 3,
				instances: 1,
				revisions: 1,
				transitions: 2,
				evidence: 3,
				openTodos: 0,
				memoryTaskRows: 0,
			});
			expect(
				target.sqlite
					.prepare(
						"SELECT status FROM nodix_active_task_instances WHERE project_id = ? AND active_task_id = ?",
					)
					.get(projectId, opened.activeTaskId),
			).toEqual({ status: terminalResults[0]?.result });
		} finally {
			competingStore.closeSync();
		}
	});

	it("persists unresolved open plus terminal none and uncertain diagnostics without terminal mutation", async () => {
		const target = setup();
		await apply(
			target.store,
			prepareWrite(
				target.store,
				target.sqlite,
				draft("Plan the launch event", {
					occurrenceAnchors: { explicitOccurrenceId: "launch-a" },
				}),
			),
		);
		const unresolved = prepareWrite(
			target.store,
			target.sqlite,
			draft("Arrange the launch event"),
		);
		expect(unresolved.resolution).toMatchObject({
			result: "uncertain",
			disposition: "visible_unresolved_open",
		});
		const unresolvedResult = await apply(target.store, unresolved);
		expect(unresolvedResult.result).toBe("created_unresolved_instance");
		expect(
			target.sqlite
				.prepare(
					"SELECT identity_state AS identityState FROM nodix_active_task_instances WHERE project_id = ? AND active_task_id = ?",
				)
				.get(projectId, unresolvedResult.activeTaskId),
		).toEqual({ identityState: "unresolved" });

		const none = prepareWrite(
			target.store,
			target.sqlite,
			draft("No matching task", {
				action: "complete",
				projectId: "terminal-none",
				evidenceMemoryId: "evidence-none",
			}),
			{ scope: "terminal-none" },
		);
		expect(none.resolution.result).toBe("none");
		const noneBefore = lifecycleCounts(target.sqlite, "terminal-none");
		expect(await apply(target.store, none)).toMatchObject({
			result: "none",
			activeTaskId: null,
			activeTaskRevisionId: null,
		});
		expect(lifecycleCounts(target.sqlite, "terminal-none")).toEqual({
			...noneBefore,
			commands: 1,
			evidence: 1,
		});

		const firstDuplicate = prepareWrite(
			target.store,
			target.sqlite,
			draft("File the permit renewal", {
				occurrenceAnchors: { explicitOccurrenceId: "duplicate-a" },
			}),
		);
		await apply(target.store, firstDuplicate);
		const secondDuplicate = prepareWrite(
			target.store,
			target.sqlite,
			draft("File the permit renewal", {
				occurrenceAnchors: { explicitOccurrenceId: "duplicate-b" },
			}),
		);
		await apply(target.store, secondDuplicate);
		const uncertain = prepareWrite(
			target.store,
			target.sqlite,
			draft("File the permit renewal", {
				action: "complete",
				evidenceMemoryId: "evidence-uncertain",
			}),
		);
		expect(uncertain.resolution.result).toBe("uncertain");
		const beforeUncertain = lifecycleCounts(target.sqlite);
		const todoBeforeUncertain = currentTodoProjection(target.sqlite);
		expect(await apply(target.store, uncertain)).toMatchObject({
			result: "uncertain",
			activeTaskId: null,
			activeTaskRevisionId: null,
		});
		expect(lifecycleCounts(target.sqlite)).toEqual({
			...beforeUncertain,
			commands: beforeUncertain.commands + 1,
			evidence: beforeUncertain.evidence + 1,
		});
		expect(currentTodoProjection(target.sqlite)).toEqual(todoBeforeUncertain);
		expect(
			target.sqlite
				.prepare(
					"SELECT diagnostics_json AS diagnosticsJson FROM nodix_task_lifecycle_commands WHERE project_id = ? AND command_id = ?",
				)
				.get(projectId, uncertain.admission.assertion.commandId),
		).toEqual({
			diagnosticsJson: JSON.stringify(uncertain.resolution),
		});
	});

	it("rolls back command, state, transition, evidence, and to-do on a real SQLite abort", async () => {
		const target = setup();
		const anchors = { explicitOccurrenceId: "rollback-open" };
		await apply(
			target.store,
			prepareWrite(
				target.store,
				target.sqlite,
				draft("Roll back the entire lifecycle write", {
					occurrenceAnchors: anchors,
					revisionDetails: { deadline: "2033-02-01" },
					evidenceMemoryId: "evidence-before-rollback",
				}),
			),
		);
		const countsBeforeAbort = lifecycleCounts(target.sqlite);
		const todoBeforeAbort = currentTodoProjection(target.sqlite);
		target.sqlite.exec(`
			CREATE TRIGGER fail_lifecycle_evidence
			AFTER INSERT ON nodix_active_task_evidence
			WHEN NEW.project_id = '${projectId}'
			BEGIN
				SELECT RAISE(ABORT, 'lifecycle evidence abort');
			END;
		`);
		const input = prepareWrite(
			target.store,
			target.sqlite,
			draft("Roll back the entire lifecycle write", {
				occurrenceAnchors: anchors,
				revisionDetails: { deadline: "2033-02-02" },
				evidenceMemoryId: "evidence-rollback",
			}),
		);

		await expect(apply(target.store, input)).rejects.toThrow("lifecycle evidence abort");
		expect(lifecycleCounts(target.sqlite)).toEqual(countsBeforeAbort);
		expect(currentTodoProjection(target.sqlite)).toEqual(todoBeforeAbort);
		expect(readSnapshots(target.sqlite)[0]?.revisionDetails).toEqual({
			deadline: "2033-02-01",
		});
	});

	it("keeps the open to-do rows aligned with active task instances", async () => {
		const target = setup();
		for (const description of ["Book the venue", "Confirm the caterer", "Send the invitations"]) {
			await apply(
				target.store,
				prepareWrite(target.store, target.sqlite, draft(description)),
			);
		}
		const todo = currentTodoProjection(target.sqlite);
		const activeTaskIds = (
			target.sqlite
				.prepare(
					"SELECT active_task_id AS taskId FROM nodix_active_task_instances WHERE project_id = ? AND status = 'active' ORDER BY created_at_ms, active_task_id",
				)
				.all(projectId) as { taskId: string }[]
		).map((row) => row.taskId);
		expect(todo.taskIds).toEqual(activeTaskIds);
		expect(todo.taskIds).toHaveLength(3);
		expect(lifecycleCounts(target.sqlite).memoryTaskRows).toBe(0);
	});

	it("replays two queued exact duplicates without duplicating the transition or to-do", async () => {
		const target = setup();
		const input = prepareWrite(
			target.store,
			target.sqlite,
			draft("Serialize the duplicate command", {
				occurrenceAnchors: { explicitOccurrenceId: "concurrent-open" },
			}),
		);

		const results = await Promise.all([
			apply(target.store, input),
			apply(target.store, input),
		]);
		expect(results.map((result) => result.replayed).toSorted()).toEqual([false, true]);
		expect(new Set(results.map((result) => result.activeTaskId)).size).toBe(1);
		expect(lifecycleCounts(target.sqlite)).toEqual({
			commands: 1,
			instances: 1,
			revisions: 1,
			transitions: 1,
			evidence: 1,
			openTodos: 1,
			memoryTaskRows: 0,
		});
	});

	it("keeps all 26 durable instances and open to-do rows", async () => {
		const target = setup();
		const createdIds: string[] = [];
		for (let index = 0; index < 26; index++) {
			const input = prepareWrite(
				target.store,
				target.sqlite,
				draft(`Candidate task ${String(index + 1).padStart(2, "0")}`, {
					occurrenceAnchors: {
						explicitOccurrenceId: `candidate-${String(index + 1).padStart(2, "0")}`,
					},
				}),
				{ at: firstAt + Math.min(index, 24) * 1_000 },
			);
			const result = await apply(target.store, input);
			if (!result.activeTaskId) throw new Error("expected a durable active task id");
			createdIds.push(result.activeTaskId);
		}

		expect(lifecycleCounts(target.sqlite)).toMatchObject({
			commands: 26,
			instances: 26,
			revisions: 26,
			transitions: 26,
			evidence: 26,
			openTodos: 26,
			memoryTaskRows: 0,
		});
		const expectedTodoIds = [...createdIds.slice(0, 24), ...createdIds.slice(24).toSorted()];
		expect(currentTodoProjection(target.sqlite).taskIds).toEqual(expectedTodoIds);
	});
});
