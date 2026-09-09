/** @file memory-store-task-lifecycle-api.ts
 * @purpose Atomically persists resolved task lifecycle commands and their dedicated to-do row.
 * @boundary Consumes admitted assertions and resolver output; performs no relation judgment.
 */

import {
	allocateActiveTaskId,
	allocateActiveTaskRevisionId,
} from "../engine/extraction/task-lifecycle-assertion";
import {
	applyTaskLifecycleRevisionPatch,
	buildTaskLifecycleCandidateSet,
	taskLifecycleCandidateSetVersion,
	type TaskLifecycleCanonicalRevisionDetails,
	type TaskLifecycleInstanceSnapshot,
	type TaskLifecycleRelationCandidate,
} from "../engine/extraction/task-lifecycle-resolver";
import {
	MemoryStore,
	type MemoryStoreInternals,
	type TaskLifecycleBatchWriteInput,
	type TaskLifecycleBatchWriteResult,
	type TaskLifecycleCommandReplayInput,
	TaskLifecycleCommandCollisionError,
	TaskLifecycleStateCollisionError,
	TaskLifecycleStaleResolutionError,
	type TaskLifecycleWriteInput,
	type TaskLifecycleWriteOutcome,
	type TaskLifecycleWriteResult,
} from "./memory-store-base";
import {
	commitPreparedAtomicExtractionWrite,
	prepareAtomicExtractionWrite,
} from "./memory-store-atomic-extraction-write-api";
import { StorageError } from "./memory-store-shared";

interface PersistedCommandRow {
	canonicalTupleJson: string | null;
	identityJson: string;
	action: string;
	sourceAssertionJson: string;
	effectiveAtMs: number;
	timeSource: string;
	result: TaskLifecycleWriteOutcome;
	activeTaskId: string | null;
	activeTaskRevisionId: string | null;
}

interface PersistedInstanceRow {
	activeTaskId: string;
	canonicalTupleJson: string;
	identityState: "normal" | "unresolved";
	status: "active" | "completed" | "removed";
	createdAtMs: number;
	terminalAtMs: number | null;
}

interface PersistedRevisionRow {
	activeTaskRevisionId: string;
	canonicalTupleJson: string;
	description: string;
	occurrenceAnchorsJson: string;
	revisionDetailsJson: string;
	createdAtMs: number;
	isCurrent: number;
}

type LifecycleWritePlan =
	| {
			kind: "create";
			result: "created_instance" | "created_unresolved_instance";
			activeTaskId: string;
			activeTaskRevisionId: string;
			identityState: "normal" | "unresolved";
			revisionDetails: TaskLifecycleCanonicalRevisionDetails;
	  }
	| {
			kind: "refine";
			result: "refined";
			activeTaskId: string;
			activeTaskRevisionId: string;
			previousRevisionId: string;
			description: string;
			occurrenceAnchorsJson: string;
			revisionDetails: TaskLifecycleCanonicalRevisionDetails;
			makeCurrent: boolean;
	  }
	| {
			kind: "evidence";
			result: "evidence_only" | "terminal_evidence_only";
			activeTaskId: string;
	  }
	| {
			kind: "terminal";
			result: "completed" | "removed";
			activeTaskId: string;
			toStatus: "completed" | "removed";
	  }
	| {
			kind: "unmatched";
			result: "none" | "uncertain";
	  };

function commandTupleJson(input: TaskLifecycleCommandReplayInput): string | null {
	return input.commandClaim.canonicalTuple === undefined
		? null
		: JSON.stringify(input.commandClaim.canonicalTuple);
}

function commandProvenance(input: TaskLifecycleWriteInput): {
	sourceSession: string;
	extractionPath: string;
	closeReason: string;
} {
	if (input.todoProvenance !== undefined) {
		const { sourceSession, extractionPath, closeReason } = input.todoProvenance;
		if (!sourceSession.trim() || !extractionPath.trim()) {
			throw new StorageError("Task lifecycle to-do provenance must not be empty");
		}
		return {
			sourceSession,
			extractionPath,
			closeReason: closeReason?.trim() || input.admission.assertion.commandId,
		};
	}
	const parsed = JSON.parse(input.commandClaim.identityJson) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new StorageError("Task lifecycle command identity is not an object");
	}
	const identity = parsed as Record<string, unknown>;
	const kind = identity.kind;
	if (kind === "authorized_untraced") {
		const tuple = identity.canonicalTuple;
		if (!Array.isArray(tuple) || typeof tuple[2] !== "string" || typeof tuple[3] !== "string") {
			throw new StorageError("Authorized task lifecycle command lacks source identity");
		}
		return {
			sourceSession: tuple[2],
			extractionPath: kind,
			closeReason: tuple[3],
		};
	}
	if (kind === "extraction_trace" && typeof identity.sessionKey === "string") {
		const candidate = identity.candidate;
		const candidateText =
			typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
				? (candidate as Record<string, unknown>).content
				: undefined;
		return {
			sourceSession: identity.sessionKey,
			extractionPath: kind,
			closeReason:
				typeof candidateText === "string" ? candidateText : input.admission.assertion.commandId,
		};
	}
	throw new StorageError("Task lifecycle command lacks source identity");
}

function readCommand(
	store: MemoryStoreInternals,
	projectId: string,
	commandId: string,
): PersistedCommandRow | undefined {
	return store.sqlite
		.prepare(
			`SELECT
				canonical_tuple_json AS canonicalTupleJson,
				identity_json AS identityJson,
				action,
				source_assertion_json AS sourceAssertionJson,
				effective_at_ms AS effectiveAtMs,
				time_source AS timeSource,
				result,
				active_task_id AS activeTaskId,
				active_task_revision_id AS activeTaskRevisionId
			FROM nodix_task_lifecycle_commands
			WHERE project_id = ? AND command_id = ?`,
		)
		.get(projectId, commandId) as PersistedCommandRow | undefined;
}

function replayResult(
	input: TaskLifecycleCommandReplayInput,
	row: PersistedCommandRow,
): TaskLifecycleWriteResult {
	const { assertion } = input.admission;
	if (
		row.canonicalTupleJson !== commandTupleJson(input) ||
		row.identityJson !== input.commandClaim.identityJson ||
		row.action !== input.commandClaim.action ||
		row.sourceAssertionJson !== input.commandClaim.sourceAssertionJson ||
		row.effectiveAtMs !== assertion.effectiveAtMs ||
		row.timeSource !== assertion.timeSource
	) {
		throw new TaskLifecycleCommandCollisionError(assertion.projectId, assertion.commandId);
	}
	return {
		commandId: assertion.commandId,
		result: row.result,
		activeTaskId: row.activeTaskId,
		activeTaskRevisionId: row.activeTaskRevisionId,
		replayed: true,
	};
}

function validateWriteInput(input: TaskLifecycleWriteInput): void {
	const { assertion } = input.admission;
	if (
		assertion.commandId !== input.commandClaim.commandId ||
		input.admission.commandIdentity.commandId !== input.commandClaim.commandId ||
		input.admission.commandIdentity.identityJson !== input.commandClaim.identityJson ||
		JSON.stringify(input.admission.commandIdentity.canonicalTuple) !==
			JSON.stringify(input.commandClaim.canonicalTuple) ||
		assertion.action !== input.commandClaim.action ||
		input.resolution.action !== assertion.action
	) {
		throw new StorageError("Task lifecycle write input does not match its admitted command");
	}
	if (input.resolution.result === "same_instance") {
		const target = input.resolution.target;
		const matchingCandidates = input.resolution.candidates.filter(
			(candidate) => candidate.activeTaskId === target.activeTaskId,
		);
		if (
			matchingCandidates.length !== 1 ||
			JSON.stringify(matchingCandidates[0]) !== JSON.stringify(target)
		) {
			throw new StorageError("Task lifecycle target is outside the admitted candidate set");
		}
	}
}

function readInstance(
	store: MemoryStoreInternals,
	projectId: string,
	activeTaskId: string,
): PersistedInstanceRow | undefined {
	return store.sqlite
		.prepare(
			`SELECT
				active_task_id AS activeTaskId,
				canonical_tuple_json AS canonicalTupleJson,
				identity_state AS identityState,
				status,
				created_at_ms AS createdAtMs,
				terminal_at_ms AS terminalAtMs
			FROM nodix_active_task_instances
			WHERE project_id = ? AND active_task_id = ?`,
		)
		.get(projectId, activeTaskId) as PersistedInstanceRow | undefined;
}

function readTargetRevision(
	store: MemoryStoreInternals,
	projectId: string,
	activeTaskId: string,
	activeTaskRevisionId: string,
): PersistedRevisionRow | undefined {
	return store.sqlite
		.prepare(
			`SELECT
				active_task_revision_id AS activeTaskRevisionId,
				canonical_tuple_json AS canonicalTupleJson,
				description,
				occurrence_anchors_json AS occurrenceAnchorsJson,
				revision_details_json AS revisionDetailsJson,
				created_at_ms AS createdAtMs,
				is_current AS isCurrent
			FROM nodix_active_task_revisions
			WHERE project_id = ?
				AND active_task_id = ?
				AND active_task_revision_id = ?`,
		)
		.get(projectId, activeTaskId, activeTaskRevisionId) as PersistedRevisionRow | undefined;
}

function assertTargetCurrent(
	store: MemoryStoreInternals,
	projectId: string,
	target: TaskLifecycleRelationCandidate,
): { instance: PersistedInstanceRow; revision: PersistedRevisionRow } {
	const instance = readInstance(store, projectId, target.activeTaskId);
	const revision = readTargetRevision(
		store,
		projectId,
		target.activeTaskId,
		target.currentRevisionId,
	);
	if (!instance || !revision) {
		throw new TaskLifecycleStaleResolutionError(target.activeTaskId);
	}
	if (
		revision.activeTaskRevisionId !== target.currentRevisionId ||
		revision.description !== target.currentDescription ||
		revision.occurrenceAnchorsJson !== JSON.stringify(target.occurrenceAnchors) ||
		revision.revisionDetailsJson !== JSON.stringify(target.revisionDetails)
	) {
		throw new TaskLifecycleStaleResolutionError(target.activeTaskId);
	}
	return { instance, revision };
}

function wasInstanceActiveAt(instance: PersistedInstanceRow, effectiveAtMs: number): boolean {
	return (
		instance.createdAtMs <= effectiveAtMs &&
		(instance.terminalAtMs === null || effectiveAtMs <= instance.terminalAtMs)
	);
}

function planWrite(
	store: MemoryStoreInternals,
	input: TaskLifecycleWriteInput,
): LifecycleWritePlan {
	const { assertion } = input.admission;
	const resolution = input.resolution;
	if (resolution.action === "open_or_refine") {
		if (
			resolution.result !== "uncertain" &&
			resolution.candidateSetVersion !== undefined
		) {
			const currentCandidates = buildTaskLifecycleCandidateSet(
				assertion,
				store
					.readTaskLifecycleInstances(assertion.projectId)
					.filter((instance) => instance.terminalAtMs === undefined),
			);
			if (
				taskLifecycleCandidateSetVersion(currentCandidates) !==
				resolution.candidateSetVersion
			) {
				throw new TaskLifecycleStaleResolutionError(assertion.commandId);
			}
		}
		if (resolution.result === "distinct_instance" || resolution.result === "uncertain") {
			const activeTaskId = allocateActiveTaskId(assertion.projectId, assertion.commandId);
			const existing = readInstance(store, assertion.projectId, activeTaskId);
			const canonicalTupleJson = JSON.stringify([
				"active-task-instance-v1",
				assertion.projectId,
				assertion.commandId,
			]);
			if (existing && existing.canonicalTupleJson !== canonicalTupleJson) {
				throw new TaskLifecycleStateCollisionError(activeTaskId);
			}
			if (existing) throw new TaskLifecycleStateCollisionError(activeTaskId);
			return {
				kind: "create",
				result:
					resolution.result === "uncertain"
						? "created_unresolved_instance"
						: "created_instance",
				activeTaskId,
				activeTaskRevisionId: allocateActiveTaskRevisionId(
					activeTaskId,
					assertion.commandId,
				),
				identityState: resolution.result === "uncertain" ? "unresolved" : "normal",
				revisionDetails: applyTaskLifecycleRevisionPatch({}, assertion.revisionDetails)
					.revisionDetails,
			};
		}
		const current = assertTargetCurrent(store, assertion.projectId, resolution.target);
		const isCurrentlyActive = current.instance.status === "active";
		const wasActiveAtAssertion = wasInstanceActiveAt(
			current.instance,
			assertion.effectiveAtMs,
		);
		if (!wasActiveAtAssertion || (isCurrentlyActive && current.revision.isCurrent !== 1)) {
			throw new TaskLifecycleStaleResolutionError(resolution.target.activeTaskId);
		}
		if (resolution.revisionIntent.kind === "evidence_only") {
			return {
				kind: "evidence",
				result: "evidence_only",
				activeTaskId: resolution.target.activeTaskId,
			};
		}
		return {
			kind: "refine",
			result: "refined",
			activeTaskId: resolution.target.activeTaskId,
			activeTaskRevisionId: allocateActiveTaskRevisionId(
				resolution.target.activeTaskId,
				assertion.commandId,
			),
			previousRevisionId: current.revision.activeTaskRevisionId,
			description: assertion.description,
			occurrenceAnchorsJson: current.revision.occurrenceAnchorsJson,
			revisionDetails: resolution.revisionIntent.revisionDetails,
			makeCurrent: isCurrentlyActive,
		};
	}

	if (resolution.result !== "same_instance") {
		return { kind: "unmatched", result: resolution.result };
	}
	const target = resolution.target;
	const current = assertTargetCurrent(store, assertion.projectId, target);
	if (current.instance.status !== "active") {
		return {
			kind: "evidence",
			result: "terminal_evidence_only",
			activeTaskId: target.activeTaskId,
		};
	}
	const currentCandidates = buildTaskLifecycleCandidateSet(
		assertion,
		store
			.readTaskLifecycleInstances(assertion.projectId)
			.filter((instance) => instance.terminalAtMs === undefined),
	);
	if (
		taskLifecycleCandidateSetVersion(currentCandidates) !==
		resolution.candidateSetVersion
	) {
		throw new TaskLifecycleStaleResolutionError(resolution.target.activeTaskId);
	}
	if (
		current.revision.isCurrent !== 1 ||
		!wasInstanceActiveAt(current.instance, assertion.effectiveAtMs)
	) {
		throw new TaskLifecycleStaleResolutionError(target.activeTaskId);
	}
	return {
		kind: "terminal",
		result: resolution.action === "complete" ? "completed" : "removed",
		activeTaskId: target.activeTaskId,
		toStatus: resolution.action === "complete" ? "completed" : "removed",
	};
}

function readTodoState(store: MemoryStoreInternals, projectId: string): unknown[] {
	return store.sqlite
		.prepare("SELECT * FROM nodix_todos WHERE project_id = ? ORDER BY active_task_id")
		.all(projectId);
}

function stateFingerprint(
	store: MemoryStoreInternals,
	input: TaskLifecycleWriteInput,
	plan: LifecycleWritePlan,
): string {
	return JSON.stringify({
		plan,
		todos: readTodoState(store, input.admission.assertion.projectId),
	});
}

function isConcurrentTerminalEvidence(
	planned: LifecycleWritePlan,
	current: LifecycleWritePlan,
): current is Extract<LifecycleWritePlan, { kind: "evidence" }> {
	return (
		planned.kind === "terminal" &&
		current.kind === "evidence" &&
		current.result === "terminal_evidence_only" &&
		current.activeTaskId === planned.activeTaskId
	);
}


function insertCommand(
	store: MemoryStoreInternals,
	input: TaskLifecycleWriteInput,
	plan: LifecycleWritePlan,
): void {
	const { assertion } = input.admission;
	store.sqlite
		.prepare(
			`INSERT INTO nodix_task_lifecycle_commands(
				project_id, command_id, canonical_tuple_json, identity_json, action,
				source_assertion_json, effective_at_ms, time_source, result,
				active_task_id, active_task_revision_id, diagnostics_json, created_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			assertion.projectId,
			assertion.commandId,
			commandTupleJson(input),
			input.commandClaim.identityJson,
			assertion.action,
			input.commandClaim.sourceAssertionJson,
			assertion.effectiveAtMs,
			assertion.timeSource,
			plan.result,
			plan.kind === "unmatched" ? null : plan.activeTaskId,
			plan.kind === "create" || plan.kind === "refine"
				? plan.activeTaskRevisionId
				: null,
			JSON.stringify(input.resolution),
			assertion.effectiveAtMs,
		);
}

function applyStateMutation(
	store: MemoryStoreInternals,
	input: TaskLifecycleWriteInput,
	plan: LifecycleWritePlan,
): void {
	const { assertion } = input.admission;
	if (plan.kind === "create") {
		const instanceTuple = JSON.stringify([
			"active-task-instance-v1",
			assertion.projectId,
			assertion.commandId,
		]);
		const revisionTuple = JSON.stringify([
			"active-task-revision-v1",
			plan.activeTaskId,
			assertion.commandId,
		]);
		store.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_instances(
					project_id, active_task_id, opening_command_id, canonical_tuple_json,
					identity_state, status, created_at_ms
				) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
			)
			.run(
				assertion.projectId,
				plan.activeTaskId,
				assertion.commandId,
				instanceTuple,
				plan.identityState,
				assertion.effectiveAtMs,
			);
		store.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_revisions(
					project_id, active_task_revision_id, active_task_id, creating_command_id,
					canonical_tuple_json, description, occurrence_anchors_json,
					revision_details_json, created_at_ms, is_current
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
			)
			.run(
				assertion.projectId,
				plan.activeTaskRevisionId,
				plan.activeTaskId,
				assertion.commandId,
				revisionTuple,
				assertion.description,
				JSON.stringify(assertion.occurrenceAnchors),
				JSON.stringify(plan.revisionDetails),
				assertion.effectiveAtMs,
			);
		store.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_transitions(
					project_id, command_id, active_task_id, transition_kind,
					from_status, to_status, effective_at_ms
				) VALUES (?, ?, ?, 'open', NULL, 'active', ?)`,
			)
			.run(
				assertion.projectId,
				assertion.commandId,
				plan.activeTaskId,
				assertion.effectiveAtMs,
			);
		return;
	}
	if (plan.kind === "refine") {
		const revisionTuple = JSON.stringify([
			"active-task-revision-v1",
			plan.activeTaskId,
			assertion.commandId,
		]);
		if (plan.makeCurrent) {
			store.sqlite
				.prepare(
					`UPDATE nodix_active_task_revisions
					SET is_current = 0
					WHERE project_id = ? AND active_task_id = ? AND active_task_revision_id = ?
						AND is_current = 1`,
				)
				.run(assertion.projectId, plan.activeTaskId, plan.previousRevisionId);
		}
		store.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_revisions(
					project_id, active_task_revision_id, active_task_id, creating_command_id,
					canonical_tuple_json, description, occurrence_anchors_json,
					revision_details_json, created_at_ms, is_current
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				assertion.projectId,
				plan.activeTaskRevisionId,
				plan.activeTaskId,
				assertion.commandId,
				revisionTuple,
				plan.description,
				plan.occurrenceAnchorsJson,
				JSON.stringify(plan.revisionDetails),
				assertion.effectiveAtMs,
				Number(plan.makeCurrent),
			);
		store.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_transitions(
					project_id, command_id, active_task_id, transition_kind,
					from_status, to_status, effective_at_ms
				) VALUES (?, ?, ?, 'refine', 'active', 'active', ?)`,
			)
			.run(
				assertion.projectId,
				assertion.commandId,
				plan.activeTaskId,
				assertion.effectiveAtMs,
			);
		return;
	}
	if (plan.kind === "terminal") {
		store.sqlite
			.prepare(
				`UPDATE nodix_active_task_instances
				SET status = ?, terminal_at_ms = ?
				WHERE project_id = ? AND active_task_id = ? AND status = 'active'`,
			)
			.run(
				plan.toStatus,
				assertion.effectiveAtMs,
				assertion.projectId,
				plan.activeTaskId,
			);
		store.sqlite
			.prepare(
				`UPDATE nodix_active_task_revisions
				SET is_current = 0
				WHERE project_id = ? AND active_task_id = ?`,
			)
			.run(assertion.projectId, plan.activeTaskId);
		store.sqlite
			.prepare(
				`INSERT INTO nodix_active_task_transitions(
					project_id, command_id, active_task_id, transition_kind,
					from_status, to_status, effective_at_ms
				) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
			)
			.run(
				assertion.projectId,
				assertion.commandId,
				plan.activeTaskId,
				assertion.action,
				plan.toStatus,
				assertion.effectiveAtMs,
			);
	}
}

function applyTodoMutation(
	store: MemoryStoreInternals,
	input: TaskLifecycleWriteInput,
	plan: LifecycleWritePlan,
): void {
	const { assertion } = input.admission;
	if (plan.kind === "create") {
		const source = commandProvenance(input);
		store.sqlite
			.prepare(
				`INSERT INTO nodix_todos(
					project_id, active_task_id, description, status, opened_at, transitioned_at,
					closed_at, close_reason, source_session, extraction_path
				) VALUES (?, ?, ?, 'open', ?, ?, NULL, NULL, ?, ?)`,
			)
			.run(
				assertion.projectId,
				plan.activeTaskId,
				assertion.description,
				assertion.effectiveAtMs,
				assertion.effectiveAtMs,
				source.sourceSession,
				source.extractionPath,
			);
		return;
	}
	if (plan.kind === "refine" && plan.makeCurrent) {
		const result = store.sqlite
			.prepare(
				`UPDATE nodix_todos SET description = ?
				WHERE project_id = ? AND active_task_id = ? AND status = 'open'`,
			)
			.run(plan.description, assertion.projectId, plan.activeTaskId) as { changes: number };
		if (result.changes !== 1) {
			throw new TaskLifecycleStateCollisionError(
				`${assertion.projectId}/${plan.activeTaskId}/todo-refine`,
			);
		}
		return;
	}
	if (plan.kind === "terminal") {
		const source = commandProvenance(input);
		const result = store.sqlite
			.prepare(
				`UPDATE nodix_todos
				SET status = ?, transitioned_at = ?, closed_at = ?, close_reason = ?
				WHERE project_id = ? AND active_task_id = ? AND status = 'open'`,
			)
			.run(
				plan.toStatus === "completed" ? "done" : "removed",
				assertion.effectiveAtMs,
				assertion.effectiveAtMs,
				source.closeReason,
				assertion.projectId,
				plan.activeTaskId,
			) as { changes: number };
		if (result.changes !== 1) {
			throw new TaskLifecycleStateCollisionError(
				`${assertion.projectId}/${plan.activeTaskId}/todo-terminal`,
			);
		}
	}
}

function insertEvidence(
	store: MemoryStoreInternals,
	input: TaskLifecycleWriteInput,
	plan: LifecycleWritePlan,
): void {
	const { assertion } = input.admission;
	store.sqlite
		.prepare(
			`INSERT INTO nodix_active_task_evidence(
				project_id, command_id, active_task_id, evidence_memory_id,
				source_assertion_json, outcome, diagnostics_json, linked_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			assertion.projectId,
			assertion.commandId,
			plan.kind === "unmatched" ? null : plan.activeTaskId,
			assertion.evidenceMemoryId ?? null,
			input.commandClaim.sourceAssertionJson,
			plan.result,
			JSON.stringify(input.resolution),
			assertion.effectiveAtMs,
		);
}


function resultForPlan(
	input: TaskLifecycleWriteInput,
	plan: LifecycleWritePlan,
): TaskLifecycleWriteResult {
	return {
		commandId: input.admission.assertion.commandId,
		result: plan.result,
		activeTaskId: plan.kind === "unmatched" ? null : plan.activeTaskId,
		activeTaskRevisionId:
			plan.kind === "create" || plan.kind === "refine"
				? plan.activeTaskRevisionId
				: null,
		replayed: false,
	};
}

function commitTaskWriteInTransaction(
	store: MemoryStoreInternals,
	input: TaskLifecycleWriteInput,
): TaskLifecycleWriteResult {
	const { assertion } = input.admission;
	const persisted = readCommand(store, assertion.projectId, assertion.commandId);
	if (persisted) return replayResult(input, persisted);
	const plan = planWrite(store, input);
	insertCommand(store, input, plan);
	applyStateMutation(store, input, plan);
	applyTodoMutation(store, input, plan);
	insertEvidence(store, input, plan);
	return resultForPlan(input, plan);
}

Object.assign(MemoryStore.prototype, {
	findTaskLifecycleCommandReplay(
		this: MemoryStoreInternals,
		input: TaskLifecycleCommandReplayInput,
	): TaskLifecycleWriteResult | undefined {
		const { assertion } = input.admission;
		const persisted = readCommand(this, assertion.projectId, assertion.commandId);
		return persisted ? replayResult(input, persisted) : undefined;
	},

	readTaskLifecycleInstances(
		this: MemoryStoreInternals,
		projectId: string,
	): TaskLifecycleInstanceSnapshot[] {
		const rows = this.sqlite
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
					AND r.active_task_revision_id = (
						SELECT r2.active_task_revision_id
						FROM nodix_active_task_revisions r2
						WHERE r2.project_id = i.project_id
							AND r2.active_task_id = i.active_task_id
						ORDER BY
							r2.is_current DESC,
							r2.created_at_ms DESC,
							r2.active_task_revision_id DESC
						LIMIT 1
					)
				WHERE i.project_id = ?
				ORDER BY i.created_at_ms, i.active_task_id`,
			)
			.all(projectId) as Array<{
				projectId: string;
				activeTaskId: string;
				currentRevisionId: string;
				currentDescription: string;
				occurrenceAnchorsJson: string;
				revisionDetailsJson: string;
				createdAtMs: number;
				terminalAtMs: number | null;
			}>;
		return rows.map((row) => ({
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
		}));
	},

	async applyTaskLifecycleResolution(
		this: MemoryStoreInternals,
		input: TaskLifecycleWriteInput,
	): Promise<TaskLifecycleWriteResult> {
		validateWriteInput(input);
		const atomicFactWrite = input.atomicFactWrite;
		if (
			atomicFactWrite !== undefined &&
			atomicFactWrite.projectId !== input.admission.assertion.projectId
		) {
			throw new StorageError("Task lifecycle and atomic fact writes require the same projectId");
		}
		const preparedAtomicFacts =
			atomicFactWrite === undefined
				? undefined
				: await prepareAtomicExtractionWrite(this, atomicFactWrite);
		return this.writeMutex.runExclusive(async () => {
			const withAtomicFacts = (result: TaskLifecycleWriteResult): TaskLifecycleWriteResult => {
				if (atomicFactWrite === undefined || preparedAtomicFacts === undefined) return result;
				return {
					...result,
					atomicFactWrite: commitPreparedAtomicExtractionWrite(
						this,
						atomicFactWrite,
						preparedAtomicFacts,
					),
				};
			};
			const { assertion } = input.admission;
			const persisted = readCommand(this, assertion.projectId, assertion.commandId);
			if (persisted) return withAtomicFacts(replayResult(input, persisted));

			const plan = planWrite(this, input);
			const fingerprint = stateFingerprint(this, input, plan);
			const transaction = this.sqlite.transaction(() => {
				const concurrentCommand = readCommand(
					this,
					assertion.projectId,
					assertion.commandId,
				);
				if (concurrentCommand) return withAtomicFacts(replayResult(input, concurrentCommand));
				const currentPlan = planWrite(this, input);
				if (isConcurrentTerminalEvidence(plan, currentPlan)) {
					insertCommand(this, input, currentPlan);
					insertEvidence(this, input, currentPlan);
					return withAtomicFacts(resultForPlan(input, currentPlan));
				}
				if (
					JSON.stringify(currentPlan) !== JSON.stringify(plan) ||
					stateFingerprint(this, input, currentPlan) !== fingerprint
				) {
					throw new TaskLifecycleStaleResolutionError(
						currentPlan.kind === "unmatched"
							? assertion.commandId
							: currentPlan.activeTaskId,
					);
				}
				insertCommand(this, input, plan);
				applyStateMutation(this, input, plan);
				applyTodoMutation(this, input, plan);
				insertEvidence(this, input, plan);
				return withAtomicFacts(resultForPlan(input, plan));
			});
			return transaction.immediate() as TaskLifecycleWriteResult;
		});
	},

	async applyTaskLifecycleBatchWithAtomicWrite(
		this: MemoryStoreInternals,
		input: TaskLifecycleBatchWriteInput,
	): Promise<TaskLifecycleBatchWriteResult> {
		if (input.taskWriteFactories.length === 0) {
			throw new StorageError("Task lifecycle batch requires at least one to-do write");
		}
		const preparedAtomicFacts = await prepareAtomicExtractionWrite(this, input.atomicFactWrite);
		return this.writeMutex.runExclusive(() => {
			const transaction = this.sqlite.transaction((): TaskLifecycleBatchWriteResult => {
				const tasks = input.taskWriteFactories.map((createTaskWrite) => {
					const taskWrite = createTaskWrite();
					validateWriteInput(taskWrite);
					if (taskWrite.atomicFactWrite !== undefined) {
						throw new StorageError("Task lifecycle batch owns the atomic fact write");
					}
					if (taskWrite.admission.assertion.projectId !== input.atomicFactWrite.projectId) {
						throw new StorageError(
							"Task lifecycle batch and atomic facts require the same projectId",
						);
					}
					return commitTaskWriteInTransaction(this, taskWrite);
				});
				const atomicFactWrite = commitPreparedAtomicExtractionWrite(
					this,
					input.atomicFactWrite,
					preparedAtomicFacts,
				);
				return { tasks, atomicFactWrite };
			});
			return transaction.immediate() as TaskLifecycleBatchWriteResult;
		});
	},
});
