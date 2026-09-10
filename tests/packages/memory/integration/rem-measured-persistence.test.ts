/** The wave measurements must survive the durable journal, or the runner's liveness check can
 *  never see them. The persistence schema is `.strict()` and rejected them silently at first. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RemJobStore } from "../../../../packages/sno-station-mem/src/sidecar/rem-job-store";

let root: string | undefined;
afterEach(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

it("persists the wave measurements and reads them back from a reopened journal", async () => {
	root = mkdtempSync(join(tmpdir(), "rem-jobstore-"));
	const journal = join(root, "rem-wave-jobs.jsonl");
	const measured = { rows_considered: 209, model_calls: 270, model_tokens: 1_500_000, wall_ms: 900_000 };

	const store = await RemJobStore.open(journal, () => {});
	const allocation = await store.createQueued(["rem-replace"], "scope-a", "corr-1");
	await store.transition(allocation.job.job_id, { state: "running", started_at: new Date().toISOString() });
	await store.transition(allocation.job.job_id, {
		state: "done",
		finished_at: new Date().toISOString(),
		stats: { operations: 0, applied_count: 0, measured },
	});

	// Reopened from disk, not read from the in-memory map: a schema that rejects `measured` on
	// write throws before the line is appended, and only a fresh read proves the line exists.
	const reopened = await RemJobStore.open(journal, () => {});
	expect(reopened.get(allocation.job.job_id)?.stats.measured).toEqual(measured);
});
