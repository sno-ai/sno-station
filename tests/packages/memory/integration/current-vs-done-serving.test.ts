/** @file current-vs-done-serving.test.ts
 * @purpose Proves a finished task is not served as a live one on the default recall route (PRD 230).
 * @boundary Real encrypted SQLite and real local embeddings; no repository substitutes or model replies.
 *
 * The two serving entrypoints are the subject, not the raw retriever: PRD 230 puts the
 * task-lifecycle default at the recall-context builders in `rem-consumer-retrieval.ts`,
 * so a call that skips them is the pre-change behaviour and is used here as the control.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	admitTaskLifecycleAssertion,
	buildTaskLifecycleCommandClaim,
	type TaskLifecycleAssertionDraft,
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
	retrieveForAutoRecall,
	retrieveForMemoryRecallOrEval,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/rem-consumer-retrieval";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import type { MemoryRetriever } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import { MemoryStore, type TaskLifecycleWriteInput } from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const projectId = "current-vs-done";
const firstAt = 2_100_000_000_000;
/** Well past every write below, so the block 205 invalidation gate is not what decides anything. */
const nowMs = firstAt + 1_000_000;

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

interface CarrierRow {
	id: string;
	metadata: string;
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

function readSnapshots(sqlite: TestDb["sqlite"], scope: string): TaskLifecycleInstanceSnapshot[] {
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
				AND r.is_current = 1
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
			occurrenceAnchors: JSON.parse(
				row.occurrenceAnchorsJson,
			) as TaskLifecycleInstanceSnapshot["occurrenceAnchors"],
			revisionDetails: JSON.parse(
				row.revisionDetailsJson,
			) as TaskLifecycleCanonicalRevisionDetails,
			createdAtMs: row.createdAtMs,
			...(row.terminalAtMs === null ? {} : { terminalAtMs: row.terminalAtMs }),
		}),
	);
}

/** Live carrier ids by stamped lifecycle status, read from the store rather than assumed. */
function carrierIdsByStatus(sqlite: TestDb["sqlite"]): Map<string, string[]> {
	const rows = sqlite
		.prepare(
			`SELECT id, metadata
			FROM nodix_memories
			WHERE project_id = ?
				AND lane = 'active'
				AND json_valid(metadata)
				AND json_extract(metadata, '$.active_task_kind') = 'task'
				AND json_extract(metadata, '$.invalidated_at') IS NULL
			ORDER BY id`,
		)
		.all(projectId) as CarrierRow[];
	const out = new Map<string, string[]>();
	for (const row of rows) {
		const status = String(
			(JSON.parse(row.metadata) as { active_task_status?: unknown }).active_task_status,
		);
		out.set(status, [...(out.get(status) ?? []), row.id]);
	}
	return out;
}

function liveProjectionId(sqlite: TestDb["sqlite"]): string {
	const row = sqlite
		.prepare(
			`SELECT id FROM nodix_memories
			WHERE project_id = ?
				AND lane = 'active'
				AND json_valid(metadata)
				AND json_extract(metadata, '$.active_task_kind') = 'projection'
				AND json_extract(metadata, '$.invalidated_at') IS NULL`,
		)
		.get(projectId) as { id: string } | undefined;
	if (!row) throw new Error("expected one live rendered task-list projection row");
	return row.id;
}

describe("current vs done: serving a finished task", () => {
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

	function setup(): { store: MemoryStore; sqlite: TestDb["sqlite"]; retriever: MemoryRetriever } {
		testDb = createTestDb();
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder });
		// Scoring knobs off so membership is decided by the lifecycle filter under test
		// and not by a rerank or a recency term.
		const retriever = createRetriever(store, embedder, undefined, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			minScore: 0,
			hardMinScore: 0,
			temporalDecay: false,
			recencyWeight: 0,
		});
		return { store, sqlite: testDb.sqlite, retriever };
	}

	function prepareWrite(
		target: MemoryStore,
		sqlite: TestDb["sqlite"],
		assertionDraft: TaskLifecycleAssertionDraft,
		options: { judgment?: Parameters<typeof resolveTaskLifecycle>[0]["judgment"] } = {},
	): TaskLifecycleWriteInput {
		const ordinal = sequence++;
		const source = {
			kind: "authorized_untraced" as const,
			sessionKey: `current-vs-done-session-${ordinal}`,
			replayIdentity: `current-vs-done-assertion-${ordinal}`,
			assertionOrdinal: ordinal,
		};
		const commandClaim = buildTaskLifecycleCommandClaim({ assertion: assertionDraft, source });
		const at = firstAt + ordinal * 1_000;
		const admission = admitTaskLifecycleAssertion(target, {
			assertion: assertionDraft,
			source,
			commandClaim,
			sessionTime: new Date(at).toISOString(),
			firstResolutionNowMs: at,
		});
		const instances = readSnapshots(sqlite, assertionDraft.projectId);
		const judgment = options.judgment ?? { status: "absent" as const };
		const versionedJudgment =
			judgment.status === "completed"
				? {
						...judgment,
						candidateSetVersion: taskLifecycleCandidateSetVersion(
							buildTaskLifecycleCandidateSet(admission.assertion, instances),
						),
					}
				: judgment;
		return {
			admission,
			commandClaim,
			resolution: resolveTaskLifecycle({
				assertion: admission.assertion,
				instances,
				judgment: versionedJudgment,
			}),
		};
	}

	it("serves the live copy of a task and never its finished copy, while history keeps both", async () => {
		const target = setup();
		const description =
			"Schedule the medical appointments for the Okonkwo-Vance reconciliation programme";
		const opened = await target.store.applyTaskLifecycleResolution(
			prepareWrite(
				target.store,
				target.sqlite,
				draft(description, { occurrenceAnchors: { explicitOccurrenceId: "medical-2033-q1" } }),
			),
		);
		const terminal = await target.store.applyTaskLifecycleResolution(
			prepareWrite(
				target.store,
				target.sqlite,
				draft(description, {
					action: "complete",
					occurrenceAnchors: { explicitOccurrenceId: "medical-2033-q1" },
				}),
				{
					judgment: {
						status: "completed",
						value: { result: "same_instance", activeTaskId: opened.activeTaskId },
					},
				},
			),
		);
		expect(terminal.result).toBe("completed");
		// The same task, opened again for the next quarter: an active and a terminal
		// copy of one task, both live in the store, neither superseded.
		const reopened = await target.store.applyTaskLifecycleResolution(
			prepareWrite(
				target.store,
				target.sqlite,
				draft(description, { occurrenceAnchors: { explicitOccurrenceId: "medical-2033-q2" } }),
			),
		);
		expect(reopened.result).toBe("created_instance");

		const byStatus = carrierIdsByStatus(target.sqlite);
		const activeIds = byStatus.get("active") ?? [];
		const completedIds = byStatus.get("completed") ?? [];
		expect(activeIds).toHaveLength(1);
		expect(completedIds).toHaveLength(1);
		const activeCarrierId = activeIds[0] as string;
		const completedCarrierId = completedIds[0] as string;

		const query = "What medical appointment tasks do I still have to do?";
		const call = { query, limit: 25, scopeFilter: [projectId], nowMs };

		// CONTROL — the pre-change route. `retriever.retrieve` is what every serving
		// caller used before PRD 230 and it carries no lifecycle field, so this is the
		// behaviour the change replaces: the finished copy is served as a live row.
		const beforeIds = (
			await target.retriever.retrieve({
				query,
				limit: 25,
				scopeFilter: [projectId],
				source: "manual",
				allowAggregation: true,
				excludeInvalidatedBefore: nowMs,
			})
		).map((result) => result.entry.id);
		expect(beforeIds).toContain(activeCarrierId);
		expect(beforeIds).toContain(completedCarrierId);

		// DEFAULT ROUTE — the recall tool's own entrypoint.
		const defaultIds = (await retrieveForMemoryRecallOrEval(target.retriever, call)).map(
			(result) => result.entry.id,
		);
		expect(defaultIds).toContain(activeCarrierId);
		expect(defaultIds).not.toContain(completedCarrierId);
		// "Zero terminal rows in any form": not one live terminal carrier survives,
		// however it was scored or labelled.
		const terminalIds = [...(byStatus.get("completed") ?? []), ...(byStatus.get("removed") ?? [])];
		expect(defaultIds.filter((id) => terminalIds.includes(id))).toEqual([]);

		// The automatic route reaches the same conclusion through the other builder.
		const autoIds = (await retrieveForAutoRecall(target.retriever, call)).map(
			(result) => result.entry.id,
		);
		expect(autoIds).not.toContain(completedCarrierId);

		// HISTORY ROUTE — `include_history` on the recall tool. Nothing became
		// unreachable: the finished copy comes back exactly as the control served it.
		const historyIds = (
			await retrieveForMemoryRecallOrEval(target.retriever, {
				...call,
				facetPolicy: "include-history",
			})
		).map((result) => result.entry.id);
		expect(historyIds).toContain(completedCarrierId);
		expect(historyIds).toContain(activeCarrierId);
	});

	it("reaches only per-task carriers: projection, narrative and malformed rows stay served", async () => {
		const target = setup();
		const shared = "quarterly reconciliation programme";
		const openTask = await target.store.applyTaskLifecycleResolution(
			prepareWrite(target.store, target.sqlite, draft(`Draft the ${shared} onboarding packet`)),
		);
		expect(openTask.result).toBe("created_instance");

		const doneDescription = `File the ${shared} client assessment report`;
		const done = await target.store.applyTaskLifecycleResolution(
			prepareWrite(target.store, target.sqlite, draft(doneDescription)),
		);
		await target.store.applyTaskLifecycleResolution(
			prepareWrite(target.store, target.sqlite, draft(doneDescription, { action: "complete" }), {
				judgment: {
					status: "completed",
					value: { result: "same_instance", activeTaskId: done.activeTaskId },
				},
			}),
		);
		const droppedDescription = `Book the ${shared} offsite conference room`;
		const dropped = await target.store.applyTaskLifecycleResolution(
			prepareWrite(target.store, target.sqlite, draft(droppedDescription)),
		);
		await target.store.applyTaskLifecycleResolution(
			prepareWrite(target.store, target.sqlite, draft(droppedDescription, { action: "remove" }), {
				judgment: {
					status: "completed",
					value: { result: "same_instance", activeTaskId: dropped.activeTaskId },
				},
			}),
		);

		// A narrative row the writer never stamped: DEC-1 says treat it as live.
		const narrative = await target.store.store({
			text: `Completed task: file the ${shared} client assessment report last Friday`,
			category: "episodic",
			projectId,
			timestamp: firstAt + 500,
		});
		// A row whose metadata column cannot be parsed at all. The store predicate's
		// first arm has to keep it, or one corrupt row disappears from recall.
		const malformed = await target.store.store({
			text: `Notes from the ${shared} steering call about scheduling`,
			category: "episodic",
			projectId,
			timestamp: firstAt + 600,
		});
		target.sqlite
			.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
			.run("{not json at all", malformed.id);

		const byStatus = carrierIdsByStatus(target.sqlite);
		const activeCarrierId = (byStatus.get("active") ?? [])[0] as string;
		const completedCarrierId = (byStatus.get("completed") ?? [])[0] as string;
		const removedCarrierId = (byStatus.get("removed") ?? [])[0] as string;
		expect(activeCarrierId).toBeTypeOf("string");
		expect(completedCarrierId).toBeTypeOf("string");
		expect(removedCarrierId).toBeTypeOf("string");
		const projectionId = liveProjectionId(target.sqlite);

		const servedIds = (
			await retrieveForMemoryRecallOrEval(target.retriever, {
				query: `What ${shared} tasks are left for me to do?`,
				limit: 50,
				scopeFilter: [projectId],
				nowMs,
			})
		).map((result) => result.entry.id);

		// Both terminal states are gone; nothing else the switch could reach is.
		expect(servedIds).not.toContain(completedCarrierId);
		expect(servedIds).not.toContain(removedCarrierId);
		expect(servedIds).toContain(activeCarrierId);
		expect(servedIds).toContain(narrative.id);
		expect(servedIds).toContain(malformed.id);
		expect(servedIds).toContain(projectionId);

		// The explicit population filters still reach terminal carriers, so the rows
		// are excluded from serving, not made unreachable. `taskCarrierPopulation`
		// is implemented on the aggregation route only, so that is where it is asked.
		const terminalHitIds = (
			await target.store.searchAggregationEvidence({
				projectIdFilter: [projectId],
				category: "profile",
				taskCarrierPopulation: "terminal",
				limit: 20,
			})
		).map((result) => result.entry.id);
		expect(terminalHitIds).toContain(completedCarrierId);
		expect(terminalHitIds).toContain(removedCarrierId);
		expect(terminalHitIds).not.toContain(activeCarrierId);
	});
});
