/** @file task-lifecycle-resolver.ts
 * @purpose Resolves one admitted lifecycle assertion against a bounded instance snapshot.
 * @boundary Pure relation judgment only; no model transport, persistence, or task-state mutation.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	TaskLifecycleAction,
	TaskLifecycleAssertion,
	TaskLifecycleOccurrenceAnchors,
	TaskLifecycleRevisionDetails,
} from "./task-lifecycle-assertion";
import { normalizeForCompare, tokenizeForFts } from "../shared/i18n-text";

const relationCandidateLimit = 25;
const occurrenceAnchorKeys = [
	"date",
	"ordinal",
	"recurrence",
	"explicitOccurrenceId",
] as const satisfies readonly (keyof TaskLifecycleOccurrenceAnchors)[];

export interface TaskLifecycleCanonicalRevisionDetails {
	deadline?: string;
	location?: string;
	participants?: string[];
	deliverable?: string;
	quantity?: string;
	constraints?: string[];
}

export interface TaskLifecycleInstanceSnapshot {
	projectId: string;
	activeTaskId: string;
	currentRevisionId: string;
	currentDescription: string;
	occurrenceAnchors: TaskLifecycleOccurrenceAnchors;
	revisionDetails: TaskLifecycleCanonicalRevisionDetails;
	createdAtMs: number;
	terminalAtMs?: number;
}

export interface TaskLifecycleRelationCandidate {
	activeTaskId: string;
	currentDescription: string;
	occurrenceAnchors: TaskLifecycleOccurrenceAnchors;
	revisionDetails: TaskLifecycleCanonicalRevisionDetails;
	createdAtMs: number;
	currentRevisionId: string;
}

export type TaskLifecycleJudgmentAttempt =
	| { status: "absent" }
	| { status: "timeout" }
	| { status: "completed"; value: unknown; candidateSetVersion?: string };

export type TaskLifecycleRevisionIntent =
	| {
			kind: "evidence_only";
			revisionDetails: TaskLifecycleCanonicalRevisionDetails;
	  }
	| {
			kind: "successor_revision";
			revisionDetails: TaskLifecycleCanonicalRevisionDetails;
	  };

type TaskLifecycleOpenResolution =
	| {
			action: "open_or_refine";
			result: "same_instance";
			target: TaskLifecycleRelationCandidate;
			revisionIntent: TaskLifecycleRevisionIntent;
			candidates: TaskLifecycleRelationCandidate[];
			candidateSetVersion?: string;
	  }
	| {
			action: "open_or_refine";
			result: "distinct_instance";
			candidates: TaskLifecycleRelationCandidate[];
			candidateSetVersion?: string;
	  }
	| {
			action: "open_or_refine";
			result: "uncertain";
			disposition: "visible_unresolved_open";
			candidates: TaskLifecycleRelationCandidate[];
	  };

type TaskLifecycleTerminalResolution =
	| {
			action: "complete" | "remove";
			result: "same_instance";
			target: TaskLifecycleRelationCandidate;
			candidates: TaskLifecycleRelationCandidate[];
			candidateSetVersion: string;
	  }
	| {
			action: "complete" | "remove";
			result: "none" | "uncertain";
			disposition: "no_terminal_mutation";
			candidates: TaskLifecycleRelationCandidate[];
	  };

export type TaskLifecycleResolution =
	| TaskLifecycleOpenResolution
	| TaskLifecycleTerminalResolution;

interface RankedCandidate {
	instance: TaskLifecycleInstanceSnapshot;
	sharedAnchorCount: number;
	exactDescription: boolean;
	tokenOverlapScore: number;
}

const judgmentSchema = z.discriminatedUnion("result", [
	z
		.object({
			result: z.literal("same_instance"),
			activeTaskId: z.string().min(1),
		})
		.strict(),
	z.object({ result: z.literal("distinct_instance") }).strict(),
	z.object({ result: z.literal("none") }).strict(),
	z.object({ result: z.literal("uncertain") }).strict(),
]);

type TaskLifecycleJudgment = z.infer<typeof judgmentSchema>;

function cloneAnchors(
	anchors: TaskLifecycleOccurrenceAnchors,
): TaskLifecycleOccurrenceAnchors {
	return { ...anchors };
}

function cloneRevisionDetails(
	details: TaskLifecycleCanonicalRevisionDetails,
): TaskLifecycleCanonicalRevisionDetails {
	return {
		...details,
		...(details.participants === undefined
			? {}
			: { participants: [...details.participants] }),
		...(details.constraints === undefined ? {} : { constraints: [...details.constraints] }),
	};
}

function revisionDetailsKey(details: TaskLifecycleCanonicalRevisionDetails): string {
	return JSON.stringify([
		details.deadline,
		details.location,
		details.participants,
		details.deliverable,
		details.quantity,
		details.constraints,
	]);
}

export function applyTaskLifecycleRevisionPatch(
	current: TaskLifecycleCanonicalRevisionDetails,
	patch: TaskLifecycleRevisionDetails,
): {
	revisionDetails: TaskLifecycleCanonicalRevisionDetails;
	changed: boolean;
} {
	const next = cloneRevisionDetails(current);
	for (const key of ["deadline", "location", "deliverable", "quantity"] as const) {
		const value = patch[key];
		if (value === undefined) continue;
		if (value === null) delete next[key];
		else next[key] = value;
	}
	for (const key of ["participants", "constraints"] as const) {
		const value = patch[key];
		if (value === undefined) continue;
		if (value === null) delete next[key];
		else next[key] = [...value];
	}
	return {
		revisionDetails: next,
		changed: revisionDetailsKey(next) !== revisionDetailsKey(current),
	};
}

function normalizedDescription(description: string): string {
	return normalizeForCompare(description)
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export function findUniqueActiveTaskByDescription(
	description: string,
	instances: readonly TaskLifecycleInstanceSnapshot[],
): TaskLifecycleInstanceSnapshot | undefined {
	const normalized = normalizedDescription(description);
	const matches = instances.filter(
		(instance) =>
			instance.terminalAtMs === undefined &&
			normalizedDescription(instance.currentDescription) === normalized,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function sharedAnchorCount(
	left: TaskLifecycleOccurrenceAnchors,
	right: TaskLifecycleOccurrenceAnchors,
): number {
	return occurrenceAnchorKeys.filter(
		(key) => left[key] !== undefined && left[key] === right[key],
	).length;
}

function hasConflictingAnchor(
	left: TaskLifecycleOccurrenceAnchors,
	right: TaskLifecycleOccurrenceAnchors,
): boolean {
	return occurrenceAnchorKeys.some(
		(key) =>
			left[key] !== undefined &&
			right[key] !== undefined &&
			left[key] !== right[key],
	);
}

function tokenOverlapScore(left: string, right: string): number {
	const leftTokens = new Set(tokenizeForFts(left));
	const rightTokens = new Set(tokenizeForFts(right));
	let overlap = 0;
	for (const token of leftTokens) {
		if (rightTokens.has(token)) overlap += 1;
	}
	return overlap;
}

function isActiveAt(
	instance: TaskLifecycleInstanceSnapshot,
	assertion: TaskLifecycleAssertion,
): boolean {
	return (
		instance.projectId === assertion.projectId &&
		instance.createdAtMs <= assertion.effectiveAtMs &&
		(instance.terminalAtMs === undefined ||
			assertion.effectiveAtMs <= instance.terminalAtMs)
	);
}

function compareIds(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function rankCandidates(
	assertion: TaskLifecycleAssertion,
	instances: readonly TaskLifecycleInstanceSnapshot[],
): RankedCandidate[] {
	const assertionDescription = normalizedDescription(assertion.description);
	return instances
		.filter((instance) => isActiveAt(instance, assertion))
		.filter(
			(instance) =>
				!hasConflictingAnchor(assertion.occurrenceAnchors, instance.occurrenceAnchors),
		)
		.map((instance) => ({
			instance,
			sharedAnchorCount: sharedAnchorCount(
				assertion.occurrenceAnchors,
				instance.occurrenceAnchors,
			),
			exactDescription:
				normalizedDescription(instance.currentDescription) === assertionDescription,
			tokenOverlapScore: tokenOverlapScore(
				assertion.description,
				instance.currentDescription,
			),
		}))
		.toSorted(
			(left, right) =>
				right.sharedAnchorCount - left.sharedAnchorCount ||
				Number(right.exactDescription) - Number(left.exactDescription) ||
				right.tokenOverlapScore - left.tokenOverlapScore ||
				right.instance.createdAtMs - left.instance.createdAtMs ||
				compareIds(left.instance.activeTaskId, right.instance.activeTaskId),
		);
}

function serializeCandidate(
	instance: TaskLifecycleInstanceSnapshot,
): TaskLifecycleRelationCandidate {
	return {
		activeTaskId: instance.activeTaskId,
		currentDescription: instance.currentDescription,
		occurrenceAnchors: cloneAnchors(instance.occurrenceAnchors),
		revisionDetails: cloneRevisionDetails(instance.revisionDetails),
		createdAtMs: instance.createdAtMs,
		currentRevisionId: instance.currentRevisionId,
	};
}

export function buildTaskLifecycleCandidateSet(
	assertion: TaskLifecycleAssertion,
	instances: readonly TaskLifecycleInstanceSnapshot[],
): TaskLifecycleRelationCandidate[] {
	return rankCandidates(assertion, instances)
		.slice(0, relationCandidateLimit)
		.map((candidate) => serializeCandidate(candidate.instance));
}

export function taskLifecycleCandidateSetVersion(
	candidates: readonly TaskLifecycleRelationCandidate[],
): string {
	return createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
}

function deterministicTarget(
	assertion: TaskLifecycleAssertion,
	instances: readonly TaskLifecycleInstanceSnapshot[],
): TaskLifecycleInstanceSnapshot | undefined {
	const assertionDescription = normalizedDescription(assertion.description);
	const matches = instances.filter(
		(instance) =>
			isActiveAt(instance, assertion) &&
			!hasConflictingAnchor(assertion.occurrenceAnchors, instance.occurrenceAnchors) &&
			sharedAnchorCount(assertion.occurrenceAnchors, instance.occurrenceAnchors) > 0 &&
			normalizedDescription(instance.currentDescription) === assertionDescription,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function parseJudgment(attempt: TaskLifecycleJudgmentAttempt): TaskLifecycleJudgment | undefined {
	if (attempt.status !== "completed") return undefined;
	const parsed = judgmentSchema.safeParse(attempt.value);
	return parsed.success ? parsed.data : undefined;
}

function resolveSelectedTarget(
	judgment: TaskLifecycleJudgment | undefined,
	candidates: readonly TaskLifecycleRelationCandidate[],
): TaskLifecycleRelationCandidate | undefined {
	if (judgment?.result !== "same_instance") return undefined;
	const matches = candidates.filter(
		(candidate) => candidate.activeTaskId === judgment.activeTaskId,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function openSameInstance(
	assertion: TaskLifecycleAssertion,
	target: TaskLifecycleRelationCandidate,
	candidates: TaskLifecycleRelationCandidate[],
	candidateSetVersion?: string,
): TaskLifecycleOpenResolution {
	const applied = applyTaskLifecycleRevisionPatch(
		target.revisionDetails,
		assertion.revisionDetails,
	);
	const descriptionChanged =
		normalizedDescription(assertion.description) !== normalizedDescription(target.currentDescription);
	return {
		action: "open_or_refine",
		result: "same_instance",
		target,
		revisionIntent: {
			kind: applied.changed || descriptionChanged ? "successor_revision" : "evidence_only",
			revisionDetails: applied.revisionDetails,
		},
		candidates,
		...(candidateSetVersion === undefined ? {} : { candidateSetVersion }),
	};
}

function uncertainResolution(
	action: TaskLifecycleAction,
	candidates: TaskLifecycleRelationCandidate[],
): TaskLifecycleResolution {
	return action === "open_or_refine"
		? {
				action,
				result: "uncertain",
				disposition: "visible_unresolved_open",
				candidates,
			}
		: {
				action,
				result: "uncertain",
				disposition: "no_terminal_mutation",
				candidates,
			};
}

function resolveJudgment(
	assertion: TaskLifecycleAssertion,
	candidates: TaskLifecycleRelationCandidate[],
	judgment: TaskLifecycleJudgment | undefined,
	candidateSetVersion: string | undefined,
): TaskLifecycleResolution {
	const selected = resolveSelectedTarget(judgment, candidates);
	if (selected) {
		if (assertion.action === "open_or_refine") {
			if (
				candidateSetVersion === undefined ||
				candidateSetVersion !== taskLifecycleCandidateSetVersion(candidates)
			) {
				return uncertainResolution(assertion.action, candidates);
			}
			return openSameInstance(assertion, selected, candidates, candidateSetVersion);
		}
		if (
			candidateSetVersion === undefined ||
			candidateSetVersion !== taskLifecycleCandidateSetVersion(candidates)
		) {
			return uncertainResolution(assertion.action, candidates);
		}
		return {
			action: assertion.action,
			result: "same_instance",
			target: selected,
			candidates,
			candidateSetVersion,
		};
	}
	if (assertion.action === "open_or_refine" && judgment?.result === "distinct_instance") {
		if (
			candidateSetVersion === undefined ||
			candidateSetVersion !== taskLifecycleCandidateSetVersion(candidates)
		) {
			return uncertainResolution(assertion.action, candidates);
		}
		return {
			action: assertion.action,
			result: "distinct_instance",
			candidates,
			candidateSetVersion,
		};
	}
	if (
		assertion.action !== "open_or_refine" &&
		(judgment?.result === "none" || candidates.length === 0)
	) {
		return {
			action: assertion.action,
			result: "none",
			disposition: "no_terminal_mutation",
			candidates,
		};
	}
	return uncertainResolution(assertion.action, candidates);
}

export function resolveTaskLifecycle(input: {
	assertion: TaskLifecycleAssertion;
	instances: readonly TaskLifecycleInstanceSnapshot[];
	judgment: TaskLifecycleJudgmentAttempt;
}): TaskLifecycleResolution {
	const candidates = buildTaskLifecycleCandidateSet(input.assertion, input.instances);
	const target =
		input.assertion.action === "open_or_refine" && input.judgment.status === "absent"
			? deterministicTarget(input.assertion, input.instances)
			: undefined;
	if (target) {
		const serialized = serializeCandidate(target);
		return openSameInstance(input.assertion, serialized, candidates);
	}
	if (candidates.length === 0) {
		return input.assertion.action === "open_or_refine"
			? { action: input.assertion.action, result: "distinct_instance", candidates }
			: {
					action: input.assertion.action,
					result: "none",
					disposition: "no_terminal_mutation",
					candidates,
			};
	}
	return resolveJudgment(
		input.assertion,
		candidates,
		parseJudgment(input.judgment),
		input.judgment.status === "completed"
			? input.judgment.candidateSetVersion
			: undefined,
	);
}
