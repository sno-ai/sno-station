/** @file task-lifecycle-assertion.ts
 * @purpose Admits typed lifecycle assertions and allocates replay-safe command/task identities.
 * @boundary Input contract and command persistence only; no resolver, binding, or task mutation.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { buildExtractionIdempotencyKey } from "./insight-distill-write-actions";
import type { CandidateMemory } from "../shared/types";

const commandIdPattern = /^[0-9a-f]{64}$/u;
const activeTaskIdPattern = /^ati_[0-9a-f]{64}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const timestampPattern =
	/^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?(?<zone>Z|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u;

export type TaskLifecycleAction = "open_or_refine" | "complete" | "remove";
export type TaskLifecycleTimeSource = "event_at" | "session_time" | "first_resolution";

export interface TaskLifecycleOccurrenceAnchors {
	date?: string;
	ordinal?: string;
	recurrence?: string;
	explicitOccurrenceId?: string;
}

export interface TaskLifecycleRevisionDetails {
	deadline?: string | null;
	location?: string | null;
	participants?: string[] | null;
	deliverable?: string | null;
	quantity?: string | null;
	constraints?: string[] | null;
}

export interface TaskLifecycleAssertion {
	kind: "task_lifecycle";
	action: TaskLifecycleAction;
	commandId: string;
	projectId: string;
	subject: "user";
	description: string;
	effectiveAtMs: number;
	timeSource: TaskLifecycleTimeSource;
	occurrenceAnchors: TaskLifecycleOccurrenceAnchors;
	revisionDetails: TaskLifecycleRevisionDetails;
	evidenceMemoryId?: string;
}

export interface TaskLifecycleAssertionDraft {
	kind: "task_lifecycle";
	action: TaskLifecycleAction;
	projectId: string;
	subject: "user";
	description: string;
	occurrenceAnchors: TaskLifecycleOccurrenceAnchors;
	revisionDetails: TaskLifecycleRevisionDetails;
	evidenceMemoryId?: string;
}

export type TaskLifecycleCommandSource =
	| {
			kind: "extraction_trace";
			sessionKey: string;
			candidate: CandidateMemory;
	  }
	| {
			kind: "authorized_untraced";
			sessionKey: string;
			replayIdentity: string;
			assertionOrdinal: number;
	  };

export interface TaskLifecycleCommandIdentity {
	commandId: string;
	canonicalTuple: readonly string[] | undefined;
	identityJson: string;
}

export interface AuthorizedUntracedTaskLifecycleCommandIdentity
	extends TaskLifecycleCommandIdentity {
	canonicalTuple: readonly string[];
}

export interface TaskLifecycleCommandClaim extends TaskLifecycleCommandIdentity {
	action: TaskLifecycleAction;
	sourceAssertionJson: string;
}

export class TaskLifecycleCommandMismatchError extends Error {
	constructor() {
		super("Task lifecycle command claim does not match its canonical source input");
		this.name = "TaskLifecycleCommandMismatchError";
	}
}

export interface TaskLifecycleEffectiveTime {
	effectiveAtMs: number;
	timeSource: TaskLifecycleTimeSource;
}

export interface TaskLifecycleTimestampPersistenceInput {
	projectId: string;
	commandId: string;
	effectiveAtMs: number;
	timeSource: TaskLifecycleTimeSource;
}

export interface TaskLifecycleTimestampPersistenceResult {
	effectiveAtMs: number;
	timeSource: TaskLifecycleTimeSource;
	created: boolean;
}

export interface TaskLifecycleTimestampStore {
	resolveTaskLifecycleTimestamp(
		input: TaskLifecycleTimestampPersistenceInput,
	): TaskLifecycleTimestampPersistenceResult;
}

export interface AdmitTaskLifecycleAssertionInput {
	assertion: unknown;
	source: TaskLifecycleCommandSource;
	commandClaim: TaskLifecycleCommandClaim;
	eventAt?: unknown;
	sessionTime?: unknown;
	firstResolutionNowMs: number;
}

export interface AdmittedTaskLifecycleAssertion {
	assertion: TaskLifecycleAssertion;
	commandIdentity: TaskLifecycleCommandIdentity;
	created: boolean;
}

function normalizeScalar(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

const normalizedScalarSchema = z
	.string()
	.transform(normalizeScalar)
	.pipe(z.string().min(1));

const canonicalDateSchema = normalizedScalarSchema
	.refine((value) => datePattern.test(value), "Expected an ISO-8601 calendar date")
	.refine((value) => {
		const parsed = new Date(`${value}T00:00:00.000Z`);
		return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
	}, "Expected a valid calendar date");

const canonicalSetSchema = z
	.array(normalizedScalarSchema)
	.transform((values) => [...new Set(values)].toSorted());

const occurrenceAnchorsSchema: z.ZodType<TaskLifecycleOccurrenceAnchors> = z
	.object({
		date: canonicalDateSchema.optional(),
		ordinal: normalizedScalarSchema.optional(),
		recurrence: normalizedScalarSchema.optional(),
		explicitOccurrenceId: normalizedScalarSchema.optional(),
	})
	.strict();

const revisionDetailsSchema: z.ZodType<TaskLifecycleRevisionDetails> = z
	.object({
		deadline: canonicalDateSchema.nullable().optional(),
		location: normalizedScalarSchema.nullable().optional(),
		participants: canonicalSetSchema.nullable().optional(),
		deliverable: normalizedScalarSchema.nullable().optional(),
		quantity: normalizedScalarSchema.nullable().optional(),
		constraints: canonicalSetSchema.nullable().optional(),
	})
	.strict();

const draftSchema: z.ZodType<TaskLifecycleAssertionDraft> = z
	.object({
		kind: z.literal("task_lifecycle"),
		action: z.enum(["open_or_refine", "complete", "remove"]),
		projectId: z.string().refine((value) => value.trim().length > 0, "Project id is required"),
		subject: z.literal("user"),
		description: z
			.string()
			.refine((value) => value.trim().length > 0, "Description is required"),
		occurrenceAnchors: occurrenceAnchorsSchema,
		revisionDetails: revisionDetailsSchema,
		evidenceMemoryId: normalizedScalarSchema.optional(),
	})
	.strict();

const assertionSchema: z.ZodType<TaskLifecycleAssertion> = z
	.object({
		kind: z.literal("task_lifecycle"),
		action: z.enum(["open_or_refine", "complete", "remove"]),
		commandId: z.string().regex(commandIdPattern, "Malformed command identity"),
		projectId: z.string().refine((value) => value.trim().length > 0, "Project id is required"),
		subject: z.literal("user"),
		description: z
			.string()
			.refine((value) => value.trim().length > 0, "Description is required"),
		effectiveAtMs: z.number().int().safe().finite(),
		timeSource: z.enum(["event_at", "session_time", "first_resolution"]),
		occurrenceAnchors: occurrenceAnchorsSchema,
		revisionDetails: revisionDetailsSchema,
		evidenceMemoryId: normalizedScalarSchema.optional(),
	})
	.strict();

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value !== "object") {
		throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.toSorted()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function requireIdentityField(name: string, value: string): void {
	if (value.length === 0 || value.trim().length === 0) {
		throw new TypeError(`${name} is required`);
	}
}

function parseSourceTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const groups = timestampPattern.exec(value)?.groups;
	if (!groups) return undefined;
	const year = Number(groups.year);
	const month = Number(groups.month);
	const day = Number(groups.day);
	const hour = Number(groups.hour);
	const minute = Number(groups.minute);
	const second = Number(groups.second);
	const millisecond = Number((groups.fraction ?? "").padEnd(3, "0"));
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
	const local = new Date(0);
	local.setUTCFullYear(year, month - 1, day);
	local.setUTCHours(hour, minute, second, millisecond);
	if (
		local.getUTCFullYear() !== year ||
		local.getUTCMonth() !== month - 1 ||
		local.getUTCDate() !== day
	) {
		return undefined;
	}
	const offsetHour = groups.zone === "Z" ? 0 : Number(groups.offsetHour);
	const offsetMinute = groups.zone === "Z" ? 0 : Number(groups.offsetMinute);
	if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
		return undefined;
	}
	const offsetSign = groups.sign === "-" ? -1 : 1;
	const resolved =
		local.valueOf() - offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
	return Number.isSafeInteger(resolved) ? resolved : undefined;
}

export function parseTaskLifecycleAssertion(input: unknown): TaskLifecycleAssertion {
	return assertionSchema.parse(input);
}

export function encodeLengthPrefixedTuple(fields: readonly string[]): Buffer {
	const encodedFields = fields.map((field) => Buffer.from(field, "utf8"));
	const totalLength = encodedFields.reduce((total, field) => total + 4 + field.byteLength, 0);
	const output = Buffer.allocUnsafe(totalLength);
	let offset = 0;
	for (const field of encodedFields) {
		if (field.byteLength > 0xffff_ffff) {
			throw new RangeError("Tuple field exceeds the unsigned 32-bit length limit");
		}
		output.writeUInt32BE(field.byteLength, offset);
		offset += 4;
		field.copy(output, offset);
		offset += field.byteLength;
	}
	return output;
}

export function hashLengthPrefixedTuple(fields: readonly string[]): string {
	return createHash("sha256").update(encodeLengthPrefixedTuple(fields)).digest("hex");
}

export function buildTaskLifecycleCommandIdentity(input: {
	projectId: string;
	source: Extract<TaskLifecycleCommandSource, { kind: "authorized_untraced" }>;
}): AuthorizedUntracedTaskLifecycleCommandIdentity;
export function buildTaskLifecycleCommandIdentity(input: {
	projectId: string;
	source: Extract<TaskLifecycleCommandSource, { kind: "extraction_trace" }>;
}): TaskLifecycleCommandIdentity;
export function buildTaskLifecycleCommandIdentity(input: {
	projectId: string;
	source: TaskLifecycleCommandSource;
}): TaskLifecycleCommandIdentity;
export function buildTaskLifecycleCommandIdentity(input: {
	projectId: string;
	source: TaskLifecycleCommandSource;
}): TaskLifecycleCommandIdentity {
	requireIdentityField("Project id", input.projectId);
	requireIdentityField("Session key", input.source.sessionKey);
	if (input.source.kind === "extraction_trace") {
		const commandId = buildExtractionIdempotencyKey(
			input.source.sessionKey,
			input.source.candidate,
		);
		if (!commandId) {
			throw new TypeError("Traced lifecycle command requires an extraction trace");
		}
		return {
			commandId,
			canonicalTuple: undefined,
			identityJson: canonicalJson({
				kind: "extraction_trace",
				projectId: input.projectId,
				sessionKey: input.source.sessionKey,
				candidate: input.source.candidate,
			}),
		};
	}

	requireIdentityField("Replay identity", input.source.replayIdentity);
	if (
		!Number.isSafeInteger(input.source.assertionOrdinal) ||
		input.source.assertionOrdinal < 0
	) {
		throw new TypeError("Assertion ordinal must be a non-negative safe integer");
	}
	const canonicalTuple = [
		"task-lifecycle-command-v1",
		input.projectId,
		input.source.sessionKey,
		input.source.replayIdentity,
		String(input.source.assertionOrdinal),
	] as const;
	return {
		commandId: hashLengthPrefixedTuple(canonicalTuple),
		canonicalTuple,
		identityJson: canonicalJson({
			kind: "authorized_untraced",
			canonicalTuple,
		}),
	};
}

export function resolveTaskLifecycleEffectiveTime(input: {
	eventAt?: unknown;
	sessionTime?: unknown;
	firstResolutionNowMs: number;
}): TaskLifecycleEffectiveTime {
	const eventAt = parseSourceTimestamp(input.eventAt);
	if (eventAt !== undefined) return { effectiveAtMs: eventAt, timeSource: "event_at" };
	const sessionTime = parseSourceTimestamp(input.sessionTime);
	if (sessionTime !== undefined) {
		return { effectiveAtMs: sessionTime, timeSource: "session_time" };
	}
	if (!Number.isSafeInteger(input.firstResolutionNowMs)) {
		throw new TypeError("First-resolution time must be a finite safe integer");
	}
	return {
		effectiveAtMs: input.firstResolutionNowMs,
		timeSource: "first_resolution",
	};
}

export function buildTaskLifecycleCommandClaim(input: {
	assertion: unknown;
	source: TaskLifecycleCommandSource;
}): TaskLifecycleCommandClaim {
	const assertion = draftSchema.parse(input.assertion);
	const identity = buildTaskLifecycleCommandIdentity({
		projectId: assertion.projectId,
		source: input.source,
	});
	return {
		...identity,
		action: assertion.action,
		sourceAssertionJson: canonicalJson(assertion),
	};
}

export function allocateActiveTaskId(projectId: string, openingCommandId: string): string {
	requireIdentityField("Project id", projectId);
	if (!commandIdPattern.test(openingCommandId)) {
		throw new TypeError("Opening command id must be lowercase hexadecimal SHA-256");
	}
	return `ati_${hashLengthPrefixedTuple([
		"active-task-instance-v1",
		projectId,
		openingCommandId,
	])}`;
}

export function allocateActiveTaskRevisionId(
	activeTaskId: string,
	creatingCommandId: string,
): string {
	if (!activeTaskIdPattern.test(activeTaskId)) {
		throw new TypeError("Active task id must use the canonical runtime format");
	}
	if (!commandIdPattern.test(creatingCommandId)) {
		throw new TypeError("Creating command id must be lowercase hexadecimal SHA-256");
	}
	return `atr_${hashLengthPrefixedTuple([
		"active-task-revision-v1",
		activeTaskId,
		creatingCommandId,
	])}`;
}

export function admitTaskLifecycleAssertion(
	store: TaskLifecycleTimestampStore,
	input: AdmitTaskLifecycleAssertionInput,
): AdmittedTaskLifecycleAssertion {
	const draft = draftSchema.parse(input.assertion);
	const expectedClaim = buildTaskLifecycleCommandClaim({
		assertion: draft,
		source: input.source,
	});
	if (
		input.commandClaim.commandId !== expectedClaim.commandId ||
		input.commandClaim.identityJson !== expectedClaim.identityJson ||
		input.commandClaim.action !== expectedClaim.action ||
		input.commandClaim.sourceAssertionJson !== expectedClaim.sourceAssertionJson ||
		(input.commandClaim.canonicalTuple === undefined
			? undefined
			: canonicalJson(input.commandClaim.canonicalTuple)) !==
			(expectedClaim.canonicalTuple === undefined
				? undefined
				: canonicalJson(expectedClaim.canonicalTuple))
	) {
		throw new TaskLifecycleCommandMismatchError();
	}
	const commandIdentity: TaskLifecycleCommandIdentity = {
		commandId: expectedClaim.commandId,
		canonicalTuple: expectedClaim.canonicalTuple,
		identityJson: expectedClaim.identityJson,
	};
	const proposedTime = resolveTaskLifecycleEffectiveTime(input);
	const proposedAssertion = parseTaskLifecycleAssertion({
		...draft,
		commandId: commandIdentity.commandId,
		effectiveAtMs: proposedTime.effectiveAtMs,
		timeSource: proposedTime.timeSource,
	});
	const persisted = store.resolveTaskLifecycleTimestamp({
		projectId: proposedAssertion.projectId,
		commandId: proposedAssertion.commandId,
		effectiveAtMs: proposedAssertion.effectiveAtMs,
		timeSource: proposedAssertion.timeSource,
	});
	const assertion = parseTaskLifecycleAssertion({
		...proposedAssertion,
		effectiveAtMs: persisted.effectiveAtMs,
		timeSource: persisted.timeSource,
	});
	return {
		assertion,
		commandIdentity,
		created: persisted.created,
	};
}
