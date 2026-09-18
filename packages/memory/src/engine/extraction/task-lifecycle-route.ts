/** @file task-lifecycle-route.ts
 * @purpose Routes one typed task assertion through admission, bounded judgment, and atomic storage.
 * @boundary The only production task mutation ingress; models may select only an admitted identifier.
 */

import { dirname } from "node:path";

import { SnoStationMemError } from "../shared/errors";
import { z } from "zod";
import {
	admitTaskLifecycleAssertion,
	buildTaskLifecycleCommandClaim,
	resolveTaskLifecycleEffectiveTime,
	type TaskLifecycleAssertion,
	type TaskLifecycleAssertionDraft,
	type TaskLifecycleCommandSource,
	type TaskLifecycleTimeSource,
} from "./task-lifecycle-assertion";
import {
	buildTaskLifecycleCandidateSet,
	findUniqueActiveTaskByDescription,
	resolveTaskLifecycle,
	taskLifecycleCandidateSetVersion,
	type TaskLifecycleInstanceSnapshot,
	type TaskLifecycleJudgmentAttempt,
	type TaskLifecycleResolution,
} from "./task-lifecycle-resolver";
import { TASK_LIFECYCLE_JUDGMENT_SKILL } from "./task-lifecycle-judgment-skill";
import { type LlmClient, LlmClientTerminalError } from "../../model/llm-client";
import {
	type MutationAttemptCompletion,
	runWithMutationAttempt,
} from "../operations/runtime-audit-log";
import {
	type MemoryStore,
	type TaskLifecycleWriteInput,
	TaskLifecycleStaleResolutionError,
	type TaskLifecycleWriteResult,
} from "../../store/store";

export interface TaskLifecycleRouteInput {
	assertion: TaskLifecycleAssertionDraft;
	source: TaskLifecycleCommandSource;
	eventAt?: unknown;
	sessionTime?: unknown;
	firstResolutionNowMs: number;
	store: MemoryStore;
	llm?: LlmClient;
	timeoutMs?: number;
	signal?: AbortSignal;
	precomputedJudgment?: TaskLifecycleJudgmentAttempt;
	precomputedInstances?: readonly TaskLifecycleInstanceSnapshot[];
}

export interface TaskLifecycleRouteResult {
	resolution: TaskLifecycleResolution | null;
	write: TaskLifecycleWriteResult;
	effectiveAtMs: number;
	timeSource: TaskLifecycleTimeSource;
	conflictRetries: number;
}

export interface DeterministicTaskLifecycleWriteInput {
	assertion: TaskLifecycleAssertionDraft;
	source: TaskLifecycleCommandSource;
	firstResolutionNowMs: number;
	store: MemoryStore;
	todoProvenance: NonNullable<TaskLifecycleWriteInput["todoProvenance"]>;
}

export interface TaskLifecycleCandidateRouteInput {
	projectId: string;
	candidateText: string;
	confirmedTaskCandidate: boolean;
	source: TaskLifecycleCommandSource;
	eventAt?: unknown;
	sessionTime?: unknown;
	firstResolutionNowMs: number;
	store: MemoryStore;
	llm?: LlmClient;
	timeoutMs?: number;
	signal?: AbortSignal;
	occurrenceAnchors?: TaskLifecycleAssertionDraft["occurrenceAnchors"];
	revisionDetails?: TaskLifecycleAssertionDraft["revisionDetails"];
	evidenceMemoryId?: string;
}

export type TaskLifecycleCandidateRouteResult =
	| { status: "none" }
	| { status: "routed"; result: TaskLifecycleRouteResult };

export class TaskLifecycleJudgmentUnavailableError extends SnoStationMemError {
	// Extends SnoStationMemError so the tool boundary reports why the write stopped. As a bare
	// Error it normalized to "unknown_error" and the caller lost the reason entirely.
	constructor(message: string) {
		super("task_lifecycle_judgment_unavailable", message);
		this.name = "TaskLifecycleJudgmentUnavailableError";
	}
}

export function prepareDeterministicTaskLifecycleWrite(
	input: DeterministicTaskLifecycleWriteInput,
): TaskLifecycleWriteInput {
	const commandClaim = buildTaskLifecycleCommandClaim({
		assertion: input.assertion,
		source: input.source,
	});
	const admission = admitTaskLifecycleAssertion(input.store, {
		assertion: input.assertion,
		source: input.source,
		commandClaim,
		firstResolutionNowMs: input.firstResolutionNowMs,
	});
	const instances = input.store.readTaskLifecycleInstances(admission.assertion.projectId);
	const candidates = buildTaskLifecycleCandidateSet(admission.assertion, instances);
	const exact = findUniqueActiveTaskByDescription(admission.assertion.description, instances);
	const judgment: TaskLifecycleJudgmentAttempt =
		exact === undefined
			? admission.assertion.action === "open_or_refine"
				? {
						status: "completed",
						value: { result: "distinct_instance" },
						candidateSetVersion: taskLifecycleCandidateSetVersion(candidates),
					}
				: {
						status: "completed",
						value: { result: "none" },
						candidateSetVersion: taskLifecycleCandidateSetVersion(candidates),
					}
			: {
					status: "completed",
					value: { result: "same_instance", activeTaskId: exact.activeTaskId },
					candidateSetVersion: taskLifecycleCandidateSetVersion(candidates),
				};
	return {
		admission,
		commandClaim,
		resolution: resolveTaskLifecycle({ assertion: admission.assertion, instances, judgment }),
		todoProvenance: input.todoProvenance,
	};
}

const TASK_LIFECYCLE_MODEL_ACTIONS = [
	"open_or_refine",
	"complete",
	"remove",
	"none",
] as const;
type TaskLifecycleModelAction = (typeof TASK_LIFECYCLE_MODEL_ACTIONS)[number];

const taskLifecycleModelVerdictSchema = z
	.object({
		action: z.enum(TASK_LIFECYCLE_MODEL_ACTIONS),
		taskId: z.string().min(1).nullable(),
	})
	.strict();

interface TaskLifecycleModelVerdict {
	action: TaskLifecycleModelAction;
	taskId: string | null;
}

function isTerminalTaskLifecycleLlmError(error: unknown): error is LlmClientTerminalError {
	return (
		error instanceof LlmClientTerminalError &&
		((error.category === "cancelled" && !error.requestTimedOut) || error.category === "auth")
	);
}

async function requestTaskLifecycleJson(input: {
	prompt: string;
	llm: LlmClient;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<unknown> {
	return input.llm.completeJson<unknown>({
		prompt: input.prompt,
		callLabel: "profile-active-task-classify",
		adapterSlot: "profile-merge",
		...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
		...(input.signal === undefined ? {} : { signal: input.signal }),
		// Walk every candidate against this reply's own shape; without it the first valid object
		// wins and the correct payload behind it is never seen.
		accept: (value) => taskLifecycleModelVerdictSchema.safeParse(value).success,
	});
}

async function requestModelJudgment(input: {
	candidateText: string;
	allowedActions: readonly TaskLifecycleModelAction[];
	candidates: ReturnType<typeof buildTaskLifecycleCandidateSet>;
	llm?: LlmClient;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<TaskLifecycleModelVerdict> {
	if (!input.llm) {
		throw new TaskLifecycleJudgmentUnavailableError(
			"task lifecycle judgment requires an available model route",
		);
	}
	let value: unknown;
	try {
		value = await requestTaskLifecycleJson({
			llm: input.llm,
			prompt: [
				TASK_LIFECYCLE_JUDGMENT_SKILL.activeTaskState,
				'Return exactly one JSON object: {"action":"open_or_refine|complete|remove|none","taskId":"presented-id-or-null"}.',
				"For complete or remove, taskId must be one identifier from Active tasks.",
				"For open_or_refine, taskId is an existing task to refine or null for a distinct task.",
				"For none, taskId must be null.",
				`Allowed actions: ${JSON.stringify(input.allowedActions)}`,
				`Candidate: ${JSON.stringify(input.candidateText)}`,
				`Active tasks: ${JSON.stringify(input.candidates)}`,
			].join("\n"),
			...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
	} catch (error) {
		if (isTerminalTaskLifecycleLlmError(error)) throw error;
		throw new TaskLifecycleJudgmentUnavailableError(
			`task lifecycle judgment failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const parsed = taskLifecycleModelVerdictSchema.safeParse(value);
	if (!parsed.success) {
		throw new TaskLifecycleJudgmentUnavailableError(
			"task lifecycle judgment returned an invalid shape",
		);
	}
	const verdict = parsed.data;
	if (!input.allowedActions.includes(verdict.action)) {
		throw new TaskLifecycleJudgmentUnavailableError(
			"task lifecycle judgment returned an action outside the admitted enum",
		);
	}
	if (verdict.action === "none") {
		if (verdict.taskId !== null) {
			throw new TaskLifecycleJudgmentUnavailableError(
				"task lifecycle none verdict returned an active task identifier",
			);
		}
		return verdict;
	}
	if (verdict.action !== "open_or_refine" && verdict.taskId === null) {
		throw new TaskLifecycleJudgmentUnavailableError(
			"task lifecycle terminal verdict omitted the active task identifier",
		);
	}
	if (
		verdict.taskId !== null &&
		!input.candidates.some(
			(candidate) => candidate.activeTaskId === verdict.taskId,
		)
	) {
		throw new TaskLifecycleJudgmentUnavailableError(
			"task lifecycle judgment selected an identifier outside the presented set",
		);
	}
	return verdict;
}

function provisionalAssertion(
	input: TaskLifecycleCandidateRouteInput,
): TaskLifecycleAssertion {
	const effectiveTime = resolveTaskLifecycleEffectiveTime(input);
	return {
		kind: "task_lifecycle",
		action: "open_or_refine",
		commandId: "0".repeat(64),
		projectId: input.projectId,
		subject: "user",
		description: input.candidateText,
		effectiveAtMs: effectiveTime.effectiveAtMs,
		timeSource: effectiveTime.timeSource,
		occurrenceAnchors: input.occurrenceAnchors ?? {},
		revisionDetails: input.revisionDetails ?? {},
		...(input.evidenceMemoryId === undefined
			? {}
			: { evidenceMemoryId: input.evidenceMemoryId }),
	};
}

function readCurrentOpenTaskInstances(store: MemoryStore, projectId: string) {
	return store
		.readTaskLifecycleInstances(projectId)
		.filter((instance) => instance.terminalAtMs === undefined);
}

async function routeTaskLifecycleCandidateOnce(
	input: TaskLifecycleCandidateRouteInput,
): Promise<TaskLifecycleCandidateRouteResult> {
	const candidateText = input.candidateText.trim();
	if (!candidateText) {
		throw new TaskLifecycleJudgmentUnavailableError(
			"task lifecycle judgment requires non-empty candidate text",
		);
	}
	const provisional = provisionalAssertion({ ...input, candidateText });
	let candidateInstances = readCurrentOpenTaskInstances(input.store, input.projectId);
	let candidates = buildTaskLifecycleCandidateSet(provisional, candidateInstances);
	if (!input.confirmedTaskCandidate && candidates.length === 0) {
		return { status: "none" };
	}
	const allowedActions = input.confirmedTaskCandidate
		? TASK_LIFECYCLE_MODEL_ACTIONS
		: (["complete", "remove", "none"] as const);
	let conflictRetries = 0;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const judgedCandidateSetVersion = taskLifecycleCandidateSetVersion(candidates);
		const verdict = await requestModelJudgment({
			candidateText,
			allowedActions,
			candidates,
			...(input.llm === undefined ? {} : { llm: input.llm }),
			...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});

		const currentInstances = readCurrentOpenTaskInstances(input.store, input.projectId);
		const currentCandidates = buildTaskLifecycleCandidateSet(provisional, currentInstances);
		if (taskLifecycleCandidateSetVersion(currentCandidates) !== judgedCandidateSetVersion) {
			conflictRetries += 1;
			candidateInstances = currentInstances;
			candidates = currentCandidates;
			continue;
		}
		if (verdict.action === "none") return { status: "none" };
		const selected =
			verdict.taskId === null
				? undefined
				: candidates.find((candidate) => candidate.activeTaskId === verdict.taskId);
		const assertion: TaskLifecycleAssertionDraft = {
			kind: "task_lifecycle",
			action: verdict.action,
			projectId: input.projectId,
			subject: "user",
			description:
				verdict.action === "open_or_refine"
					? candidateText
					: (selected?.currentDescription ?? candidateText),
			occurrenceAnchors: input.occurrenceAnchors ?? {},
			revisionDetails: input.revisionDetails ?? {},
			...(input.evidenceMemoryId === undefined
				? {}
				: { evidenceMemoryId: input.evidenceMemoryId }),
		};
		const finalCandidateSetVersion = taskLifecycleCandidateSetVersion(
			buildTaskLifecycleCandidateSet(
				{
					...provisional,
					action: verdict.action,
					description: assertion.description,
				},
				candidateInstances,
			),
		);
		const precomputedJudgment: TaskLifecycleJudgmentAttempt =
			verdict.taskId === null
				? {
						status: "completed",
						value: { result: "distinct_instance" },
						candidateSetVersion: finalCandidateSetVersion,
					}
				: {
						status: "completed",
						value: {
							result: "same_instance",
							activeTaskId: verdict.taskId,
						},
						candidateSetVersion: finalCandidateSetVersion,
					};
		try {
			const result = await routeTaskLifecycleAssertion({
				assertion,
				source: input.source,
				eventAt: input.eventAt,
				sessionTime: input.sessionTime,
				firstResolutionNowMs: input.firstResolutionNowMs,
				store: input.store,
				...(input.llm === undefined ? {} : { llm: input.llm }),
				...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
				...(input.signal === undefined ? {} : { signal: input.signal }),
				precomputedJudgment,
				precomputedInstances: candidateInstances,
			});
			return { status: "routed", result: { ...result, conflictRetries } };
		} catch (error) {
			if (!(error instanceof TaskLifecycleStaleResolutionError)) throw error;
			conflictRetries += 1;
			candidateInstances = readCurrentOpenTaskInstances(input.store, input.projectId);
			candidates = buildTaskLifecycleCandidateSet(provisional, candidateInstances);
		}
	}
	throw new TaskLifecycleJudgmentUnavailableError(
		"task lifecycle open-task set remained stale after three fresh judgments",
	);
}

function taskLifecycleMutationOutcome(
	result: TaskLifecycleCandidateRouteResult,
): MutationAttemptCompletion {
	if (result.status === "none" || result.result.write.replayed) {
		return { outcome: "no-mutation" };
	}
	if (result.result.write.result === "uncertain") {
		return {
			outcome: "preserved-without-adjudication",
			refusalReason: "task_lifecycle_judgment_uncertain",
		};
	}
	if (result.result.write.result === "none") return { outcome: "no-mutation" };
	return { outcome: "committed" };
}

export async function routeTaskLifecycleCandidate(
	input: TaskLifecycleCandidateRouteInput,
): Promise<TaskLifecycleCandidateRouteResult> {
	return runWithMutationAttempt({
		stateDir: dirname(input.store.dbPath),
		event: "memory_updated",
		operation: "task-lifecycle-update",
		writer: "task-lifecycle",
		subject: "active_tasks",
		run: () => routeTaskLifecycleCandidateOnce(input),
		completedOutcome: taskLifecycleMutationOutcome,
		failedOutcome: (error) =>
			error instanceof TaskLifecycleJudgmentUnavailableError
				? {
						outcome: "preserved-without-adjudication",
						refusalReason: error.message,
					}
				: { outcome: "failed" },
	});
}

async function requestJudgment(
	input: TaskLifecycleRouteInput,
	assertion: ReturnType<typeof admitTaskLifecycleAssertion>["assertion"],
): Promise<TaskLifecycleJudgmentAttempt> {
	if (!input.llm) return { status: "absent" };
	const candidates = buildTaskLifecycleCandidateSet(
		assertion,
		readCurrentOpenTaskInstances(input.store, assertion.projectId),
	);
	if (candidates.length === 0) return { status: "absent" };
	try {
		const value = await requestTaskLifecycleJson({
			llm: input.llm,
			prompt: [
				TASK_LIFECYCLE_JUDGMENT_SKILL.existingTaskRelation,
				'Return exactly one JSON object: {"result":"same_instance","activeTaskId":"..."} or {"result":"distinct_instance"} or {"result":"none"} or {"result":"uncertain"}.',
				"Select same_instance only with an activeTaskId from candidates.",
				`Assertion: ${JSON.stringify(assertion)}`,
				`Candidates: ${JSON.stringify(candidates)}`,
			].join("\n"),
			...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		return value === null
			? { status: "absent" }
			: {
					status: "completed",
					value,
					candidateSetVersion: taskLifecycleCandidateSetVersion(candidates),
				};
	} catch (error) {
		if (
			error instanceof LlmClientTerminalError &&
			(error.category === "timeout" || error.requestTimedOut)
		) {
			return { status: "timeout" };
		}
		throw error;
	}
}

export async function routeTaskLifecycleAssertion(
	input: TaskLifecycleRouteInput,
): Promise<TaskLifecycleRouteResult> {
	const commandClaim = buildTaskLifecycleCommandClaim({
		assertion: input.assertion,
		source: input.source,
	});
	const admission = admitTaskLifecycleAssertion(input.store, {
		assertion: input.assertion,
		source: input.source,
		commandClaim,
		...(input.eventAt === undefined ? {} : { eventAt: input.eventAt }),
		...(input.sessionTime === undefined ? {} : { sessionTime: input.sessionTime }),
		firstResolutionNowMs: input.firstResolutionNowMs,
	});
	const replay = input.store.findTaskLifecycleCommandReplay({
		admission,
		commandClaim,
	});
	if (replay) {
		return {
			resolution: null,
			write: replay,
			effectiveAtMs: admission.assertion.effectiveAtMs,
			timeSource: admission.assertion.timeSource,
			conflictRetries: 0,
		};
	}
	const instances =
		input.precomputedInstances ??
		input.store.readTaskLifecycleInstances(admission.assertion.projectId);
	const deterministic = resolveTaskLifecycle({
		assertion: admission.assertion,
		instances,
		judgment: { status: "absent" },
	});
	const resolution =
		input.precomputedJudgment !== undefined
			? resolveTaskLifecycle({
					assertion: admission.assertion,
					instances,
					judgment: input.precomputedJudgment,
				})
			: deterministic.result !== "uncertain"
			? deterministic
			: resolveTaskLifecycle({
					assertion: admission.assertion,
					instances,
					judgment: await requestJudgment(input, admission.assertion),
				});
	const write = await input.store.applyTaskLifecycleResolution({
		admission,
		commandClaim,
		resolution,
	});
	return {
		resolution,
		write,
		effectiveAtMs: admission.assertion.effectiveAtMs,
		timeSource: admission.assertion.timeSource,
		conflictRetries: 0,
	};
}
