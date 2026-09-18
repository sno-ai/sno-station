/** A wave carries both operations and used to report one sum, so "rem-update refused 175 rows"
 *  and "rem-update never ran" were the same record. `by_operation` is what separates them, and
 *  the persistence schema is `.strict()` — the shape that silently swallowed `measured` before. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RemJobStore } from "../../../../packages/sno-station-mem/src/sidecar/rem-job-store";

let root: string | undefined;
afterEach(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

type OperationEntry = NonNullable<
	Parameters<RemJobStore["transition"]>[1]["stats"]
>["by_operation"] extends ReadonlyArray<infer Entry> | undefined
	? Entry
	: never;

// Shaped after the scored run of 2026-08-13 (content_writer_weekly): replace applied one
// operation, update applied none. Every field differs between the two entries on purpose —
// equal numbers would still pass if the code collapsed both halves back into one value, which
// is the exact defect this field exists to prevent.
const REPLACE_ENTRY: OperationEntry = {
	operation: "rem-replace",
	applied_count: 1,
	actionable_candidate_count: 193,
	candidate_count: 96,
	parse_failure_count: 9,
	top_refusal_reasons: ["owned_by_restate", "no_retired_fact"],
	measured: {
		rows_considered: 96,
		pairs_built: 165,
		pair_cap_binding: false,
		model_calls: 209,
		model_tokens: 944_957,
		wall_ms: 94_000,
	},
};
const UPDATE_ENTRY: OperationEntry = {
	operation: "rem-update",
	applied_count: 0,
	actionable_candidate_count: 28,
	candidate_count: 56,
	parse_failure_count: 2,
	top_refusal_reasons: ["no_retired_fact", "mixed_clause_not_separable"],
	measured: {
		rows_considered: 56,
		pairs_built: 0,
		pair_cap_binding: false,
		model_calls: 31,
		model_tokens: 88_412,
		wall_ms: 9_400,
	},
};

async function completedWave(
	journal: string,
	operations: readonly string[],
	stats: Parameters<RemJobStore["transition"]>[1]["stats"],
): Promise<string> {
	const store = await RemJobStore.open(journal, () => {});
	const allocation = await store.createQueued(operations, "content_writer_weekly", "corr-split");
	await store.transition(allocation.job.job_id, {
		state: "running",
		started_at: new Date().toISOString(),
	});
	await store.transition(allocation.job.job_id, {
		state: "done",
		finished_at: new Date().toISOString(),
		stats,
	});
	return allocation.job.job_id;
}

it("keeps both operations' numbers apart across the durable journal", async () => {
	root = mkdtempSync(join(tmpdir(), "rem-split-"));
	const journal = join(root, "rem-wave-jobs.jsonl");

	const waveId = await completedWave(journal, ["rem-replace", "rem-update"], {
		operations: 1,
		applied_count: 1,
		actionable_candidate_count: 221,
		by_operation: [REPLACE_ENTRY, UPDATE_ENTRY],
	});

	// Reopened from disk, never the in-memory map: a schema that rejects `by_operation` throws
	// before the line is appended, so only a fresh read proves the line exists at all.
	const reopened = await RemJobStore.open(journal, () => {});
	const byOperation = reopened.get(waveId)?.stats.by_operation;
	expect(byOperation).toEqual([REPLACE_ENTRY, UPDATE_ENTRY]);

	// The reading that cost a day was "update applied nothing, so update never ran". These two
	// assertions are what makes that reading impossible from the record alone.
	const update = byOperation?.find((entry) => entry.operation === "rem-update");
	expect(update?.applied_count).toBe(0);
	expect(update?.measured.model_calls).toBeGreaterThan(0);
});

it("reports a single-operation wave as one entry matching the flat totals", async () => {
	root = mkdtempSync(join(tmpdir(), "rem-split-"));
	const journal = join(root, "rem-wave-jobs.jsonl");

	const waveId = await completedWave(journal, ["rem-replace"], {
		operations: REPLACE_ENTRY.applied_count,
		applied_count: REPLACE_ENTRY.applied_count,
		actionable_candidate_count: REPLACE_ENTRY.actionable_candidate_count,
		by_operation: [REPLACE_ENTRY],
	});

	const reopened = await RemJobStore.open(journal, () => {});
	const stats = reopened.get(waveId)?.stats;
	expect(stats?.by_operation).toHaveLength(1);
	expect(stats?.by_operation?.[0]?.applied_count).toBe(stats?.applied_count);
	expect(stats?.by_operation?.[0]?.actionable_candidate_count).toBe(
		stats?.actionable_candidate_count,
	);
});

it("refuses an operation entry carrying a field the schema does not declare", async () => {
	root = mkdtempSync(join(tmpdir(), "rem-split-"));
	const journal = join(root, "rem-wave-jobs.jsonl");
	const store = await RemJobStore.open(journal, () => {});
	const allocation = await store.createQueued(["rem-replace"], "content_writer_weekly", "corr-x");
	await store.transition(allocation.job.job_id, {
		state: "running",
		started_at: new Date().toISOString(),
	});

	// The cast is the point, not a shortcut: the `measured` incident had a correct-looking
	// declared type over a schema that did not know the key, and nothing went red. This asserts
	// the element object is genuinely `.strict()`, so the next undeclared field fails loudly.
	const rogue = [{ ...REPLACE_ENTRY, applied_fraction: 0.5 }] as unknown as NonNullable<
		Parameters<RemJobStore["transition"]>[1]["stats"]
	>["by_operation"];
	await expect(
		store.transition(allocation.job.job_id, {
			state: "done",
			finished_at: new Date().toISOString(),
			stats: { operations: 1, by_operation: rogue },
		}),
	).rejects.toThrow(/applied_fraction/);

	// The refusal must also leave nothing behind: a rejected wave that still appended its line
	// would put an unreadable record in the journal every consumer has to step over.
	const reopened = await RemJobStore.open(journal, () => {});
	expect(reopened.get(allocation.job.job_id)?.state).toBe("running");
});
