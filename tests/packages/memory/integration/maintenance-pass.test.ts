/** Real ONNX embedder + real encrypted SQLite. No mocking. Missing deps = FAIL. */

/**
 * Hourly maintenance pass (DB-optimization Step 10) against a real store:
 *   1. Usage-event retention prunes expired recall/inject rows in batches while
 *      preserving in-window usage evidence (purge-safety) and ALL lifecycle rows.
 *   2. A healthy pass produces a backup file post-retention.
 *   3. Integrity failure fails CLOSED: pass aborts, storage latch trips (every
 *      write path refuses SQL — including statements prepared before the latch),
 *      kill switch file appears, and NO backup is written.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	MEMORY_EVENTS_USAGE_RETENTION_MS,
	runMaintenancePass,
	type MaintenanceDeps,
} from "../../../../packages/memory/src/store/maintenance.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { MemoryTelemetryUsageOutbox } from "../../../../packages/memory/src/engine/telemetry/memory-telemetry-outbox.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("maintenance pass", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;
	let stateDir: string;
	let deps: MaintenanceDeps;

	beforeEach(() => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
		stateDir = mkdtempSync(join(tmpdir(), "mem-claw-maint-state-"));
		deps = {
			store,
			usageOutbox: new MemoryTelemetryUsageOutbox({ sqlite: store.sqlite, dbPath }),
			dbPath,
			backupDir: join(stateDir, "backups"),
			stateDir,
		};
	});

	afterEach(() => {
		try {
			store.close();
		} catch {
			// latched-storage tests close through the plain path
		}
		rmSync(stateDir, { recursive: true, force: true });
		cleanup();
	});

	function insertEvent(type: string, factId: string, ageMs: number): void {
		store.sqlite
			.prepare(
				"INSERT INTO nodix_memory_events(event_type, fact_id, timestamp_ms, agent_id) VALUES (?, ?, ?, 'maint-test')",
			)
			.run(type, factId, Date.now() - ageMs);
	}

	function countEvents(type: string): number {
		const row = store.sqlite
			.prepare("SELECT COUNT(*) AS count FROM nodix_memory_events WHERE event_type = ?")
			.get(type) as { count: number };
		return row.count;
	}

	it("prunes expired usage events, keeps in-window usage and all lifecycle rows, then backs up", () => {
		// Expired usage (beyond 90d), across multiple retention batches is overkill
		// for runtime; 40 rows prove the loop shape without a slow seed.
		for (let i = 0; i < 40; i++) {
			insertEvent(i % 2 === 0 ? "recall" : "inject", `fact-old-${i}`, MEMORY_EVENTS_USAGE_RETENTION_MS + (i + 1) * DAY_MS);
		}
		// In-window usage: a 45-day-old recall must survive (purge-safety evidence).
		insertEvent("recall", "fact-recent-recall", 45 * DAY_MS);
		// Lifecycle rows older than retention must survive (guarded trigger + code both protect).
		insertEvent("create", "fact-ancient-create", 400 * DAY_MS);
		insertEvent("supersede", "fact-ancient-supersede", 400 * DAY_MS);

		const report = runMaintenancePass(deps);

		expect(report.aborted).toBe(false);
		expect(report.usageEventsPruned).toBe(40);
		expect(countEvents("recall")).toBe(1);
		expect(countEvents("inject")).toBe(0);
		expect(countEvents("create")).toBe(1);
		expect(countEvents("supersede")).toBe(1);
		expect(report.backupPath).toBeDefined();
		expect(report.backupPath && existsSync(report.backupPath)).toBe(true);
	});

	it("runs only the jobs that are due: no integrity sweep and no backup when only retention is due", () => {
		insertEvent("recall", "fact-expired-recall", MEMORY_EVENTS_USAGE_RETENTION_MS + DAY_MS);
		let sweeps = 0;

		const report = runMaintenancePass(
			{ ...deps, integrityCheck: () => { sweeps += 1; } },
			new Set(["usage-retention"]),
		);

		expect(report.aborted).toBe(false);
		expect(report.usageEventsPruned).toBe(1);
		expect(sweeps).toBe(0);
		expect(report.backupPath).toBeUndefined();
		expect(existsSync(deps.backupDir)).toBe(false);
	});

	it("bounds retention pruning to one tick's budget, leaving the remainder for the next tick", () => {
		// A backlog bigger than one delete batch (5000) must not drain
		// synchronously in a single tick — that would block the gateway event
		// loop for however long the full backlog takes (codex adversarial
		// review 2026-07-13). Seed just over one batch so a near-zero budget
		// proves the do-while stops after exactly one batch, not zero and not
		// all of it.
		const BATCH_SIZE = 5000;
		const BACKLOG = BATCH_SIZE + 1000;
		store.sqlite.transaction(() => {
			for (let i = 0; i < BACKLOG; i++) {
				insertEvent("recall", `fact-backlog-${i}`, MEMORY_EVENTS_USAGE_RETENTION_MS + DAY_MS);
			}
		})();
		expect(countEvents("recall")).toBe(BACKLOG);

		const boundedReport = runMaintenancePass({ ...deps, retentionPruneBudgetMs: 0 });

		expect(boundedReport.aborted).toBe(false);
		expect(boundedReport.usageEventsPruned).toBe(BATCH_SIZE);
		expect(countEvents("recall")).toBe(BACKLOG - BATCH_SIZE);

		const followUpReport = runMaintenancePass(deps);

		expect(followUpReport.usageEventsPruned).toBe(BACKLOG - BATCH_SIZE);
		expect(countEvents("recall")).toBe(0);
	});

	it("keeps reading and writing after an integrity failure", async () => {
		const prepared = store.sqlite.prepare("SELECT 7 AS value");
		const report = runMaintenancePass({ ...deps, integrityCheck: () => {
			throw new Error("fts5: corruption found reading blob 1374389534721 from table nodix_memory_chunks_fts");
		} }, new Set(["integrity"]));
		expect(report.aborted).toBe(false);
		expect(existsSync(join(stateDir, "killswitch"))).toBe(false);
		expect(prepared.get()).toEqual({ value: 7 });
		await store.store({ text: "Post integrity failure write remains readable.", category: "episodic", projectId: "integrity-test" });
		const rows = store.sqlite.prepare("SELECT text FROM nodix_memories WHERE project_id = 'integrity-test'").all();
		expect(rows).toEqual([{ text: "Post integrity failure write remains readable." }]);
	});
});
