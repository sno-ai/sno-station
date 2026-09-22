import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RemJobStore } from "../../../../packages/memory/src/sidecar/rem-job-store";
import { recoverInterruptedMutationAttempts } from "../../../../packages/memory/src/engine/operations/runtime-audit-log";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
	const root = await fsp.mkdtemp(join(tmpdir(), "streaming-recovery-"));
	roots.push(root);
	return root;
}

// Keep real files and parsing; impose the same failure as Node's string-size limit
// only at the whole-file API, without allocating a gigabyte in the test runner.
function rejectWholeFileReads(path: string): void {
	const read = fsp.readFile;
	const readSync = fs.readFileSync;
	vi.spyOn(fsp, "readFile").mockImplementation((...args: Parameters<typeof read>) => {
		if (String(args[0]) === path) throw new RangeError("Invalid string length");
		return read(...args);
	});
	vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof readSync>) => {
		if (String(args[0]) === path) throw new RangeError("Invalid string length");
		return readSync(...args);
	});
}

it("recovers an open mutation from a real audit file without whole-file reads", async () => {
	const root = await fixture();
	const path = join(root, "audit.jsonl");
	await fsp.writeFile(path, `${JSON.stringify({ event: "memory_updated", decision: "mutation-attempt-open", details: {
		operation: "task_lifecycle_update", audit_phase: "started", audit_operation_id: "orphan",
		mutation_writer: "task-lifecycle",
	} })}\n{"unfinished":`);
	rejectWholeFileReads(path);
	expect(await recoverInterruptedMutationAttempts(root)).toEqual(["orphan"]);
});

it("loads durable jobs and truncates the incomplete UTF-8 tail without whole-file reads", async () => {
	const root = await fixture();
	const path = join(root, "rem-wave-jobs.jsonl");
	const record = { payloadVersion: 1, waveId: "wave-one", correlationId: "corr-one", scope: "项目",
		requestedOperations: ["rem-update"], state: "running", startedAt: "2026-09-17T00:00:00.000Z",
		finishedAt: null, stats: { operations: 0 } };
	const durable = `${JSON.stringify(record)}\n`;
	await fsp.writeFile(path, `${durable}{"partial":"尾`);
	rejectWholeFileReads(path);
	const store = await RemJobStore.open(path);
	expect(store.get("wave-one")).toMatchObject({ state: "running", scope: "项目", stats: { operations: 0 } });
	expect((await fsp.stat(path)).size).toBe(Buffer.byteLength(durable));
});
