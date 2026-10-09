/** @file rem-job-store.test.ts
 * @purpose Proves REM job transitions are append-only, durable, and restart-readable.
 * @boundary Real filesystem JSONL; no mocks or substitute storage.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemJobStore } from "../../../../packages/memory/src/sidecar/rem-job-store.ts";

const cleanupPaths: string[] = [];

function createJournalPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "mem-claw-rem-jobs-"));
	cleanupPaths.push(directory);
	return join(directory, "rem-wave-jobs.jsonl");
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("REM job store", () => {
	it("reuses a running merged job when a tick requests one of its operations", async () => {
		const journalPath = createJournalPath();
		writeFileSync(journalPath, `${JSON.stringify({
			payloadVersion: 1,
			waveId: "rem-wave-merged-repeat",
			correlationId: "rem-auto-merged-repeat",
			scope: "persona:merged-repeat",
			requestedOperations: ["rem-replace"],
			state: "queued",
			startedAt: null,
			finishedAt: null,
			stats: { operations: 0 },
		})}\n`);
		const store = await RemJobStore.open(journalPath);
		const merged = await store.createQueued(
			"rem-update", "persona:merged-repeat", "rem-auto-merged-repeat",
		);
		expect(merged.job.requested_operations).toEqual(["rem-replace", "rem-update"]);
		await store.transition("rem-wave-merged-repeat", { state: "running" });

		const repeated = await store.createQueued(
			"rem-replace", "persona:merged-repeat", "rem-auto-merged-repeat",
		);

		expect.soft(repeated.created).toBe(false);
		expect.soft(repeated.job.job_id).toBe("rem-wave-merged-repeat");
		expect.soft(store.nonTerminalJobs()).toHaveLength(1);
	});

	it("reuses the running automatic job on a second tick and after completion", async () => {
		const journalPath = createJournalPath();
		writeFileSync(journalPath, `${JSON.stringify({
			payloadVersion: 1,
			waveId: "rem-wave-automatic-repeat",
			correlationId: "rem-auto-daily-repeat",
			scope: "persona:automatic-repeat",
			requestedOperations: ["rem-replace", "rem-update"],
			state: "queued",
			startedAt: null,
			finishedAt: null,
			stats: { operations: 0 },
		})}\n`);
		const store = await RemJobStore.open(journalPath);
		await store.transition("rem-wave-automatic-repeat", { state: "running" });
		const repeated = await store.createQueued(
			["rem-update", "rem-replace"], "persona:automatic-repeat", "rem-auto-daily-repeat",
		);
		expect.soft(repeated.created).toBe(false);
		expect.soft(repeated.job.job_id).toBe("rem-wave-automatic-repeat");
		expect.soft(store.nonTerminalJobs()).toHaveLength(1);
		await store.transition("rem-wave-automatic-repeat", { state: "done" });
		const completed = await store.createQueued(
			["rem-update", "rem-replace"], "persona:automatic-repeat", "rem-auto-daily-repeat",
		);
		expect(completed.created).toBe(false);
		expect(completed.job.job_id).toBe("rem-wave-automatic-repeat");
		expect(store.nonTerminalJobs()).toHaveLength(0);
		expect(readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(3);
	});

	it("never runs a failed automatic job again for the same pass, even after the service restarts", async () => {
		// Only a skipped job is started again. A pass that failed keeps its job, so the next dispatches of that pass
		// spend nothing; the automatic trigger therefore counts only refused passes toward the day's tries.
		const journalPath = createJournalPath();
		const store = await RemJobStore.open(journalPath);
		const first = await store.createQueued(["rem-replace"], "persona:failed-repeat", "rem-auto-daily-failed");
		await store.transition(first.job.job_id, { state: "running" });
		await store.transition(first.job.job_id, { state: "failed", error: "REM LLM calls all failed" });
		for (const opened of [store, await RemJobStore.open(journalPath)]) {
			const again = await opened.createQueued(["rem-replace"], "persona:failed-repeat", "rem-auto-daily-failed");
			expect({ created: again.created, job: again.job.job_id, waiting: opened.nonTerminalJobs().length })
				.toEqual({ created: false, job: first.job.job_id, waiting: 0 });
		}
	});

	it("rejects create and state updates when journal append or sync fails", async () => {
		const results: PromiseSettledResult<unknown>[] = [];
		for (const device of ["/dev/full", "/dev/null"]) {
			const journalPath = createJournalPath();
			const store = await RemJobStore.open(journalPath);
			const { job } = await store.createQueued("rem-update", "persona:disk-error", "corr-original");
			rmSync(journalPath);
			symlinkSync(device, journalPath);

			results.push(...await Promise.allSettled([
				store.createQueued("rem-update", "persona:disk-error", "corr-new"),
				store.transition(job.job_id, { state: "running" }),
			]));
			expect.soft(store.nonTerminalJobs()).toHaveLength(1);
			expect.soft(store.get(job.job_id)?.state).toBe("queued");
		}
		expect(results).toMatchObject([
			{ status: "rejected", reason: { code: "ENOSPC" } },
			{ status: "rejected", reason: { code: "ENOSPC" } },
			{ status: "rejected", reason: { code: "EINVAL" } },
			{ status: "rejected", reason: { code: "EINVAL" } },
		]);
	});

	it("creates a complete ordered wave in one durable append", async () => {
		const journalPath = createJournalPath();
		const store = await RemJobStore.open(journalPath);

		const allocation = await store.createQueued(
			["rem-update", "rem-replace"],
			"persona:atomic-wave",
			"corr-atomic-wave",
		);

		expect(allocation).toMatchObject({
			created: true,
			job: { requested_operations: ["rem-replace", "rem-update"] },
		});
		expect(readFileSync(journalPath, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("persists the correlation id in every durable transition", async () => {
		const journalPath = createJournalPath();
		const store = await RemJobStore.open(journalPath);

		const { job: queued } = await store.createQueued(
			"rem-update",
			"persona:test-68a19d8c",
			"corr-job-019f8da3",
		);
		await store.transition(queued.job_id, {
			state: "running",
			started_at: "2026-07-23T08:00:00.000Z",
		});

		const records = readFileSync(journalPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { correlationId?: string });
		expect(records.map((record) => record.correlationId)).toEqual([
			"corr-job-019f8da3",
			"corr-job-019f8da3",
		]);
	});

	it("settles the queued append before returning a job id", async () => {
		const journalPath = createJournalPath();
		const store = await RemJobStore.open(journalPath);

		const { job: queued } = await store.createQueued(
			"rem-update",
			"persona:test-68a19d8c",
			"corr-queued-019f8da3",
		);
		const lines = readFileSync(journalPath, "utf8").trim().split("\n");

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			waveId: queued.job_id,
			state: "queued",
			requestedOperations: ["rem-update"],
			scope: "persona:test-68a19d8c",
		});
	});

	it("reopens with the latest transition for every job", async () => {
		const journalPath = createJournalPath();
		const first = await RemJobStore.open(journalPath);
		const { job: queued } = await first.createQueued(
			"rem-update",
			"persona:test-68a19d8c",
			"corr-reopen-019f8da3",
		);
		await first.transition(queued.job_id, {
			state: "running",
			started_at: "2026-07-23T06:40:00.000Z",
		});
		await first.transition(queued.job_id, {
			state: "done",
			finished_at: "2026-07-23T06:40:01.000Z",
			stats: { operations: 0 },
		});

		const reopened = await RemJobStore.open(journalPath);

		expect(reopened.get(queued.job_id)).toMatchObject({
			state: "done",
			type: "rem-update",
			scope: "persona:test-68a19d8c",
			stats: { operations: 0 },
		});
		expect(reopened.nonTerminalJobs()).toEqual([]);
		expect(readFileSync(journalPath, "utf8").trim().split("\n")).toHaveLength(3);
	});

	it("serializes concurrent queued appends into valid JSONL records", async () => {
		const journalPath = createJournalPath();
		const store = await RemJobStore.open(journalPath);

		const allocations = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				store.createQueued(
					"rem-update",
					`persona:test-68a19d8c-${index}`,
					`corr-concurrent-${index}`,
				),
			),
		);
		const records = readFileSync(journalPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { waveId: string });

		expect(records).toHaveLength(12);
		expect(new Set(records.map((record) => record.waveId))).toEqual(
			new Set(allocations.map(({ job }) => job.job_id)),
		);
	});

	it("discards only a torn final record and preserves complete records", async () => {
		const journalPath = createJournalPath();
		const first = await RemJobStore.open(journalPath);
		const { job: queued } = await first.createQueued(
			"rem-update",
			"persona:test-68a19d8c",
			"corr-torn-019f8da3",
		);
		appendFileSync(journalPath, '{"job_id":"truncated"', "utf8");

		const reopened = await RemJobStore.open(journalPath);

		expect(reopened.get(queued.job_id)).toMatchObject({ state: "queued" });
		expect(readFileSync(journalPath, "utf8")).not.toContain("truncated");
	});

	it("discards a syntactically valid final record when its newline was not committed", async () => {
		const journalPath = createJournalPath();
		const first = await RemJobStore.open(journalPath);
		const { job: queued } = await first.createQueued(
			"rem-update",
			"persona:test-68a19d8c",
			"corr-uncommitted-019f8da3",
		);
		appendFileSync(
			journalPath,
			JSON.stringify({
				...queued,
				state: "done",
				finished_at: "2026-07-23T07:20:00.000Z",
			}),
			"utf8",
		);

		const reopened = await RemJobStore.open(journalPath);

		expect(reopened.get(queued.job_id)).toMatchObject({ state: "queued" });
		expect(readFileSync(journalPath, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("keeps valid jobs around malformed complete records and leaves the journal intact", async () => {
		const journalPath = createJournalPath();
		const first = await RemJobStore.open(journalPath);
		const { job: queued } = await first.createQueued("rem-update", "persona:queued", "corr-queued");
		const badLine = '{"job_id":"malformed"}\n';
		appendFileSync(journalPath, badLine, "utf8");
		const { job: running } = await first.createQueued("rem-replace", "persona:running", "corr-running");
		await first.transition(running.job_id, { state: "running" });
		const reopened = await RemJobStore.open(journalPath);
		expect(reopened.nonTerminalJobs().map(job => job.state)).toEqual(["queued", "running"]);
		expect(reopened.get(queued.job_id)?.state).toBe("queued");
		expect(reopened.get(running.job_id)?.state).toBe("running");
		expect(readFileSync(journalPath, "utf8").trim().split("\n")).toHaveLength(4);
		expect(readFileSync(journalPath, "utf8").split("\n")[1]).toBe('{"job_id":"malformed"}');
	});
});
