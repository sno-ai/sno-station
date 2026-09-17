/** @file maintenance.ts
 * @purpose Ordered maintenance pass: integrity check, outbox drain, usage-event retention, FTS
 *   merge, planner statistics, backup, REM trigger check. Each job runs on its own interval.
 * @boundary Owns the gateway maintenance timer; integrity failures are logged without blocking storage.
 * @see backup.ts, memory-telemetry-outbox.ts, sqlite-runtime.ts.
 */

import { createHash, type Hash } from "node:crypto";
import { createLogger } from "@snoai/utils/logger";
import { runIntegrityCheck } from "@snoai/sno-station-core-crypto";
import {
	BACKUP_INTERVAL_MS,
	FTS_MERGE_INTERVAL_MS,
	INTEGRITY_CHECK_INTERVAL_MS,
	MAINTENANCE_TICK_MS,
	PLANNER_STATISTICS_INTERVAL_MS,
	REM_TRIGGER_CHECK_INTERVAL_MS,
	USAGE_EVENT_RETENTION_INTERVAL_MS,
	USAGE_OUTBOX_INTERVAL_MS,
} from "../../config/index";
import {
	appendAuditEntry,
} from "../engine/operations/runtime-audit-log";
import { isBackupDue, runBackup } from "./backup";
import type { MemoryStore } from "./memory-store-base";
import {
	evaluateRemAutomaticTriggers,
	readRemAutomaticOperations,
} from "../sidecar/rem-trigger";
import { getSnoStationMemStateDir } from "../engine/shared/paths";
import { recordMemoryTelemetryIncident } from "../engine/telemetry/memory-telemetry-incidents";
import type { MemoryTelemetryUsageOutbox } from "../engine/telemetry/memory-telemetry-outbox";

const log = createLogger("sno-station-mem:maintenance");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Usage events ('recall'/'inject') older than this are pruned from the
 * `nodix_memory_events` ledger. MUST stay >= the purge-safety recall lookback
 * (RECENT_RECALL_WINDOW_MS, 30 d) — coupled by a unit test — so retention can
 * never erase evidence the cascade-purge preview depends on. Lifecycle events
 * are never pruned (database-enforced by the guarded delete trigger).
 */
export const MEMORY_EVENTS_USAGE_RETENTION_MS: number = 90 * DAY_MS;

/** Quarantined outbox rows older than this are deleted by the maintenance pass. */
export const OUTBOX_QUARANTINE_RETENTION_MS: number = 30 * DAY_MS;

/** The first tick runs shortly after boot, so every job gets near-boot coverage. */
export const MAINTENANCE_FIRST_TICK_DELAY_MS = 60_000;

export type MaintenanceJob =
	| "integrity"
	| "usage-outbox"
	| "usage-retention"
	| "fts-merge"
	| "planner-statistics"
	| "backup"
	| "rem-trigger";

export type MaintenanceIntervals = Readonly<Record<MaintenanceJob, number>>;

/** Each job's own cadence; see the MAINTENANCE section of config/index.ts. */
export const MAINTENANCE_INTERVALS: MaintenanceIntervals = {
	integrity: INTEGRITY_CHECK_INTERVAL_MS,
	"usage-outbox": USAGE_OUTBOX_INTERVAL_MS,
	"usage-retention": USAGE_EVENT_RETENTION_INTERVAL_MS,
	"fts-merge": FTS_MERGE_INTERVAL_MS,
	"planner-statistics": PLANNER_STATISTICS_INTERVAL_MS,
	backup: BACKUP_INTERVAL_MS,
	"rem-trigger": REM_TRIGGER_CHECK_INTERVAL_MS,
};

const ALL_MAINTENANCE_JOBS: ReadonlySet<MaintenanceJob> = new Set(
	Object.keys(MAINTENANCE_INTERVALS) as MaintenanceJob[],
);

/** Every job on one interval — what the sidecar's maintenance-interval override asks for. */
export function uniformMaintenanceIntervals(intervalMs: number): MaintenanceIntervals {
	return Object.fromEntries(
		[...ALL_MAINTENANCE_JOBS].map((job) => [job, intervalMs]),
	) as Record<MaintenanceJob, number>;
}

const OUTBOX_DRAIN_BUDGET_MS = 30_000;
const RETENTION_DELETE_BATCH = 5000;
const RETENTION_PRUNE_BUDGET_MS = 5_000;
const FTS_MERGE_MAX_ITERATIONS = 10;

export interface MaintenanceDeps {
	store: MemoryStore;
	remClock?: Date;
	remVolumeThreshold?: number;
	usageOutbox?: MemoryTelemetryUsageOutbox;
	dbPath: string;
	backupDir: string;
	/** sno-station-mem state directory for maintenance records. */
	stateDir: string;
	/**
	 * Integrity sweep implementation; defaults to sno-station-core-crypto's runIntegrityCheck.
	 * Injectable so the integrity integration test can drive the failure path
	 * (pre-declared in the DB-optimization plan's test design).
	 */
	integrityCheck?: (rawDb: Parameters<typeof runIntegrityCheck>[0]) => void;
	/**
	 * Wall-clock budget for usage-event retention pruning per pass; defaults to
	 * RETENTION_PRUNE_BUDGET_MS. Injectable so a test can force early cutoff of
	 * a large backlog without waiting on the real budget (host adversarial
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
		event_name: "sno_station_mem.maintenance.rebuilding.derived.fts.index.after.verified.derived.only.integrity.fai",
		file: "packages/sno-station-mem/src/store/maintenance.ts",
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
			event_name: "sno_station_mem.maintenance.derived.fts.index.rebuilt.and.integrity.reverified",
			file: "packages/sno-station-mem/src/store/maintenance.ts",
			function: "recoverDerivedFts",
			site_id: "maintenance.recoverDerivedFts.2cf5f62053",
		});
		return true;
	} catch (error) {
		recordIntegrityAudit(deps.stateDir, "retained", "error", {
			reason: error instanceof Error ? error.message : String(error),
		});
		log.error("derived FTS recovery failed; storage continues serving", { error }, {
			event_name: "memory.storage.fts.recovery.failed",
			file: "packages/sno-station-mem/src/store/maintenance.ts",
			function: "recoverDerivedFts",
			site_id: "maintenance.recoverDerivedFts.c07ad948a2",
		});
		return false;
	}
}

/** Records an integrity failure without blocking subsequent SQL. */
function recordIntegrityFailure(deps: MaintenanceDeps, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	try {
		recordMemoryTelemetryIncident(deps.store.sqlite, {
			incidentType: "storage_integrity_check_failed",
			severity: "error",
			message: "database integrity check failed; storage continues serving",
			payload: { error_code: "integrity_check_failed", last_error: message.slice(0, 500) },
		});
	} catch {
		// Incident persistence is best-effort on a damaged database.
	}
	log.error("storage continues serving after integrity failure", { error: message }, {
		event_name: "memory.storage.integrity.failed",
		file: "packages/sno-station-mem/src/store/maintenance.ts",
		function: "recordIntegrityFailure",
		site_id: "maintenance.failClosed.dd7955e647",
	});
}

/**
 * Bounded catch-up: a backlog left by a maintenance gap or a first-time
 * retention rollout can be far larger than one tick's budget. Deleting it
 * all synchronously would block the gateway event loop for minutes (host
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

/** Full integrity check and optional repair; reads and writes stay available. */
function sweepIntegrity(deps: MaintenanceDeps, report: MaintenanceReport): void {
	const started = Date.now();
	try {
		const sweep = deps.integrityCheck ?? runIntegrityCheck;
		deps.store.sqlite.runRecoveryOperation(raw => raw.transaction(() => {
			// xIntegrity does not refresh FTS5's cached structure after another connection writes.
			// Opening a cursor resets it; the read transaction keeps the subsequent sweep on that snapshot.
			if (deps.store.hasFtsSupport) raw.prepare("SELECT rowid FROM nodix_memory_chunks_fts LIMIT 1").get();
			sweep(raw);
		}).deferred());
	} catch (error) {
		recordIntegrityFailure(deps, error);
		report.integrityRecovery = tryRecoverDerivedFts(deps) ? "recovered" : "retained";
	} finally { report.integrityMs = Date.now() - started; }
}

/** Runs the requested maintenance jobs independently. */
export function runMaintenancePass(
	deps: MaintenanceDeps,
	due: ReadonlySet<MaintenanceJob> = ALL_MAINTENANCE_JOBS,
	backupIntervalMs: number = BACKUP_INTERVAL_MS,
): MaintenanceReport {
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
			event_name: "sno_station_mem.maintenance.stopping.maintenance.for.closed.or.replaced.runtime",
			file: "packages/sno-station-mem/src/store/maintenance.ts",
			function: "runMaintenancePass",
			site_id: "maintenance.runMaintenancePass.747b7cbef0",
		});
		return report;
	}
	deps.store.db.retrySetup();
	deps.store.hasFtsSupport = deps.store.sqlite.prepare(
		"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memory_chunks_fts' LIMIT 1",
	).get() !== undefined;
	const now = Date.now();

	if (due.has("integrity")) sweepIntegrity(deps, report);

	// 1. Outbox drain (bounded catch-up) + quarantine hygiene.
	if (deps.usageOutbox && due.has("usage-outbox")) {
		try {
			report.outboxFlushed = deps.usageOutbox.drainPending(OUTBOX_DRAIN_BUDGET_MS).inserted;
			report.quarantinePruned = deps.usageOutbox.pruneQuarantined(
				now - OUTBOX_QUARANTINE_RETENTION_MS,
			);
		} catch (error) {
			log.warn("outbox maintenance failed", { error }, {
				event_name: "sno_station_mem.maintenance.outbox.maintenance.failed",
				file: "packages/sno-station-mem/src/store/maintenance.ts",
				function: "runMaintenancePass",
				site_id: "maintenance.runMaintenancePass.c72575daaa",
			});
		}
	}

	// 2. Usage-event retention (lifecycle events are trigger-protected).
	if (due.has("usage-retention")) try {
		report.usageEventsPruned = pruneExpiredUsageEvents(
			deps.store,
			now,
			deps.retentionPruneBudgetMs ?? RETENTION_PRUNE_BUDGET_MS,
		);
	} catch (error) {
		log.warn("usage-event retention failed", { error }, {
			event_name: "sno_station_mem.maintenance.usage.event.retention.failed",
			file: "packages/sno-station-mem/src/store/maintenance.ts",
			function: "runMaintenancePass",
			site_id: "maintenance.runMaintenancePass.ef7a1e225c",
		});
	}

	// 3. FTS segment merge keeps keyword-search b-trees compact after write bursts.
	if (due.has("fts-merge")) try {
		mergeFtsSegments(deps.store);
	} catch (error) {
		log.warn("fts merge failed", { error }, {
			event_name: "sno_station_mem.maintenance.fts.merge.failed",
			file: "packages/sno-station-mem/src/store/maintenance.ts",
			function: "runMaintenancePass",
			site_id: "maintenance.runMaintenancePass.90f01cc543",
		});
	}

	// 4. Bounded planner-statistics refresh.
	if (due.has("planner-statistics")) try {
		deps.store.sqlite.exec("PRAGMA analysis_limit=400");
		deps.store.sqlite.exec("PRAGMA optimize");
	} catch (error) {
		log.warn("pragma optimize failed", { error }, {
			event_name: "sno_station_mem.maintenance.pragma.optimize.failed",
			file: "packages/sno-station-mem/src/store/maintenance.ts",
			function: "runMaintenancePass",
			site_id: "maintenance.runMaintenancePass.3a7c9e73cf",
		});
	}

	// 5. Snapshot backup AFTER retention so the copy is post-prune. Due is read from the newest
	// backup file, so a restart never takes an extra one.
	if (due.has("backup")) try {
		// Inside the try: an unreadable backup directory must not stop the REM check after this pass.
		if (isBackupDue(deps.backupDir, now, backupIntervalMs)) report.backupPath = runBackup(deps.dbPath, deps.backupDir);
	} catch (error) {
		log.warn("periodic backup failed", { error }, {
			event_name: "sno_station_mem.maintenance.periodic.backup.failed",
			file: "packages/sno-station-mem/src/store/maintenance.ts",
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
		event_name: "sno_station_mem.maintenance.maintenance.pass.complete",
		file: "packages/sno-station-mem/src/store/maintenance.ts",
		function: "runMaintenancePass",
		site_id: "maintenance.runMaintenancePass.6a1e15dc18",
	});
	return report;
}

export interface MaintenanceTimerHandle {
	stop(): void;
}

/**
 * Gateway maintenance schedule: first tick MAINTENANCE_FIRST_TICK_DELAY_MS after boot, then every
 * tickMs. Each tick runs the jobs whose own interval has elapsed since they last ran; the first
 * tick runs all of them. Stops when its store closes.
 */
export function startMaintenanceTimer(
	deps: MaintenanceDeps,
	tickMs: number = MAINTENANCE_TICK_MS,
	firstTickDelayMs: number = MAINTENANCE_FIRST_TICK_DELAY_MS,
	intervals: MaintenanceIntervals = MAINTENANCE_INTERVALS,
): MaintenanceTimerHandle {
	let interval: NodeJS.Timeout | null = null;
	let firstTick: NodeJS.Timeout | null = null;
	let inFlight = false;
	let stopped = false;
	const lastRun = new Map<MaintenanceJob, number>();
	// Timers drift; half a tick of slack keeps a job on an interval equal to the tick from skipping one.
	const slackMs = tickMs / 2;
	const dueJobs = (now: number): Set<MaintenanceJob> => {
		const due = new Set<MaintenanceJob>();
		for (const job of ALL_MAINTENANCE_JOBS) {
			const last = lastRun.get(job);
			// Backup's due check reads the newest backup file inside the pass instead.
			if (job === "backup" || last === undefined || now - last >= intervals[job] - slackMs) due.add(job);
		}
		return due;
	};
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
				event_name: "sno_station_mem.maintenance.skipping.maintenance.tick.previous.pass.still.in.flight",
				file: "packages/sno-station-mem/src/store/maintenance.ts",
				function: "tick",
				site_id: "maintenance.tick.e111b66415",
			});
			return;
		}
		if (deps.store.closed) {
			log.info("stopping maintenance for closed or replaced runtime", { dbPath: deps.dbPath }, {
				event_name: "sno_station_mem.maintenance.stopping.maintenance.for.closed.or.replaced.runtime",
				file: "packages/sno-station-mem/src/store/maintenance.ts",
				function: "tick",
				site_id: "maintenance.tick.6bd3e0102c",
			});
			stop();
			return;
		}
		inFlight = true;
		const now = Date.now();
		const due = dueJobs(now);
		for (const job of due) lastRun.set(job, now);
		void (async () => {
			try {
				const report = runMaintenancePass(deps, due, intervals.backup - slackMs);
				if (report.aborted) {
					stop();
					return;
				}
				if (!due.has("rem-trigger")) return;
				await evaluateRemAutomaticTriggers({
					database: deps.store.sqlite,
					stateDir: deps.stateDir,
					auditStateDir: getSnoStationMemStateDir(),
					...readRemAutomaticOperations(),
					now: deps.remClock, volumeThreshold: deps.remVolumeThreshold,
				});
			} catch (error) {
				log.warn("maintenance pass threw", { error }, {
					event_name: "sno_station_mem.maintenance.maintenance.pass.threw",
					file: "packages/sno-station-mem/src/store/maintenance.ts",
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
		interval = setInterval(tick, tickMs);
		interval.unref?.();
	}, firstTickDelayMs);
	firstTick.unref?.();
	log.debug("maintenance timer started", { tickMs, intervals }, {
		event_name: "sno_station_mem.maintenance.maintenance.timer.started",
		file: "packages/sno-station-mem/src/store/maintenance.ts",
		function: "startMaintenanceTimer",
		site_id: "maintenance.startMaintenanceTimer.06c1e98584",
	});
	return { stop };
}
