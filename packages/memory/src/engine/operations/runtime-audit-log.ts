import { readJsonlLines } from "./jsonl-lines";
/** @file runtime-audit-log.ts
 * @purpose Records audit events for operational visibility and safety-sensitive actions.
 * @boundary Plugin runtime events and filesystem-backed audit persistence.
 * @see sno-station-mem-plugin-runtime.ts, memory-tool-registration.ts, errors.ts.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger } from "@snoai/utils/logger";
import { redactSecrets } from "../security/redact";

export { getSnoStationMemStateDir, getStateDir } from "../shared/paths";

export type AuditEvent =
	| "tool_call"
	| "hook_trigger"
	| "kill_switch"
	| "startup"
	| "error"
	| "auto_recall"
	| "ambient_learning"
	| "session_summary"
	| "envelope_strip"
	| "storage_integrity"
	| "memory_injected"
	| "memory_searched"
	| "memory_read"
	| "memory_updated"
	| "memory_superseded"
	| "memory_deleted"
	| "memory_purged"
	| "rem_trigger_evaluated"
	| "rem_triggered"
	| "rem_completed"
	| "rem_failed";
export type AuditStatus = "ok" | "error" | "skipped" | "partial";

export interface AuditEntry {
	timestamp: string;
	event: AuditEvent;
	tool?: string;
	hook?: string;
	scope?: string;
	resultStatus: AuditStatus;
	errorCode?: string;
	durationMs?: number;
	decision?: string;
	details?: Record<string, unknown>;
}

export type MemoryAuditEvent =
	| "memory_injected"
	| "memory_searched"
	| "memory_read"
	| "memory_updated"
	| "memory_superseded"
	| "memory_deleted"
	| "memory_purged";

type MemoryAuditPhase = "started" | "completed" | "failed";

type MemoryAuditDetailBase = {
	operation: string;
	audit_phase: MemoryAuditPhase;
	audit_operation_id: string;
};

export type MutationAttemptOutcome =
	| "committed"
	| "preserved-without-adjudication"
	// The rewrite returned the wrong clause set — it lost a clause it had to keep, or kept one
	// this turn retired — and the write went ahead on a corrected clause list. The row is
	// committed and nothing was lost; this names how it got there.
	| "repaired-merge-text"
	| "refused-by-authority"
	| "failed"
	| "interrupted-unknown"
	| "no-mutation";

export type MutationAttemptWriter =
	| "profile-section"
	| "task-lifecycle"
	| "legacy-profile-refusal";

type MutationAuditDetail = {
	mutation_writer?: MutationAttemptWriter;
	mutation_subject?: string;
	mutation_outcome?: MutationAttemptOutcome;
	refusal_reason?: string;
};

export interface MemoryAuditDetailsByEvent {
	memory_injected: MemoryAuditDetailBase & {
		scope?: string;
		category?: string;
		lane?: string;
		count?: number;
		memory_ids?: string[];
		write_outcome?: "created" | "existing" | "mixed";
		created_count?: number;
		existing_count?: number;
	};
	memory_searched: MemoryAuditDetailBase & {
		scope?: string | string[];
		query_kind?: string;
		requested_count?: number;
		result_count?: number;
		memory_ids?: string[];
	};
	memory_read: MemoryAuditDetailBase & {
		scope?: string;
		requested_count?: number;
		result_count?: number;
		memory_ids?: string[];
		requested_fact_id?: string;
		resolved_fact_id?: string;
		fact_ids?: string[];
		found?: boolean;
		outcome?: string;
	};
	memory_updated: MemoryAuditDetailBase & MutationAuditDetail & {
		scope?: string;
		requested_count?: number;
		result_count?: number;
		memory_ids?: string[];
		outcome?: string;
		migration_status?: "migrated" | "noop";
		rewritten_rows?: number;
		checked_rows?: number;
	};
	memory_superseded: MemoryAuditDetailBase & MutationAuditDetail & {
		scope?: string;
		replacement_memory_id?: string;
		closed_memory_ids?: string[];
		write_outcome?: "created" | "existing";
	};
	memory_deleted: MemoryAuditDetailBase & {
		scope?: string;
		deleted_memory_ids?: string[];
		delete_reason?: string;
		count?: number;
		outcome?: "deleted" | "noop";
		removed_files?: number;
	};
	memory_purged: MemoryAuditDetailBase & {
		target_fact_id?: string;
		purged_fact_ids?: string[];
		failed_fact_ids?: string[];
		status?: "complete" | "partial" | "blocked";
		blocked_reason?: string;
	};
}

type MemoryAuditDetailInput<E extends MemoryAuditEvent> = Partial<
	Omit<MemoryAuditDetailsByEvent[E], keyof MemoryAuditDetailBase>
>;

export interface MemoryAuditRunOptions<T, E extends MemoryAuditEvent> {
	stateDir: string;
	event: E;
	operation: string;
	scope?: string;
	startedDetails?: MemoryAuditDetailInput<E>;
	run: () => Promise<T>;
	completedDetails: (result: T) => MemoryAuditDetailInput<E>;
}

export interface MemoryAuditSyncRunOptions<T, E extends MemoryAuditEvent> {
	stateDir: string;
	event: E;
	operation: string;
	scope?: string;
	startedDetails?: MemoryAuditDetailInput<E>;
	run: () => T;
	completedDetails: (result: T) => MemoryAuditDetailInput<E>;
}

export interface MutationAttemptCompletion {
	outcome: MutationAttemptOutcome;
	refusalReason?: string;
}

export interface MutationAttemptRunOptions<T> {
	stateDir: string;
	event: "memory_updated" | "memory_superseded";
	operation: string;
	writer: MutationAttemptWriter;
	subject?: string;
	run: () => Promise<T>;
	completedOutcome: (result: T) => MutationAttemptCompletion;
	failedOutcome?: (error: unknown) => MutationAttemptCompletion;
}

const auditWriteQueues = new Map<string, Promise<boolean>>();
const memoryAuditScope = new AsyncLocalStorage<boolean>();
const mutationAttemptScope = new AsyncLocalStorage<string>();
const mutationRecoveryPromises = new Map<string, Promise<void>>();

const MEMORY_AUDIT_COMMON_KEYS = ["operation", "audit_phase", "audit_operation_id"] as const;
const MUTATION_AUDIT_DETAIL_KEYS = [
	"mutation_writer",
	"mutation_subject",
	"mutation_outcome",
	"refusal_reason",
] as const;
const MEMORY_AUDIT_ALLOWED_DETAIL_KEYS: Record<MemoryAuditEvent, ReadonlySet<string>> = {
	memory_injected: new Set([
		...MEMORY_AUDIT_COMMON_KEYS,
		"scope",
		"category",
		"lane",
		"count",
		"memory_ids",
		"write_outcome",
		"created_count",
		"existing_count",
	]),
	memory_searched: new Set([
		...MEMORY_AUDIT_COMMON_KEYS,
		"scope",
		"query_kind",
		"requested_count",
		"result_count",
		"memory_ids",
	]),
	memory_read: new Set([
		...MEMORY_AUDIT_COMMON_KEYS,
		"scope",
		"requested_count",
		"result_count",
		"memory_ids",
		"requested_fact_id",
		"resolved_fact_id",
		"fact_ids",
		"found",
		"outcome",
	]),
	memory_updated: new Set([
		...MEMORY_AUDIT_COMMON_KEYS,
		...MUTATION_AUDIT_DETAIL_KEYS,
		"scope",
		"requested_count",
		"result_count",
		"memory_ids",
		"outcome",
		"migration_status",
		"rewritten_rows",
		"checked_rows",
	]),
	memory_superseded: new Set([
		...MEMORY_AUDIT_COMMON_KEYS,
		...MUTATION_AUDIT_DETAIL_KEYS,
		"scope",
		"replacement_memory_id",
		"closed_memory_ids",
		"write_outcome",
	]),
	memory_deleted: new Set([
		...MEMORY_AUDIT_COMMON_KEYS,
		"scope",
		"deleted_memory_ids",
		"delete_reason",
		"count",
		"outcome",
		"removed_files",
	]),
	memory_purged: new Set([
		...MEMORY_AUDIT_COMMON_KEYS,
		"target_fact_id",
		"purged_fact_ids",
		"failed_fact_ids",
		"status",
		"blocked_reason",
	]),
};

/** Implements enqueue audit write as the local audit log state operation. */
function enqueueAuditWrite(auditPath: string, line: string): Promise<boolean> {
	const previous = auditWriteQueues.get(auditPath) ?? Promise.resolve(true);
	const write = previous
		.catch(() => undefined)
		.then(async () => {
			// This operational safety step establishes state that later reads and cleanup paths depend on.
			mkdirSync(path.dirname(auditPath), { recursive: true });
			await appendFile(auditPath, line);
			return true;
		});
	const next = write.catch((error) => {
			createLogger("sno-station-mem:audit").error("Audit entry append failed", { error }, {
				event_name: "memory.audit.append.failed",
				file: "packages/sno-station-mem/src/engine/operations/runtime-audit-log.ts",
				function: "enqueueAuditWrite", site_id: "memory.audit.append.failed",
			});
			return false;
		});
	auditWriteQueues.set(auditPath, next);
	void next.finally(() => {
		// Execute the prepared statement after all dynamic values have been normalized.
		if (auditWriteQueues.get(auditPath) === next) {
			auditWriteQueues.delete(auditPath);
		}
	});
	return next;
}

/** Returns audit path from audit log state state without side effects. */
export function getAuditPath(stateDir: string): string {
	// Centralize the operational safety fallback value at the boundary of this helper.
	return path.join(stateDir, "audit.jsonl");
}

/** Returns cost path from audit log state state without side effects. */
export function getCostPath(stateDir: string): string {
	// Centralize the operational safety fallback value at the boundary of this helper.
	return path.join(stateDir, "cost.jsonl");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMemoryAuditEvent(event: AuditEvent): event is MemoryAuditEvent {
	return event.startsWith("memory_");
}

function redactAuditValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map(redactAuditValue);
	if (!isRecord(value)) return value;
	const redacted: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		redacted[key] = redactAuditValue(child);
	}
	return redacted;
}

function prepareAuditEntry(
	entry: Omit<AuditEntry, "timestamp">,
): Omit<AuditEntry, "timestamp"> {
	if (!isMemoryAuditEvent(entry.event) || entry.details?.["audit_phase"] === undefined) {
		return entry;
	}
	const allowed = MEMORY_AUDIT_ALLOWED_DETAIL_KEYS[entry.event];
	const details: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry.details)) {
		if (allowed.has(key)) details[key] = value;
		else {
			createLogger("sno-station-mem:audit").error("memory.audit.detail.unknown", { event: entry.event, key }, {
				event_name: "memory.audit.detail.unknown", file: "packages/sno-station-mem/src/engine/operations/runtime-audit-log.ts",
				function: "prepareAuditEntry", site_id: "memory.audit.detail.unknown",
			});
		}
	}
	return {
		...entry,
		...(entry.scope === undefined ? {} : { scope: redactSecrets(entry.scope) }),
		details: redactAuditValue(details) as Record<string, unknown>,
	};
}

/** Persists audit entry through the single audit log state write path. */
// LH: Audit JSONL entries are operational metadata only and should not include raw memory text.
// LH: Append-only audit files make tool behavior reviewable without becoming another memory store.
// LH: Write failures are logged but do not convert successful tool operations into failures.
export function appendAuditEntry(stateDir: string, entry: Omit<AuditEntry, "timestamp">): void {
	const auditPath = getAuditPath(stateDir);
	const prepared = prepareAuditEntry(entry);
	void enqueueAuditWrite(
		auditPath,
		`${JSON.stringify({ ...prepared, timestamp: new Date().toISOString() })}\n`,
	);
}

/** Waits for the audit append; failures are logged without blocking the operation. */
export async function appendAuditEntryStrict(
	stateDir: string,
	entry: Omit<AuditEntry, "timestamp">,
): Promise<boolean> {
	const auditPath = getAuditPath(stateDir);
	const prepared = prepareAuditEntry(entry);
	return enqueueAuditWrite(
		auditPath,
		`${JSON.stringify({ ...prepared, timestamp: new Date().toISOString() })}\n`,
	);
}

/** Attempts a synchronous audit append and logs a failure. */
export function appendAuditEntrySync(
	stateDir: string,
	entry: Omit<AuditEntry, "timestamp">,
): void {
	const auditPath = getAuditPath(stateDir);
	const prepared = prepareAuditEntry(entry);
	try {
		mkdirSync(path.dirname(auditPath), { recursive: true });
		appendFileSync(auditPath, `${JSON.stringify({ ...prepared, timestamp: new Date().toISOString() })}\n`);
	} catch (error) {
		createLogger("sno-station-mem:audit").error("memory.audit.append.failed", { error }, {
			event_name: "memory.audit.append.failed", file: "packages/sno-station-mem/src/engine/operations/runtime-audit-log.ts",
			function: "appendAuditEntrySync", site_id: "memory.audit.sync.failed",
		});
	}
}

function memoryAuditDetails<E extends MemoryAuditEvent>(
	operation: string,
	phase: MemoryAuditPhase,
	operationId: string,
	details: MemoryAuditDetailInput<E> | undefined,
): MemoryAuditDetailsByEvent[E] {
	return {
		...details,
		operation,
		audit_phase: phase,
		audit_operation_id: operationId,
	} as MemoryAuditDetailsByEvent[E];
}

/** Records the start and outcome without using audit availability as admission. */
export async function runWithMemoryAudit<T, E extends MemoryAuditEvent>(
	options: MemoryAuditRunOptions<T, E>,
): Promise<T> {
	if (memoryAuditScope.getStore()) return options.run();
	return memoryAuditScope.run(true, async () => {
		const operationId = randomUUID();
		await appendAuditEntryStrict(options.stateDir, {
			event: options.event,
			scope: options.scope,
			resultStatus: "partial",
			details: memoryAuditDetails(
				options.operation,
				"started",
				operationId,
				options.startedDetails,
			),
		});
		let result: T;
		try {
			result = await options.run();
		} catch (error) {
			await appendAuditEntryStrict(options.stateDir, {
				event: options.event,
				scope: options.scope,
				resultStatus: "error",
				errorCode: "memory_operation_failed",
				details: memoryAuditDetails(
					options.operation,
					"failed",
					operationId,
					options.startedDetails,
				),
			});
			throw error;
		}
		await appendAuditEntryStrict(options.stateDir, {
			event: options.event,
			scope: options.scope,
			resultStatus: "ok",
			details: memoryAuditDetails(
				options.operation,
				"completed",
				operationId,
				options.completedDetails(result),
			),
		});
		return result;
	});
}

interface OpenMutationAttempt {
	event: "memory_updated" | "memory_superseded";
	operation: string;
	attemptId: string;
	writer: MutationAttemptWriter;
	subject?: string;
}

async function readOpenMutationAttempts(stateDir: string): Promise<OpenMutationAttempt[]> {
	const auditPath = getAuditPath(stateDir);
	if (!existsSync(auditPath)) return [];
	const openAttempts = new Map<string, OpenMutationAttempt>();
	for await (const line of readJsonlLines(auditPath)) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || !isRecord(parsed["details"])) continue;
		const event = parsed["event"];
		const decision = parsed["decision"];
		const details = parsed["details"];
		const attemptId = details["audit_operation_id"];
		if (typeof attemptId !== "string") continue;
		if (details["mutation_outcome"] !== undefined) {
			openAttempts.delete(attemptId);
			continue;
		}
		if (
			decision !== "mutation-attempt-open" ||
			details["audit_phase"] !== "started" ||
			(event !== "memory_updated" && event !== "memory_superseded") ||
			typeof details["operation"] !== "string" ||
			(details["mutation_writer"] !== "profile-section" &&
				details["mutation_writer"] !== "task-lifecycle" &&
				details["mutation_writer"] !== "legacy-profile-refusal")
		) {
			continue;
		}
		openAttempts.set(attemptId, {
			event,
			operation: details["operation"],
			attemptId,
			writer: details["mutation_writer"],
			...(typeof details["mutation_subject"] === "string"
				? { subject: details["mutation_subject"] }
				: {}),
		});
	}
	return [...openAttempts.values()];
}

function mutationAuditDetails(input: {
	operation: string;
	phase: MemoryAuditPhase;
	attemptId: string;
	writer: MutationAttemptWriter;
	subject?: string;
	outcome?: MutationAttemptOutcome;
	refusalReason?: string;
}): MemoryAuditDetailsByEvent["memory_updated"] {
	return {
		operation: input.operation,
		audit_phase: input.phase,
		audit_operation_id: input.attemptId,
		mutation_writer: input.writer,
		...(input.subject === undefined ? {} : { mutation_subject: input.subject }),
		...(input.outcome === undefined ? {} : { mutation_outcome: input.outcome }),
		...(input.refusalReason === undefined ? {} : { refusal_reason: input.refusalReason }),
	};
}

function mutationAuditStatus(outcome: MutationAttemptOutcome): AuditStatus {
	if (outcome === "failed" || outcome === "interrupted-unknown") return "error";
	if (outcome.startsWith("refused-")) return "skipped";
	return "ok";
}

async function closeMutationAttempt(
	stateDir: string,
	attempt: OpenMutationAttempt,
	completion: MutationAttemptCompletion,
): Promise<void> {
	const phase: MemoryAuditPhase =
		completion.outcome === "failed" || completion.outcome === "interrupted-unknown"
			? "failed"
			: "completed";
	await appendAuditEntryStrict(stateDir, {
		event: attempt.event,
		resultStatus: mutationAuditStatus(completion.outcome),
		decision: completion.outcome,
		details: mutationAuditDetails({
			operation: attempt.operation,
			phase,
			attemptId: attempt.attemptId,
			writer: attempt.writer,
			...(attempt.subject === undefined ? {} : { subject: attempt.subject }),
			outcome: completion.outcome,
			...(completion.refusalReason === undefined
				? {}
				: { refusalReason: completion.refusalReason }),
		}),
	});
}

/** Closes mutation attempts whose process stopped before a terminal audit record was written. */
export async function recoverInterruptedMutationAttempts(stateDir: string): Promise<string[]> {
	const attempts = await readOpenMutationAttempts(stateDir);
	for (const attempt of attempts) {
		await closeMutationAttempt(stateDir, attempt, { outcome: "interrupted-unknown" });
	}
	return attempts.map((attempt) => attempt.attemptId);
}

function ensureMutationRecovery(stateDir: string): Promise<void> {
	const existing = mutationRecoveryPromises.get(stateDir);
	if (existing) return existing;
	const recovery = recoverInterruptedMutationAttempts(stateDir).then(() => undefined);
	mutationRecoveryPromises.set(stateDir, recovery);
	return recovery;
}

/** Runs one mutation under a durable open record and exactly one terminal outcome. */
export async function runWithMutationAttempt<T>(
	options: MutationAttemptRunOptions<T>,
): Promise<T> {
	if (mutationAttemptScope.getStore()) return options.run();
	await ensureMutationRecovery(options.stateDir);
	const attempt: OpenMutationAttempt = {
		event: options.event,
		operation: options.operation,
		attemptId: randomUUID(),
		writer: options.writer,
		...(options.subject === undefined ? {} : { subject: options.subject }),
	};
	return mutationAttemptScope.run(attempt.attemptId, async () => {
		await appendAuditEntryStrict(options.stateDir, {
			event: options.event,
			resultStatus: "partial",
			decision: "mutation-attempt-open",
			details: mutationAuditDetails({
				operation: attempt.operation,
				phase: "started",
				attemptId: attempt.attemptId,
				writer: attempt.writer,
				...(attempt.subject === undefined ? {} : { subject: attempt.subject }),
			}),
		});
		let result: T;
		try {
			result = await options.run();
		} catch (error) {
			await closeMutationAttempt(
				options.stateDir,
				attempt,
				options.failedOutcome?.(error) ?? { outcome: "failed" },
			);
			throw error;
		}
		await closeMutationAttempt(options.stateDir, attempt, options.completedOutcome(result));
		return result;
	});
}

/** Returns the durable identifier owned by the current mutation boundary. */
export function currentMutationAttemptId(): string {
	const attemptId = mutationAttemptScope.getStore();
	if (!attemptId) {
		throw new Error("mutation attempt identifier requested outside a mutation boundary");
	}
	return attemptId;
}

/** Runs a synchronous memory operation only after its durable start record is persisted. */
export function runWithMemoryAuditSync<T, E extends MemoryAuditEvent>(
	options: MemoryAuditSyncRunOptions<T, E>,
): T {
	if (memoryAuditScope.getStore()) return options.run();
	return memoryAuditScope.run(true, () => {
		const operationId = randomUUID();
		appendAuditEntrySync(options.stateDir, {
			event: options.event,
			scope: options.scope,
			resultStatus: "partial",
			details: memoryAuditDetails(
				options.operation,
				"started",
				operationId,
				options.startedDetails,
			),
		});
		let result: T;
		try {
			result = options.run();
		} catch (error) {
			appendAuditEntrySync(options.stateDir, {
				event: options.event,
				scope: options.scope,
				resultStatus: "error",
				errorCode: "memory_operation_failed",
				details: memoryAuditDetails(
					options.operation,
					"failed",
					operationId,
					options.startedDetails,
				),
			});
			throw error;
		}
		appendAuditEntrySync(options.stateDir, {
			event: options.event,
			scope: options.scope,
			resultStatus: "ok",
			details: memoryAuditDetails(
				options.operation,
				"completed",
				operationId,
				options.completedDetails(result),
			),
		});
		return result;
	});
}

/** Implements flush audit writes as the local audit log state operation. */
export async function flushAuditWrites(): Promise<void> {
	const pending = Array.from(auditWriteQueues.values());
	if (pending.length === 0) return;
	// Run independent branches together while preserving partial-failure diagnostics.
	await Promise.allSettled(pending);
}
