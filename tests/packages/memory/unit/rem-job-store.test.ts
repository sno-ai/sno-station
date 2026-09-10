/** @file rem-job-store.test.ts
 * @purpose Proves REM job transitions are append-only, durable, and restart-readable.
 * @boundary Real filesystem JSONL; no mocks or substitute storage.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemJobStore } from "../../../../apps/mem-claw/src/sidecar/rem-job-store.ts";

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

	it("surfaces a malformed complete journal record instead of discarding state", async () => {
		const journalPath = createJournalPath();
		writeFileSync(journalPath, '{"job_id":"malformed"}\n', "utf8");

		await expect(RemJobStore.open(journalPath)).rejects.toThrow(/invalid REM job journal/i);
	});
});
