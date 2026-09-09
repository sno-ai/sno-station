/** @file maintenance.ts
 * @purpose Hourly ordered maintenance pass: integrity gate, outbox drain, usage-event
 *   retention, FTS merge, planner statistics, backup.
 * @boundary Owns the gateway maintenance timer; storage failure latches fail-closed.
 * @see backup.ts, memory-telemetry-outbox.ts, sqlite-runtime.ts.
 */

import { createHash, type Hash } from "node:crypto";
import { createLogger } from "@snoai/utils/logger";
import { runIntegrityCheck } from "@snoai/sno-station-core-crypto";
import { BACKUP_INTERVAL_MS } from "../../config/index";
import {
	activateKillSwitch,
	appendAuditEntry,
	deactivateKillSwitch,
	readKillSwitchState,
} from "../engine/operations/runtime-audit-log";
import { runBackup } from "./backup";
import type { MemoryStore } from "./memory-store-base";
import {
	evaluateRemAutomaticTriggers,
	readRemAutomaticOperations,
} from "../sidecar/rem-trigger";
import { getMemClawStateDir } from "../engine/shared/paths";
import { recordMemoryTelemetryIncident } from "../engine/telemetry/memory-telemetry-incidents";
import type { MemoryTelemetryUsageOutbox } from "../engine/telemetry/memory-telemetry-outbox";

const log = createLogger("mem-claw:maintenance");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Usage events ('recall'/'inject') older than this are pruned from the
 * nodix_memory_events ledger. MUST stay >= the purge-safety recall lookback
 * (RECENT_RECALL_WINDOW_MS, 30 d) — coupled by a unit test — so retention can
 * never erase evidence the cascade-purge preview depends on. Lifecycle events
 * are never pruned (database-enforced by the guarded delete trigger).
 */
export const MEMORY_EVENTS_USAGE_RETENTION_MS: number = 90 * DAY_MS;

/** Quarantined outbox rows older than this are deleted by the maintenance pass. */
export const OUTBOX_QUARANTINE_RETENTION_MS: number = 30 * DAY_MS;

/** First full-integrity sweep runs shortly after boot, then hourly. */
export const MAINTENANCE_FIRST_TICK_DELAY_MS = 60_000;

const OUTBOX_DRAIN_BUDGET_MS = 30_000;
const RETENTION_DELETE_BATCH = 5000;
const RETENTION_PRUNE_BUDGET_MS = 5_000;
const FTS_MERGE_MAX_ITERATIONS = 10;
/** Above this, the integrity sweep is worth flagging as an operational cost. */
const INTEGRITY_SWEEP_SLOW_WARN_MS = 500;

export interface MaintenanceDeps {
	store: MemoryStore;
	usageOutbox?: MemoryTelemetryUsageOutbox;
	dbPath: string;
	backupDir: string;
	/** mem-claw state dir — the kill-switch file lives here. */
	stateDir: string;
	/**
	 * Integrity sweep implementation; defaults to sno-station-core-crypto's runIntegrityCheck.
	 * Injectable so the fail-closed integration test can drive the failure path
	 * (pre-declared in the DB-optimization plan's test design).
	 */
	integrityCheck?: (rawDb: Parameters<typeof runIntegrityCheck>[0]) => void;
	/**
	 * Wall-clock budget for usage-event retention pruning per pass; defaults to
	 * RETENTION_PRUNE_BUDGET_MS. Injectable so a test can force early cutoff of
	 * a large backlog without waiting on the real budget (codex adversarial
	 * review 2026-07-13; same seam pattern as integrityCheck above).
	 */
	retentionPruneBudgetMs?: number;
}

export interface MaintenanceReport {
	aborted: boolean;
	integrityRecovery: "none" | "recovered" | "retained";
	integrityMs: number;
	outboxFlushed: number;
	quarantinePruned: number;
	usageEventsPruned: number;
	backupPath: string | undefined;
}

type RawIntegrityDb = Parameters<typeof runIntegrityCheck>[0];

function integrityMessages(rawDb: RawIntegrityDb, table?: string): string[] {
	const pragma = table ? `integrity_check('${table}')` : "integrity_check";
	const rows = rawDb.pragma(pragma) as Array<Record<string, unknown>>;
	return rows
		.map((row) => row["integrity_check"])
		.filter((value): value is string => typeof value === "string");
}

function isCleanIntegrityResult(messages: string[]): boolean {
	return messages.length === 1 && messages[0] === "ok";
}

type SourceTable = "nodix_memories" | "nodix_memory_chunks";

function hashInventoryRows(hash: Hash, rawDb: RawIntegrityDb, table: SourceTable): void {
	hash.update(`${table}\0`);
	const rows = rawDb
		.prepare<[], Record<string, unknown>>(`SELECT rowid, * FROM ${table} ORDER BY rowid`)
		.iterate();
	for (const row of rows) hash.update(JSON.stringify(row)).update("\0");
}

function sourceInventory(rawDb: RawIntegrityDb): string {
	const hash = createHash("sha256");
	hashInventoryRows(hash, rawDb, "nodix_memories");
	hashInventoryRows(hash, rawDb, "nodix_memory_chunks");
	return hash.digest("hex");
}

function isDerivedFtsOnlyFailure(rawDb: RawIntegrityDb): boolean {
	const fullMessages = integrityMessages(rawDb);
	if (
		isCleanIntegrityResult(fullMessages) ||
		fullMessages.some((message) => !/fts5:.*nodix_memory_chunks_fts/i.test(message))
	) {
		return false;
	}
	if (!isCleanIntegrityResult(integrityMessages(rawDb, "nodix_memories"))) return false;
	if (!isCleanIntegrityResult(integrityMessages(rawDb, "nodix_memory_chunks"))) return false;
	try {
		rawDb.exec(
			"INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rank) VALUES('integrity-check', 1)",
		);
		return false;
	} catch {
		return true;
	}
}

function recordIntegrityAudit(
	stateDir: string,
	decision: "rebuild_started" | "recovered" | "retained",
	resultStatus: "ok" | "error",
	details?: Record<string, unknown>,
): void {
	appendAuditEntry(stateDir, {
		event: "storage_integrity",
		resultStatus,
		decision,
		details,
	});
}

function tryRecoverDerivedFts(deps: MaintenanceDeps): boolean {
	return deps.store.sqlite.runRecoveryOperation((rawDb) => recoverDerivedFts(deps, rawDb));
}

function recoverDerivedFts(deps: MaintenanceDeps, rawDb: RawIntegrityDb): boolean {
	let inventoryBefore: string;
	try {
		if (!isDerivedFtsOnlyFailure(rawDb)) {
			recordIntegrityAudit(deps.stateDir, "retained", "error", {
				reason: "integrity failure is not provably confined to the derived FTS index",
			});
			return false;
		}
		inventoryBefore = sourceInventory(rawDb);
	} catch (error) {
		recordIntegrityAudit(deps.stateDir, "retained", "error", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return false;
	}

	recordIntegrityAudit(deps.stateDir, "rebuild_started", "ok");
	log.warn("rebuilding derived FTS index after verified derived-only integrity failure", undefined, {
		event_name: "mem_claw.maintenance.rebuilding.derived.fts.index.after.verified.derived.only.integrity.fai",
		file: "apps/mem-claw/src/storage/maintenance.ts",
		function: "recoverDerivedFts",
		site_id: "maintenance.recoverDerivedFts.753697bd94",
	});
	try {
		rawDb.exec("INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts) VALUES('rebuild')");
		const inventoryAfter = sourceInventory(rawDb);
		if (inventoryAfter !== inventoryBefore) {
			throw new Error("source inventory changed during derived FTS rebuild");
		}
		runIntegrityCheck(rawDb);
		rawDb.exec(
			"INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rank) VALUES('integrity-check', 1)",
		);
		recordIntegrityAudit(deps.stateDir, "recovered", "ok");
		log.info("derived FTS index rebuilt and integrity reverified", undefined, {
			event_name: "mem_claw.maintenance.derived.fts.index.rebuilt.and.integrity.reverified",
			file: "apps/mem-claw/src/storage/maintenance.ts",
			function: "recoverDerivedFts",
			site_id: "maintenance.recoverDerivedFts.2cf5f62053",
		});
		return true;
	} catch (error) {
		recordIntegrityAudit(deps.stateDir, "retained", "error", {
			reason: error instanceof Error ? error.message : String(error),
		});
		log.error("derived FTS recovery failed; storage remains latched", { error }, {
			event_name: "mem_claw.maintenance.derived.fts.recovery.failed.storage.remains.latched",
			file: "apps/mem-claw/src/storage/maintenance.ts",
			function: "recoverDerivedFts",
			site_id: "maintenance.recoverDerivedFts.c07ad948a2",
		});
		return false;
	}
}

/**
 * Fail-closed reaction to a detected integrity failure: record the incident
 * (before latching — it is the last write this handle accepts), latch every
 * SQL entry point on the store's connection, and raise the kill switch so
 * tools and hooks stop at their existing entry checks. Backups are NOT taken
 * and old backups are NOT pruned, preserving the last known-good snapshots.
 */
function failClosed(deps: MaintenanceDeps, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	try {
		recordMemoryTelemetryIncident(deps.store.sqlite, {
			incidentType: "storage_integrity_check_failed",
			severity: "error",
			message: "database integrity check failed; storage latched fail-closed",
			payload: { error_code: "integrity_check_failed", last_error: message.slice(0, 500) },
		});
	} catch {
		// Incident persistence is best-effort on a damaged database.
	}
	deps.store.sqlite.markFailed(`integrity check failed: ${message}`);
	try {
		activateKillSwitch(deps.stateDir, `db integrity failure: ${message.slice(0, 200)}`, "maintenance");
	} catch (killSwitchError) {
		log.error("failed to raise kill switch after integrity failure", { error: killSwitchError }, {
			event_name: "mem_claw.maintenance.failed.to.raise.kill.switch.after.integrity.failure",
			file: "apps/mem-claw/src/storage/maintenance.ts",
			function: "failClosed",
			site_id: "maintenance.failClosed.b9166d3fe2",
		});
	}
	log.error("storage latched fail-closed after integrity failure", { error: message }, {
		event_name: "mem_claw.maintenance.storage.latched.fail.closed.after.integrity.failure",
		file: "apps/mem-claw/src/storage/maintenance.ts",
		function: "failClosed",
		site_id: "maintenance.failClosed.dd7955e647",
	});
}

/**
 * Bounded catch-up: a backlog left by a maintenance gap or a first-time
 * retention rollout can be far larger than one tick's budget. Deleting it
 * all synchronously would block the gateway event loop for minutes (codex
 * adversarial review 2026-07-13). Leave the remainder for later ticks —
 * safe, since usage-event retention is a hygiene job, not a safety
 * invariant (the purge-safety recall lookback only needs the last 30 days,
 * well inside this 90-day window either way).
 */
function pruneExpiredUsageEvents(store: MemoryStore, now: number, budgetMs: number): number {
	const cutoff = now - MEMORY_EVENTS_USAGE_RETENTION_MS;
	const statement = store.sqlite.prepare(
		`DELETE FROM nodix_memory_events
		 WHERE id IN (
		   SELECT id FROM nodix_memory_events
		   WHERE event_type IN ('recall', 'inject') AND timestamp_ms < ?
		   LIMIT ${RETENTION_DELETE_BATCH}
		 )`,
	);
	// do-while: always run at least one batch so a near-zero budget still makes
	// forward progress every tick instead of starving the backlog forever.
	const deadline = Date.now() + budgetMs;
	let pruned = 0;
	do {
		const result = statement.run(cutoff) as { changes?: number };
		const changes = result.changes ?? 0;
		pruned += changes;
		if (changes === 0) break;
	} while (Date.now() < deadline);
	return pruned;
}

function mergeFtsSegments(store: MemoryStore): void {
	if (!store.hasFtsSupport) return;
	const statement = store.sqlite.prepare(
		"INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rank) VALUES('merge', 500)",
	);
	for (let i = 0; i < FTS_MERGE_MAX_ITERATIONS; i++) {
		const result = statement.run() as { changes?: number };
		if ((result.changes ?? 0) === 0) break;
	}
}

/**
 * Ordered maintenance pass. Step 0 (integrity) gates everything: on failure the
 * pass aborts fail-closed. Steps 1–4 are individually best-effort.
 */
export function runMaintenancePass(deps: MaintenanceDeps): MaintenanceReport {
	const report: MaintenanceReport = {
		aborted: false,
		integrityRecovery: "none",
		integrityMs: 0,
		outboxFlushed: 0,
		quarantinePruned: 0,
		usageEventsPruned: 0,
		backupPath: undefined,
	};
	if (deps.store.closed) {
		report.aborted = true;
		log.info("stopping maintenance for closed or replaced runtime", { dbPath: deps.dbPath }, {
			event_name: "mem_claw.maintenance.stopping.maintenance.for.closed.or.replaced.runtime",
			file: "apps/mem-claw/src/storage/maintenance.ts",
			function: "runMaintenancePass",
			site_id: "maintenance.runMaintenancePass.747b7cbef0",
		});
		return report;
	}
	const now = Date.now();
	const priorKillSwitch = readKillSwitchState(deps.stateDir);

	// 0. Full-page integrity sweep FIRST — nothing else may touch a damaged DB.
	// Runs synchronously on better-sqlite3 (no async driver API exists), so it
	// blocks the gateway event loop for its duration. Accepted: SQLCipher
	// verifies each page's HMAC at read time regardless, so a corrupt page can
	// never be silently served even without this sweep — this is early-warning
	// defense-in-depth, not the only guard. If INTEGRITY_SWEEP_SLOW_WARN_MS
	// starts firing routinely as the database grows, move this to a
	// worker_thread with its own read-only connection (codex adversarial
	// review 2026-07-13; follow-up, not done here).
	const integrityStart = Date.now();
	try {
		const sweep = deps.integrityCheck ?? runIntegrityCheck;
		// $client is typed as the wrapper interface but holds the raw driver
		// Database at runtime (drizzle was constructed over sqlite.raw) — the
		// narrow assertion crosses that validated boundary.
		sweep(deps.store.db.$client as unknown as Parameters<typeof runIntegrityCheck>[0]);
		report.integrityMs = Date.now() - integrityStart;
		if (priorKillSwitch.active && priorKillSwitch.activatedBy === "maintenance") {
			deactivateKillSwitch(deps.stateDir);
			report.integrityRecovery = "recovered";
			recordIntegrityAudit(deps.stateDir, "recovered", "ok", {
				reason: "clean integrity sweep after restart",
			});
			log.info("cleared maintenance integrity latch after clean restart sweep", undefined, {
				event_name: "mem_claw.maintenance.cleared.maintenance.integrity.latch.after.clean.restart.sweep",
				file: "apps/mem-claw/src/storage/maintenance.ts",
				function: "runMaintenancePass",
				site_id: "maintenance.runMaintenancePass.db1242ce1c",
			});
		}
		if (report.integrityMs > INTEGRITY_SWEEP_SLOW_WARN_MS) {
			log.warn("integrity sweep is blocking the event loop for longer than expected", {
				integrityMs: report.integrityMs,
			}, {
				event_name: "mem_claw.maintenance.integrity.sweep.is.blocking.the.event.loop.for.longer.than.expected",
				file: "apps/mem-claw/src/storage/maintenance.ts",
				function: "runMaintenancePass",
				site_id: "maintenance.runMaintenancePass.4ae162dc73",
			});
		}
	} catch (error) {
		failClosed(deps, error);
		if (tryRecoverDerivedFts(deps)) {
			if (!priorKillSwitch.active || priorKillSwitch.activatedBy === "maintenance") {
				deactivateKillSwitch(deps.stateDir);
			} else if (!priorKillSwitch.corrupt) {
				// Recovery temporarily claims the kill switch; restore a valid earlier pause.
				activateKillSwitch(
					deps.stateDir,
					priorKillSwitch.reason,
					priorKillSwitch.activatedBy,
				);
			}
			deps.store.sqlite.clearFailedAfterVerifiedRecovery();
			report.integrityRecovery = "recovered";
			report.integrityMs = Date.now() - integrityStart;
		} else {
			report.integrityRecovery = "retained";
			report.aborted = true;
			return report;
		}
	}

	// 1. Outbox drain (bounded catch-up) + quarantine hygiene.
	if (deps.usageOutbox) {
		try {
			report.outboxFlushed = deps.usageOutbox.drainPending(OUTBOX_DRAIN_BUDGET_MS).inserted;
			report.quarantinePruned = deps.usageOutbox.pruneQuarantined(
				now - OUTBOX_QUARANTINE_RETENTION_MS,
			);
		} catch (error) {
			log.warn("outbox maintenance failed", { error }, {
				event_name: "mem_claw.maintenance.outbox.maintenance.failed",
				file: "apps/mem-claw/src/storage/maintenance.ts",
				function: "runMaintenancePass",
				site_id: "maintenance.runMaintenancePass.c72575daaa",
			});
		}
	}

	// 2. Usage-event retention (lifecycle events are trigger-protected).
	try {
		report.usageEventsPruned = pruneExpiredUsageEvents(
			deps.store,
			now,
			deps.retentionPruneBudgetMs ?? RETENTION_PRUNE_BUDGET_MS,
		);
	} catch (error) {
		log.warn("usage-event retention failed", { error }, {
			event_name: "mem_claw.maintenance.usage.event.retention.failed",
			file: "apps/mem-claw/src/storage/maintenance.ts",
			function: "runMaintenancePass",
			site_id: "maintenance.runMaintenancePass.ef7a1e225c",
		});
	}

	// 3. FTS segment merge keeps keyword-search b-trees compact after write bursts.
	try {
		mergeFtsSegments(deps.store);
	} catch (error) {
		log.warn("fts merge failed", { error }, {
			event_name: "mem_claw.maintenance.fts.merge.failed",
			file: "apps/mem-claw/src/storage/maintenance.ts",
			function: "runMaintenancePass",
			site_id: "maintenance.runMaintenancePass.90f01cc543",
		});
	}

	// 4. Bounded planner-statistics refresh.
	try {
		deps.store.sqlite.exec("PRAGMA analysis_limit=400");
		deps.store.sqlite.exec("PRAGMA optimize");
	} catch (error) {
		log.warn("pragma optimize failed", { error }, {
			event_name: "mem_claw.maintenance.pragma.optimize.failed",
			file: "apps/mem-claw/src/storage/maintenance.ts",
			function: "runMaintenancePass",
			site_id: "maintenance.runMaintenancePass.3a7c9e73cf",
		});
	}

	// 5. Snapshot backup AFTER retention so the copy is post-prune.
	try {
		report.backupPath = runBackup(deps.dbPath, deps.backupDir);
	} catch (error) {
		log.warn("periodic backup failed", { error }, {
			event_name: "mem_claw.maintenance.periodic.backup.failed",
			file: "apps/mem-claw/src/storage/maintenance.ts",
			function: "runMaintenancePass",
			site_id: "maintenance.runMaintenancePass.11beb09895",
		});
	}

	log.info("maintenance pass complete", {
		integrityMs: report.integrityMs,
		outboxFlushed: report.outboxFlushed,
		quarantinePruned: report.quarantinePruned,
		usageEventsPruned: report.usageEventsPruned,
	}, {
		event_name: "mem_claw.maintenance.maintenance.pass.complete",
		file: "apps/mem-claw/src/storage/maintenance.ts",
		function: "runMaintenancePass",
		site_id: "maintenance.runMaintenancePass.6a1e15dc18",
	});
	return report;
}

export interface MaintenanceTimerHandle {
	stop(): void;
}

/**
 * Gateway maintenance schedule: first tick MAINTENANCE_FIRST_TICK_DELAY_MS
 * after boot (near-boot integrity coverage), then every intervalMs. Self-stops
 * once the storage latch trips.
 */
export function startMaintenanceTimer(
	deps: MaintenanceDeps,
	intervalMs: number = BACKUP_INTERVAL_MS,
): MaintenanceTimerHandle {
	let interval: NodeJS.Timeout | null = null;
	let firstTick: NodeJS.Timeout | null = null;
	let inFlight = false;
	let stopped = false;
	const stop = (): void => {
		stopped = true;
		if (firstTick) {
			clearTimeout(firstTick);
			firstTick = null;
		}
		if (interval) {
			clearInterval(interval);
			interval = null;
		}
	};
	const tick = (): void => {
		if (inFlight) {
			log.warn("skipping maintenance tick: previous pass still in flight", undefined, {
				event_name: "mem_claw.maintenance.skipping.maintenance.tick.previous.pass.still.in.flight",
				file: "apps/mem-claw/src/storage/maintenance.ts",
				function: "tick",
				site_id: "maintenance.tick.e111b66415",
			});
			return;
		}
		if (deps.store.closed) {
			log.info("stopping maintenance for closed or replaced runtime", { dbPath: deps.dbPath }, {
				event_name: "mem_claw.maintenance.stopping.maintenance.for.closed.or.replaced.runtime",
				file: "apps/mem-claw/src/storage/maintenance.ts",
				function: "tick",
				site_id: "maintenance.tick.6bd3e0102c",
			});
			stop();
			return;
		}
		if (deps.store.sqlite.isFailed()) {
			stop();
			return;
		}
		inFlight = true;
		void (async () => {
			try {
				const report = runMaintenancePass(deps);
				if (report.aborted) {
					stop();
					return;
				}
				await evaluateRemAutomaticTriggers({
					database: deps.store.sqlite,
					stateDir: deps.stateDir,
					auditStateDir: getMemClawStateDir(),
					requestedOperations: readRemAutomaticOperations(),
				});
			} catch (error) {
				log.warn("maintenance pass threw", { error }, {
					event_name: "mem_claw.maintenance.maintenance.pass.threw",
					file: "apps/mem-claw/src/storage/maintenance.ts",
					function: "<anonymous callback>",
					site_id: "maintenance.<anonymous callback>.f90713a2e3",
				});
			} finally {
				inFlight = false;
			}
		})();
	};
	firstTick = setTimeout(() => {
		firstTick = null;
		tick();
		if (stopped) return;
		interval = setInterval(tick, intervalMs);
		interval.unref?.();
	}, MAINTENANCE_FIRST_TICK_DELAY_MS);
	firstTick.unref?.();
	log.debug("maintenance timer started", { intervalMs }, {
		event_name: "mem_claw.maintenance.maintenance.timer.started",
		file: "apps/mem-claw/src/storage/maintenance.ts",
		function: "startMaintenanceTimer",
		site_id: "maintenance.startMaintenanceTimer.06c1e98584",
	});
	return { stop };
}
