import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendAuditEntryStrict,
	recoverInterruptedMutationAttempts,
	runWithMutationAttempt,
} from "../../../../packages/memory/src/engine/operations/runtime-audit-log.ts";

interface MutationRecord {
	decision?: string;
	details?: {
		audit_operation_id?: string;
		audit_phase?: string;
		mutation_writer?: string;
		mutation_subject?: string;
		mutation_outcome?: string;
		refusal_reason?: string;
	};
}

const tempRoots: string[] = [];

function createStateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "mutation-attempt-audit-"));
	tempRoots.push(root);
	const stateDir = join(root, "state");
	mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

function readRecords(stateDir: string): MutationRecord[] {
	return readFileSync(join(stateDir, "audit.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as MutationRecord);
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("mutation attempt audit lifecycle", () => {
	it("persists the open record before mutation and closes exactly once", async () => {
		const stateDir = createStateDir();
		const result = await runWithMutationAttempt({
			stateDir,
			event: "memory_superseded",
			operation: "profile_section_update",
			writer: "profile-section",
			subject: "preferences.music",
			run: async () => {
				const opened = readRecords(stateDir);
				expect(opened).toHaveLength(1);
				expect(opened[0]?.details?.audit_phase).toBe("started");
				return { rowId: "row-2" };
			},
			completedOutcome: () => ({ outcome: "committed" }),
		});

		expect(result).toEqual({ rowId: "row-2" });
		const records = readRecords(stateDir);
		expect(records).toHaveLength(2);
		expect(records[0]?.details?.audit_operation_id).toBe(
			records[1]?.details?.audit_operation_id,
		);
		expect(records[1]).toMatchObject({
			decision: "committed",
			details: { audit_phase: "completed", mutation_outcome: "committed" },
		});
	});

	it("closes a thrown mutation as failed and rethrows the original error", async () => {
		const stateDir = createStateDir();
		const failure = new Error("store unavailable");

		await expect(
			runWithMutationAttempt({
				stateDir,
				event: "memory_updated",
				operation: "task_lifecycle_update",
				writer: "task-lifecycle",
				subject: "active_tasks",
				run: async () => {
					throw failure;
				},
				completedOutcome: () => ({ outcome: "committed" }),
			}),
		).rejects.toBe(failure);

		const records = readRecords(stateDir);
		expect(records).toHaveLength(2);
		expect(records[1]).toMatchObject({
			decision: "failed",
			details: { audit_phase: "failed", mutation_outcome: "failed" },
		});
	});

	it("closes an orphan once as interrupted-unknown on recovery", async () => {
		const stateDir = createStateDir();
		await appendAuditEntryStrict(stateDir, {
			event: "memory_superseded",
			resultStatus: "partial",
			decision: "mutation-attempt-open",
			details: {
				operation: "profile_section_update",
				audit_phase: "started",
				audit_operation_id: "orphan-attempt",
				mutation_writer: "profile-section",
				mutation_subject: "preferences.music",
			},
		});

		expect(await recoverInterruptedMutationAttempts(stateDir)).toEqual(["orphan-attempt"]);
		expect(await recoverInterruptedMutationAttempts(stateDir)).toEqual([]);
		const records = readRecords(stateDir);
		expect(records).toHaveLength(2);
		expect(records[1]).toMatchObject({
			decision: "interrupted-unknown",
			details: {
				audit_operation_id: "orphan-attempt",
				audit_phase: "failed",
				mutation_outcome: "interrupted-unknown",
			},
		});
	});

	it("closes an orphan before the first mutation attempt in a fresh process", async () => {
		const stateDir = createStateDir();
		await appendAuditEntryStrict(stateDir, {
			event: "memory_updated",
			resultStatus: "partial",
			decision: "mutation-attempt-open",
			details: {
				operation: "task_lifecycle_update",
				audit_phase: "started",
				audit_operation_id: "startup-orphan",
				mutation_writer: "task-lifecycle",
				mutation_subject: "active_tasks",
			},
		});

		await runWithMutationAttempt({
			stateDir,
			event: "memory_updated",
			operation: "task_lifecycle_update",
			writer: "task-lifecycle",
			subject: "active_tasks",
			run: async () => "done",
			completedOutcome: () => ({ outcome: "committed" }),
		});
		const records = readRecords(stateDir);
		expect(records.filter((record) => record.decision === "interrupted-unknown")).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ audit_operation_id: "startup-orphan" }),
			}),
		]);
	});

	it("does not open a second attempt for a nested writer", async () => {
		const stateDir = createStateDir();
		await runWithMutationAttempt({
			stateDir,
			event: "memory_superseded",
			operation: "profile_section_update",
			writer: "profile-section",
			subject: "active_tasks",
			run: () =>
				runWithMutationAttempt({
					stateDir,
					event: "memory_updated",
					operation: "task_lifecycle_update",
					writer: "task-lifecycle",
					subject: "active_tasks",
					run: async () => "done",
					completedOutcome: () => ({ outcome: "committed" }),
				}),
			completedOutcome: () => ({ outcome: "committed" }),
		});

		expect(readRecords(stateDir)).toHaveLength(2);
	});
});
