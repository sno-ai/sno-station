import {
	routeTaskLifecycleAssertion,
	type TaskLifecycleRouteResult,
} from "../../../../packages/memory/src/engine/extraction/task-lifecycle-route.ts";
import type { TaskLifecycleAssertionDraft } from "../../../../packages/memory/src/engine/extraction/task-lifecycle-assertion.ts";
import {
	buildTaskLifecycleCandidateSet,
	taskLifecycleCandidateSetVersion,
} from "../../../../packages/memory/src/engine/extraction/task-lifecycle-resolver.ts";
import type { MemoryStore } from "../../../../packages/memory/src/store/store.ts";

export async function routeTestTask(args: {
	store: MemoryStore;
	projectId: string;
	action: TaskLifecycleAssertionDraft["action"];
	description: string;
	replayIdentity: string;
	at: number;
	sessionKey?: string;
	occurrenceId?: string;
	date?: string;
}): Promise<TaskLifecycleRouteResult> {
	const assertion: TaskLifecycleAssertionDraft = {
		kind: "task_lifecycle",
		action: args.action,
		projectId: args.projectId,
		subject: "user",
		description: args.description,
		occurrenceAnchors: {
			...(args.occurrenceId === undefined
				? {}
				: { explicitOccurrenceId: args.occurrenceId }),
			...(args.date === undefined ? {} : { date: args.date }),
		},
		revisionDetails: {},
	};
	const candidates = buildTaskLifecycleCandidateSet(
		{
			...assertion,
			commandId: "0".repeat(64),
			effectiveAtMs: args.at,
			timeSource: "first_resolution",
		},
		args.store.readTaskLifecycleInstances(args.projectId),
	);
	const terminalTarget = args.action === "open_or_refine" ? undefined : candidates[0];
	return routeTaskLifecycleAssertion({
		assertion,
		source: {
			kind: "authorized_untraced",
			sessionKey: args.sessionKey ?? args.projectId,
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
