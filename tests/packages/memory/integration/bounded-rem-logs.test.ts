import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RemJobStore } from "../../../../packages/memory/src/sidecar/rem-job-store";
import { appendAuditEntryStrict, appendAuditEntrySync, recoverInterruptedMutationAttempts } from "../../../../packages/memory/src/engine/operations/runtime-audit-log";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "bounded-rem-logs-"));
	roots.push(root);
	return root;
}

it("compacts historical transitions, retaining pending jobs and two days of completion replay", async () => {
	const journal = join(fixture(), "rem-wave-jobs.jsonl");
	const now = new Date().toISOString();
	const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const row = (waveId: string, state: string, finishedAt: string | null) => JSON.stringify({
		payloadVersion: 1, waveId, correlationId: `corr-${waveId}`, scope: "persona:retention",
		requestedOperations: ["rem-update"], state, startedAt: finishedAt, finishedAt, stats: { operations: 7 },
	}) + "\n";
	writeFileSync(journal, row("old", "done", "2020-01-01T00:00:00.000Z").repeat(300)
		+ row("undated-terminal", "done", null) + row("pending", "running", null) + row("yesterday", "done", yesterday)
		+ row("today", "running", null) + row("today", "done", now));
	const store = await RemJobStore.open(journal);
	expect(readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line).waveId))
		.toEqual(["pending", "yesterday", "today"]);
	expect(store.nonTerminalJobs().map(job => job.job_id)).toEqual(["pending"]);
	expect((await RemJobStore.readCompletedJobs(journal)).map(job => [job.job_id, job.stats.operations]))
		.toEqual([["yesterday", 7], ["today", 7]]);
	for (let index = 0; index < 300; index++) await store.transition("pending", { state: "running" });
	expect(statSync(journal).size).toBeLessThan(80000);
	expect((await RemJobStore.open(journal)).get("today")?.stats.operations).toBe(7);
});

it("bounds both audit append paths without losing recent dispatch and completion evidence", async () => {
	const root = fixture();
	const audit = join(root, "audit.jsonl");
	writeFileSync(audit, JSON.stringify({ timestamp: new Date().toISOString(), event: "rem_trigger_evaluated",
		details: { row: "dispatch", correlation_id: "retained" } }) + "\n");
	appendFileSync(audit, "x".repeat(17 * 1024 * 1024) + "\n");
	expect(await appendAuditEntryStrict(root, { event: "rem_completed", resultStatus: "ok", details: { correlation_id: "retained" } })).toBe(true);
	expect(statSync(audit).size).toBeLessThan(16 * 1024 * 1024);
	expect(readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line).event))
		.toEqual(["rem_trigger_evaluated", "rem_completed"]);
	appendFileSync(audit, "x".repeat(17 * 1024 * 1024) + "\n");
	appendAuditEntrySync(root, { event: "startup", resultStatus: "ok" });
	expect(statSync(audit).size).toBeLessThan(16 * 1024 * 1024);
	expect(readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line).event))
		.toEqual(["rem_trigger_evaluated", "rem_completed", "startup"]);
});


it("keeps an unfinished mutation across audit compaction, including its UTF-8 subject", async () => {
	const root = fixture();
	const audit = join(root, "audit.jsonl");
	writeFileSync(audit, JSON.stringify({ timestamp: "2020-01-01T00:00:00.000Z", event: "memory_updated",
		decision: "mutation-attempt-open", details: { operation: "task_lifecycle_update", audit_phase: "started",
			audit_operation_id: "unfinished", mutation_writer: "task-lifecycle", mutation_subject: "项目" } }) + "\n");
	appendFileSync(audit, "x".repeat(17 * 1024 * 1024) + "\n");
	appendAuditEntrySync(root, { event: "startup", resultStatus: "ok" });
	expect(statSync(audit).size).toBeLessThan(16 * 1024 * 1024);
	const records = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(records[0].details.mutation_subject).toBe("项目");
	expect(await recoverInterruptedMutationAttempts(root)).toEqual(["unfinished"]);
});
