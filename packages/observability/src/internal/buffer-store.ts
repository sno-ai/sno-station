import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	statfsSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { computeSelfHash } from "./canonical-hash.js";
import {
	BufferCapacityError,
	ChainContentionError,
	ChainSeedError,
	ChainUnavailableError,
} from "./errors.js";
import { ensureDir } from "./fs-utils.js";
import { logger } from "./log.js";
import type {
	AgentId,
	ConsentValue,
	EventLane,
	EventScope,
	EventType,
	JsonObject,
	WireEnvelope,
} from "./types.js";
import { createEnvelope, serializeEnvelope } from "./wire-envelope.js";

const GENESIS = "GENESIS";
const MAX_CHAIN_RETRIES = 3;
const RETENTION_MAX_BYTES = 100 * 1024 * 1024;
const RETENTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHAIN_FORENSIC_CLOSED_EPOCHS = 16;
const CHAIN_RETENTION_BATCH_SIZE = 2_000;
const CHAIN_RETENTION_SCAN_LIMIT = CHAIN_RETENTION_BATCH_SIZE * 2;
const MAX_PENDING_ATTEMPTS = 100;
const QUARANTINE_MAX_ROWS = 1_000;
const QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QUARANTINE_CAPACITY_RESERVE_BYTES = 1024 * 1024;
const COMPACTION_MIN_FREELIST_BYTES = 1024 * 1024;
const COMPACTION_SPACE_RESERVE_BYTES = 16 * 1024 * 1024;
const COMPACTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const COMPACTION_LEASE_MS = 5 * 60 * 1000;

type BindValue = string | number | Buffer | null;

export interface PendingRow {
	rowid: number;
	event_id: string;
	machine_id: string;
	agent_id: AgentId;
	chain_epoch: number;
	seq: number;
	self_hash: string;
	prev: string;
	payload: Buffer;
	shipped: 0 | 1;
	terminal: 0 | 1;
	created_at: number;
	attempts: number;
}

export interface PendingChain {
	machineId: string;
	agentId: AgentId;
	chainEpoch: number;
}

export interface AppendInput {
	eventId: string;
	eventType: EventType;
	lane: EventLane;
	tsEdgeMs: number;
	consentLevel: ConsentValue;
	redacted: boolean;
	scope: EventScope;
	payload: JsonObject;
	terminal: boolean;
	chainEpoch?: number;
}

export interface AppendResult {
	rowid: number;
	eventId: string;
	chainEpoch: number;
	seq: number;
	selfHash: string;
	envelope: WireEnvelope;
	serialized: string;
}

interface TailRow {
	last_seq: number;
	last_self_hash: string;
}

interface CountRow {
	count: number;
}

interface EpochRow {
	chain_epoch: number | null;
}

interface AgentRow {
	agent_id: AgentId;
}

interface RowIdRow {
	rowid: number;
}

interface ChainRetentionKey {
	machine_id: string;
	agent_id: AgentId;
	chain_epoch: number;
}

interface ChainRetentionScanRow extends ChainRetentionKey {
	eligible: 0 | 1;
}

interface CheckpointRow {
	busy: number;
	log: number;
	checkpointed: number;
}

interface EventRowRef {
	rowid: number;
	event_id: string;
}

interface PragmaValueRow {
	freelist_count?: number;
	page_count?: number;
	page_size?: number;
}

interface QueueAggregateRow {
	pending_count: number;
	oldest_created_at: number | null;
	max_attempts: number | null;
}

interface AgentQueueAggregateRow {
	oldest_created_at: number | null;
	max_attempts: number | null;
}

interface QuarantineReasonRow {
	reason: string;
}

interface TableInfoRow {
	name: string;
}

interface SenderControlRow {
	retry_not_before: number;
	lease_owner: string | null;
	lease_until: number;
}

interface RetryDeadlineRow {
	retry_not_before: number | null;
}

interface ChainStateRow {
	state: "reseed_required" | "retired";
	reason?: string;
}

interface MaintenanceControlRow {
	lease_owner: string | null;
	lease_until_ms: number;
	phase: string;
	protected_inventory_json: string | null;
	last_compaction_at_ms: number | null;
	last_reason: CompactionReason;
	updated_at_ms: number;
}

export type ChainRecoveryState = "reseed_required" | "retired";

export interface BufferStorageMetrics {
	logicalBytes: number;
	physicalBytes: number;
	walBytes: number;
	freelistPages: number;
	freelistBytes: number;
	freelistRatio: number;
	remainingEpochs: number;
	databaseSizeBytes: number;
}

type PageStorageMetrics = Omit<BufferStorageMetrics, "remainingEpochs">;

export type CompactionReason =
	| "not_run"
	| "not_needed"
	| "lease_busy"
	| "checkpoint_busy"
	| "invalid_metadata"
	| "insufficient_space"
	| "backup_failed"
	| "backup_verified"
	| "vacuuming"
	| "reopening"
	| "interrupted_primary_recovered"
	| "recovery_required"
	| "completed";

export interface RetentionReport extends BufferStorageMetrics {
	deletedEvents: number;
	deletedChainTail: number;
	deletedChainState: number;
	deletedChainRetry: number;
	maintenanceDurationMs: number;
	lastCompactionAtMs: number | null;
	compactionReason: CompactionReason;
}

export interface QueueStats extends BufferStorageMetrics {
	activeChainRecoveryCount: number;
	activeChainRecoveryReason: string | null;
	pendingCount: number;
	oldestPendingAgeMs: number;
	maxAttempts: number;
	quarantinedCount: number;
	latestQuarantineReason: string | null;
	lastCompactionAtMs: number | null;
	compactionReason: CompactionReason;
}

const CHAIN_RETENTION_ELIGIBILITY_SQL = `CASE WHEN
	EXISTS (
		SELECT 1
		FROM chain_tail AS newer
		WHERE newer.machine_id = window.machine_id
			AND newer.agent_id = window.agent_id
			AND newer.chain_epoch > window.chain_epoch
		ORDER BY newer.chain_epoch ASC
		LIMIT 1 OFFSET ?
	)
	AND NOT EXISTS (
		SELECT 1 FROM events AS event
		WHERE event.machine_id = window.machine_id
			AND event.agent_id = window.agent_id
			AND event.chain_epoch = window.chain_epoch
			AND event.shipped = 0
	)
	AND NOT EXISTS (
		SELECT 1 FROM chain_state AS state
		WHERE state.machine_id = window.machine_id
			AND state.agent_id = window.agent_id
			AND state.chain_epoch = window.chain_epoch
	)
	AND NOT EXISTS (
		SELECT 1 FROM chain_retry AS retry
		WHERE retry.machine_id = window.machine_id
			AND retry.agent_id = window.agent_id
			AND retry.chain_epoch = window.chain_epoch
	)
	THEN 1 ELSE 0 END AS eligible`;

function buildChainRetentionScanSql(afterCursor: boolean): string {
	const keyset = afterCursor
		? "WHERE (machine_id, agent_id, chain_epoch) > (?, ?, ?)"
		: "";
	return `WITH scan_window AS MATERIALIZED (
		SELECT machine_id, agent_id, chain_epoch
		FROM chain_tail
		${keyset}
		ORDER BY machine_id, agent_id, chain_epoch
		LIMIT ?
	)
	SELECT window.machine_id, window.agent_id, window.chain_epoch,
		${CHAIN_RETENTION_ELIGIBILITY_SQL}
	FROM scan_window AS window`;
}

export const CHAIN_RETENTION_SCAN_SQL = {
	fromStart: buildChainRetentionScanSql(false),
	afterCursor: buildChainRetentionScanSql(true),
} as const;

export type BufferSafeguardReason = "disk_size" | "max_attempts" | "queue_age";

export function compactionHasRequiredSpace(
	availableBytes: number,
	primaryMainBytes: number,
	walBytes: number,
): boolean {
	if (![availableBytes, primaryMainBytes, walBytes].every(isNonNegativeSafeInteger)) {
		return false;
	}
	const required = compactionRequiredFreeBytes(BigInt(primaryMainBytes), BigInt(walBytes));
	return BigInt(availableBytes) >= required;
}

export class BufferStore {
	private db: InstanceType<typeof DatabaseConstructor>;
	private chainRetentionCursor: ChainRetentionKey | null = null;

	constructor(readonly path: string) {
		ensureDir(dirname(path));
		if (existsSync(this.recoveryMarkerPath())) {
			throw new Error("sno observe maintenance recovery requires operator action");
		}
		this.db = this.openDatabase();
		this.migrate();
		this.recoverInterruptedMaintenance();
	}

	close(): void {
		this.db.close();
	}

	append(input: AppendInput): AppendResult {
		for (let attempt = 0; attempt < MAX_CHAIN_RETRIES; attempt += 1) {
			try {
				return this.appendOnce(input);
			} catch (error) {
				if (!isUniqueConstraintError(error)) {
					throw error;
				}
			}
		}
		throw new ChainContentionError();
	}

	hasTail(machineId: string, agentId: AgentId, chainEpoch: number): boolean {
		return this.getTailInsideTx(machineId, agentId, chainEpoch) !== undefined;
	}

	getCurrentEpoch(machineId: string, agentId: AgentId): number {
		return this.getCurrentEpochInsideTx(machineId, agentId);
	}

	nextEpoch(machineId: string, agentId: AgentId): number {
		return this.getCurrentEpoch(machineId, agentId) + 1;
	}

	listAgents(): AgentId[] {
		const rows = this.db.prepare("SELECT DISTINCT agent_id FROM chain_tail").all() as AgentRow[];
		return rows.map((row) => row.agent_id);
	}

	getPending(limit = 50): PendingRow[] {
		return this.db
			.prepare(
				`SELECT rowid, event_id, machine_id, agent_id, chain_epoch, seq, self_hash, prev,
					payload, shipped, terminal, created_at, attempts
				FROM events
				WHERE shipped = 0 AND terminal = 0
				ORDER BY rowid ASC
				LIMIT ?`,
			)
			.all(limit) as PendingRow[];
	}

	getPendingExcludingChains(blockedChains: readonly PendingChain[], limit = 50): PendingRow[] {
		const exclusions = blockedChains
			.map(() => "(machine_id = ? AND agent_id = ? AND chain_epoch = ?)")
			.join(" OR ");
		const whereExclusions = exclusions.length === 0 ? "" : `AND NOT (${exclusions})`;
		const bindings: BindValue[] = blockedChains.flatMap((chain) => [
			chain.machineId,
			chain.agentId,
			chain.chainEpoch,
		]);
		return this.db
			.prepare(
				`SELECT rowid, event_id, machine_id, agent_id, chain_epoch, seq, self_hash, prev,
					payload, shipped, terminal, created_at, attempts
				FROM events
				WHERE shipped = 0 AND terminal = 0
				${whereExclusions}
				AND NOT EXISTS (
					SELECT 1 FROM chain_retry AS retry
					WHERE retry.machine_id = events.machine_id
						AND retry.agent_id = events.agent_id
						AND retry.chain_epoch = events.chain_epoch
						AND retry.retry_not_before > ?
				)
				ORDER BY rowid ASC
				LIMIT ?`,
			)
			.all(...bindings, Date.now(), limit) as PendingRow[];
	}

	getReadyPending(limit = 50): PendingRow[] {
		return this.getPendingExcludingChains([], limit);
	}

	getNextChainRetryDelay(now = Date.now()): number {
		const row = this.db
			.prepare(
				`SELECT MIN(retry.retry_not_before) AS retry_not_before
				FROM chain_retry AS retry
				WHERE retry.retry_not_before > ?
					AND EXISTS (
						SELECT 1 FROM events
						WHERE events.machine_id = retry.machine_id
							AND events.agent_id = retry.agent_id
							AND events.chain_epoch = retry.chain_epoch
							AND events.shipped = 0 AND events.terminal = 0
					)`,
			)
			.get(now) as RetryDeadlineRow;
		return row.retry_not_before === null ? 0 : Math.max(0, row.retry_not_before - now);
	}

	deferChainRetriesUntil(chain: PendingChain, deadlineMs: number): void {
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					`INSERT INTO chain_retry (machine_id, agent_id, chain_epoch, retry_not_before)
					VALUES (?, ?, ?, ?)
					ON CONFLICT(machine_id, agent_id, chain_epoch)
					DO UPDATE SET retry_not_before = MAX(retry_not_before, excluded.retry_not_before)`,
				)
				.run(chain.machineId, chain.agentId, chain.chainEpoch, deadlineMs);
		});
	}

	getAllRows(): PendingRow[] {
		return this.db
			.prepare(
				`SELECT rowid, event_id, machine_id, agent_id, chain_epoch, seq, self_hash, prev,
					payload, shipped, terminal, created_at, attempts
				FROM events
				ORDER BY rowid ASC`,
			)
			.all() as PendingRow[];
	}

	getByEventId(eventId: string): PendingRow | null {
		const row = this.db
			.prepare(
				`SELECT rowid, event_id, machine_id, agent_id, chain_epoch, seq, self_hash, prev,
					payload, shipped, terminal, created_at, attempts
				FROM events
				WHERE event_id = ?`,
			)
			.get(eventId) as PendingRow | undefined;
		return row ?? null;
	}

	markShipped(rowid: number): void {
		this.withImmediateTransaction(() => {
			this.deleteChainRetryForRow(rowid);
			this.db.prepare("UPDATE events SET shipped = 1 WHERE rowid = ?").run(rowid);
		});
	}

	markTerminal(rowid: number): void {
		this.withImmediateTransaction(() => {
			this.deleteChainRetryForRow(rowid);
			this.db.prepare("UPDATE events SET terminal = 1 WHERE rowid = ?").run(rowid);
		});
	}

	incrementAttempts(rowid: number): void {
		this.withImmediateTransaction(() => {
			this.db.prepare("UPDATE events SET attempts = attempts + 1 WHERE rowid = ?").run(rowid);
		});
	}

	getChainRecoveryState(
		machineId: string,
		agentId: AgentId,
		chainEpoch: number,
	): ChainRecoveryState | null {
		const row = this.db
			.prepare(
				`SELECT state FROM chain_state
				WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ?`,
			)
			.get(machineId, agentId, chainEpoch) as ChainStateRow | undefined;
		return row?.state ?? null;
	}

	getRetryDelay(now = Date.now()): number {
		const control = this.senderControl();
		return Math.max(0, control.retry_not_before - now);
	}

	deferRetriesUntil(deadlineMs: number): void {
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					`UPDATE sender_control
					SET retry_not_before = MAX(retry_not_before, ?)
					WHERE id = 1`,
				)
				.run(deadlineMs);
		});
	}

	clearElapsedRetryDeadline(now = Date.now()): void {
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					`UPDATE sender_control SET retry_not_before = 0
					WHERE id = 1 AND retry_not_before <= ?`,
				)
				.run(now);
		});
	}

	acquireFlushLease(owner: string, now = Date.now(), leaseMs = 30_000): number {
		let retryAfterMs = 0;
		this.withImmediateTransaction(() => {
			const control = this.senderControl();
			if (
				control.lease_owner !== null &&
				control.lease_owner !== owner &&
				control.lease_until > now
			) {
				retryAfterMs = control.lease_until - now;
				return;
			}
			this.db
				.prepare(
					`UPDATE sender_control
					SET lease_owner = ?, lease_until = ?
					WHERE id = 1`,
				)
				.run(owner, now + leaseMs);
		});
		return retryAfterMs;
	}

	renewFlushLease(owner: string, now = Date.now(), leaseMs = 30_000): boolean {
		let renewed = false;
		this.withImmediateTransaction(() => {
			renewed =
				this.db
					.prepare(
						`UPDATE sender_control SET lease_until = ?
						WHERE id = 1 AND lease_owner = ?`,
					)
					.run(now + leaseMs, owner).changes === 1;
		});
		return renewed;
	}

	releaseFlushLease(owner: string): void {
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					`UPDATE sender_control SET lease_owner = NULL, lease_until = 0
					WHERE id = 1 AND lease_owner = ?`,
				)
				.run(owner);
		});
	}

	quarantine(row: PendingRow, status: number, reason: string, body: string): void {
		this.withImmediateTransaction(() => {
			const now = Date.now();
			this.db
				.prepare(
					`INSERT INTO quarantine (
						rowid, event_id, status, reason, response_body, quarantined_at
					) VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(row.rowid, row.event_id, status, reason, body.slice(0, 8_192), now);
			this.deleteChainRetryForRow(row.rowid);
			this.db.prepare("UPDATE events SET terminal = 1 WHERE rowid = ?").run(row.rowid);
			this.pruneQuarantineInsideTx(QUARANTINE_MAX_ROWS, QUARANTINE_MAX_AGE_MS, now);
		});
	}

	quarantineEpochSuffix(
		row: PendingRow,
		status: number,
		reason: string,
		body: string,
		recoveryState: ChainRecoveryState,
	): number {
		let terminalCount = 0;
		this.withImmediateTransaction(() => {
			const now = Date.now();
			const bodyExcerpt = body.slice(0, 8_192);
			const suffixCount = this.count(
				`SELECT COUNT(*) AS count FROM events
				WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ? AND seq >= ?
					AND shipped = 0 AND terminal = 0`,
				row.machine_id,
				row.agent_id,
				row.chain_epoch,
				row.seq,
			);
			const pageSizeRow = this.db.prepare("PRAGMA page_size").get() as PragmaValueRow;
			const terminalWalBudget = suffixCount * (pageSizeRow.page_size ?? 4_096);
			if (
				this.databaseSizeBytes() + terminalWalBudget + QUARANTINE_CAPACITY_RESERVE_BYTES >
				RETENTION_MAX_BYTES
			) {
				throw new BufferCapacityError();
			}
			terminalCount = this.db
				.prepare(
					`UPDATE events SET terminal = 1
					WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ? AND seq >= ?
						AND shipped = 0 AND terminal = 0`,
				)
				.run(row.machine_id, row.agent_id, row.chain_epoch, row.seq).changes;
			const detailBytes = Math.max(
				512,
				Buffer.byteLength(bodyExcerpt, "utf8") + Buffer.byteLength(reason, "utf8") + 256,
			);
			const availableBytes = Math.max(
				0,
				RETENTION_MAX_BYTES -
					this.databaseSizeBytes() -
					terminalWalBudget -
					QUARANTINE_CAPACITY_RESERVE_BYTES,
			);
			const detailLimit = Math.min(QUARANTINE_MAX_ROWS, Math.floor(availableBytes / detailBytes));
			const suffixRows = this.db
				.prepare(
					`SELECT rowid, event_id
					FROM events
					WHERE machine_id = ?
						AND agent_id = ?
						AND chain_epoch = ?
						AND seq >= ?
						AND shipped = 0
						AND terminal = 1
					ORDER BY seq ASC, rowid ASC
					LIMIT ?`,
				)
				.all(row.machine_id, row.agent_id, row.chain_epoch, row.seq, detailLimit) as EventRowRef[];
			const insertQuarantine = this.db.prepare(
				`INSERT INTO quarantine (
					rowid, event_id, status, reason, response_body, quarantined_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
			);
			for (const suffixRow of suffixRows) {
				insertQuarantine.run(
					suffixRow.rowid,
					suffixRow.event_id,
					status,
					reason,
					bodyExcerpt,
					now,
				);
			}
			this.db
				.prepare(
					"DELETE FROM chain_retry WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ?",
				)
				.run(row.machine_id, row.agent_id, row.chain_epoch);
			this.db
				.prepare(
					`INSERT INTO chain_state (
						machine_id, agent_id, chain_epoch, state, reason, updated_at
					) VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(machine_id, agent_id, chain_epoch)
					DO UPDATE SET state = excluded.state, reason = excluded.reason,
						updated_at = excluded.updated_at`,
				)
				.run(row.machine_id, row.agent_id, row.chain_epoch, recoveryState, reason, now);
			this.pruneQuarantineInsideTx(QUARANTINE_MAX_ROWS, QUARANTINE_MAX_AGE_MS, now);
		});
		this.checkpointWal();
		return terminalCount;
	}

	pruneRetention(
		maxBytes = RETENTION_MAX_BYTES,
		maxAgeMs = RETENTION_MAX_AGE_MS,
		now = Date.now(),
	): RetentionReport {
		const startedAt = Date.now();
		let deletedEvents = 0;
		let deletedChainTail = 0;
		let deletedChainState = 0;
		let deletedChainRetry = 0;
		let nextChainRetentionCursor = this.chainRetentionCursor;
		if (this.databaseSizeBytes() > maxBytes) {
			this.checkpointWal();
		}
		this.withImmediateTransaction(() => {
			const scannedRows = this.scanChainRetentionInsideTx();
			const deleteTail = this.db.prepare(
				`DELETE FROM chain_tail
				WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ?`,
			);
			for (const row of scannedRows) {
				if (row.eligible === 0 || deletedChainTail >= CHAIN_RETENTION_BATCH_SIZE) {
					continue;
				}
				deletedChainTail += deleteTail.run(row.machine_id, row.agent_id, row.chain_epoch).changes;
			}
			nextChainRetentionCursor = greatestChainRetentionKey(scannedRows);
			deletedChainState = this.deleteOrphanChainRowsInsideTx("chain_state");
			deletedChainRetry = this.deleteOrphanChainRowsInsideTx("chain_retry");

			const olderThan = now - maxAgeMs;
			deletedEvents += this.db
				.prepare("DELETE FROM events WHERE (shipped = 1 OR terminal = 1) AND created_at < ?")
				.run(olderThan).changes;
			if (this.logicalDataSizeBytes() <= maxBytes) {
				return;
			}
			const rows = this.db
				.prepare(
					`SELECT rowid
						FROM events
						WHERE shipped = 1 OR terminal = 1
						ORDER BY created_at ASC, rowid ASC`,
				)
				.all() as RowIdRow[];
			const deleteRow = this.db.prepare(
				"DELETE FROM events WHERE rowid = ? AND (shipped = 1 OR terminal = 1)",
			);
			const batchSize = 50;
			for (let index = 0; index < rows.length; index += batchSize) {
				for (const row of rows.slice(index, index + batchSize)) {
					deletedEvents += deleteRow.run(row.rowid).changes;
				}
				if (this.logicalDataSizeBytes() <= maxBytes) {
					break;
				}
			}
		});
		this.chainRetentionCursor = nextChainRetentionCursor;
		if (deletedEvents + deletedChainTail + deletedChainState + deletedChainRetry > 0) {
			this.checkpointWal();
		}
		const maintenance = this.maintenanceControl();
		const report: RetentionReport = {
			deletedEvents,
			deletedChainTail,
			deletedChainState,
			deletedChainRetry,
			...this.readStorageMetrics(),
			maintenanceDurationMs: Date.now() - startedAt,
			lastCompactionAtMs: maintenance.last_compaction_at_ms,
			compactionReason: maintenance.last_reason,
		};
		logger.debug("sno observe buffer maintenance", { ...report }, {
			event_name: "sno.observe.internal.buffer.store.pruneretention",
			file: "packages/sno-observe/src/internal/buffer-store.ts",
			function: "pruneRetention",
			site_id: "sno.observe.internal.buffer.store.pruneretention.1",
		});
		return report;
	}

	async compactIfNeeded(now = Date.now()): Promise<RetentionReport> {
		const startedAt = Date.now();
		const rawControl = this.readMaintenanceControl();
		if (!isMaintenanceControlRow(rawControl) || this.hasMalformedRetentionMetadata()) {
			return this.compactionReport("invalid_metadata", startedAt);
		}
		this.recoverInterruptedMaintenance(now);
		const initial = this.readStorageMetrics();
		const control = this.maintenanceControl();
		if (
			this.countPending() > 0 ||
			initial.freelistBytes < COMPACTION_MIN_FREELIST_BYTES ||
			(control.last_compaction_at_ms !== null &&
				now - control.last_compaction_at_ms < COMPACTION_COOLDOWN_MS)
		) {
			return this.compactionReport("not_needed", startedAt);
		}

		const owner = createMaintenanceOwner();
		if (!this.acquireMaintenance(owner, now)) {
			return this.compactionReport("lease_busy", startedAt);
		}

		const backupPath = `${this.path}.pre-compaction.bak`;
		try {
			if (this.countPending() > 0) {
				this.releaseMaintenance(owner, "not_needed", now);
				return this.compactionReport("not_needed", startedAt);
			}
			if (!this.checkpointWal()) {
				this.releaseMaintenance(owner, "checkpoint_busy", now);
				return this.compactionReport("checkpoint_busy", startedAt);
			}
			const mainBytes = fileSize(this.path);
			const walBytes = fileSize(`${this.path}-wal`);
			const filesystem = statfsSync(dirname(this.path), { bigint: true });
			const availableBytes = filesystem.bavail * filesystem.bsize;
			const requiredBytes = compactionRequiredFreeBytes(BigInt(mainBytes), BigInt(walBytes));
			if (availableBytes < requiredBytes) {
				this.releaseMaintenance(owner, "insufficient_space", now);
				return this.compactionReport("insufficient_space", startedAt);
			}
			if (existsSync(backupPath)) {
				this.releaseMaintenance(owner, "backup_failed", now);
				return this.compactionReport("backup_failed", startedAt);
			}

			const inventory = this.protectedInventory(this.db);
			await this.db.backup(backupPath);
			const backup = new DatabaseConstructor(backupPath, { readonly: true });
			try {
				if (
					backup.pragma("integrity_check", { simple: true }) !== "ok" ||
					this.protectedInventory(backup) !== inventory
				) {
					throw new Error("compaction backup verification failed");
				}
			} finally {
				backup.close();
			}
			this.transitionMaintenance(
				owner,
				now + COMPACTION_LEASE_MS,
				"backup_verified",
				inventory,
				"backup_verified",
				now,
			);
			this.logCompactionPhase("backup_verified", owner, startedAt);
			await new Promise<void>((resolve) => setImmediate(resolve));
			this.transitionMaintenance(
				owner,
				now + COMPACTION_LEASE_MS,
				"vacuuming",
				inventory,
				"vacuuming",
				now,
			);
			this.logCompactionPhase("vacuuming", owner, startedAt);

			this.db.close();
			const maintenance = new DatabaseConstructor(this.path);
			try {
				maintenance.pragma("busy_timeout = 5000");
				maintenance.exec("VACUUM");
			} finally {
				maintenance.close();
			}
			this.db = this.openDatabase();
			if (!this.checkpointWal()) {
				throw new Error("post-compaction checkpoint failed");
			}
			if (
				this.db.pragma("integrity_check", { simple: true }) !== "ok" ||
				this.protectedInventory(this.db) !== inventory
			) {
				throw new Error("compaction primary verification failed");
			}
			const reclaimed = this.readStorageMetrics();
			if (
				reclaimed.physicalBytes + reclaimed.walBytes >=
				initial.physicalBytes + initial.walBytes
			) {
				throw new Error("compaction did not reclaim physical storage");
			}
			this.transitionMaintenance(
				owner,
				now + COMPACTION_LEASE_MS,
				"reopening",
				inventory,
				"reopening",
				now,
			);
			this.logCompactionPhase("reopening", owner, startedAt);
			this.completeMaintenance(owner, now);
			this.logCompactionPhase("completed", owner, startedAt);
			unlinkSync(backupPath);
			return this.compactionReport("completed", startedAt);
		} catch (error) {
			if (!this.db.open) {
				this.db = this.openDatabase();
			}
			const control = this.maintenanceControl();
			if (control.lease_owner === owner) {
				this.expireOwnedMaintenance(owner, now);
				this.recoverInterruptedMaintenance(now, owner);
			}
			throw error;
		}
	}

	pruneQuarantine(
		maxRows = QUARANTINE_MAX_ROWS,
		maxAgeMs = QUARANTINE_MAX_AGE_MS,
		now = Date.now(),
	): number {
		let pruned = 0;
		this.withImmediateTransaction(() => {
			pruned = this.pruneQuarantineInsideTx(maxRows, maxAgeMs, now);
		});
		return pruned;
	}

	countPending(): number {
		return this.count("SELECT COUNT(*) AS count FROM events WHERE shipped = 0 AND terminal = 0");
	}

	countAll(): number {
		return this.count("SELECT COUNT(*) AS count FROM events");
	}

	countShipped(): number {
		return this.count("SELECT COUNT(*) AS count FROM events WHERE shipped = 1");
	}

	countQuarantined(): number {
		return this.count("SELECT COUNT(*) AS count FROM quarantine");
	}

	getQueueStats(now = Date.now()): QueueStats {
		const storage = this.readStorageMetrics();
		const rawMaintenance = this.readMaintenanceControl();
		const maintenance = isMaintenanceControlRow(rawMaintenance) ? rawMaintenance : null;
		const aggregate = this.db
			.prepare(
				`SELECT
					COUNT(*) AS pending_count,
					MIN(created_at) AS oldest_created_at,
					MAX(attempts) AS max_attempts
				FROM events
				WHERE shipped = 0 AND terminal = 0`,
			)
			.get() as QueueAggregateRow;
		const latest = this.db
			.prepare("SELECT reason FROM quarantine ORDER BY quarantined_at DESC, _rowid_ DESC LIMIT 1")
			.get() as QuarantineReasonRow | undefined;
		const activeRecoveryCount = this.count(
			`SELECT COUNT(*) AS count
			FROM chain_state AS state
			WHERE state.chain_epoch = (
				SELECT MAX(tail.chain_epoch)
				FROM chain_tail AS tail
				WHERE tail.machine_id = state.machine_id AND tail.agent_id = state.agent_id
			)`,
		);
		const activeRecovery = this.db
			.prepare(
				`SELECT state.state, state.reason
				FROM chain_state AS state
				WHERE state.chain_epoch = (
					SELECT MAX(tail.chain_epoch)
					FROM chain_tail AS tail
					WHERE tail.machine_id = state.machine_id AND tail.agent_id = state.agent_id
				)
				ORDER BY state.updated_at DESC
				LIMIT 1`,
			)
			.get() as ChainStateRow | undefined;
		return {
			...storage,
			activeChainRecoveryCount: activeRecoveryCount,
			activeChainRecoveryReason: activeRecovery?.reason ?? null,
			pendingCount: aggregate.pending_count,
			oldestPendingAgeMs:
				aggregate.oldest_created_at === null ? 0 : Math.max(0, now - aggregate.oldest_created_at),
			maxAttempts: aggregate.max_attempts ?? 0,
			quarantinedCount: this.countQuarantined(),
			latestQuarantineReason: latest?.reason ?? null,
			lastCompactionAtMs: maintenance?.last_compaction_at_ms ?? null,
			compactionReason: maintenance?.last_reason ?? "invalid_metadata",
		};
	}

	getQueueSafeguard(now = Date.now()): BufferSafeguardReason | null {
		const stats = this.getQueueStats(now);
		if (stats.databaseSizeBytes >= RETENTION_MAX_BYTES) {
			return "disk_size";
		}
		if (stats.maxAttempts >= MAX_PENDING_ATTEMPTS) {
			return "max_attempts";
		}
		if (stats.oldestPendingAgeMs >= RETENTION_MAX_AGE_MS) {
			return "queue_age";
		}
		return null;
	}

	getAdmissionSafeguard(
		machineId: string,
		agentId: AgentId,
		now = Date.now(),
	): BufferSafeguardReason | null {
		if (this.databaseSizeBytes() >= RETENTION_MAX_BYTES) {
			return "disk_size";
		}
		const aggregate = this.db
			.prepare(
				`SELECT MIN(created_at) AS oldest_created_at, MAX(attempts) AS max_attempts
				FROM events
				WHERE shipped = 0 AND terminal = 0 AND machine_id = ? AND agent_id = ?`,
			)
			.get(machineId, agentId) as AgentQueueAggregateRow;
		if ((aggregate.max_attempts ?? 0) >= MAX_PENDING_ATTEMPTS) {
			return "max_attempts";
		}
		if (
			aggregate.oldest_created_at !== null &&
			now - aggregate.oldest_created_at >= RETENTION_MAX_AGE_MS
		) {
			return "queue_age";
		}
		return null;
	}

	verifyLocalChain(): boolean {
		const rows = this.getAllRows();
		const tails = new Map<string, string>();
		for (const row of rows) {
			const envelope = decodeEnvelope(row.payload);
			const key = `${row.machine_id}:${row.agent_id}:${row.chain_epoch}`;
			const expectedPrev = row.seq === 0 ? GENESIS : tails.get(key);
			if (expectedPrev === undefined || envelope.hash_chain.prev !== expectedPrev) {
				return false;
			}
			const expectedSelf = computeSelfHash({
				eventId: envelope.event_id,
				eventType: envelope.event_type,
				tsEdgeMs: envelope.ts_edge_ms,
				scope: envelope.scope,
				chainEpoch: envelope.chain_epoch,
				seq: envelope.seq,
				consentLevel: envelope.consent_level,
				redacted: envelope.redacted,
				payload: envelope.payload,
				prev: envelope.hash_chain.prev,
			});
			if (expectedSelf !== envelope.hash_chain.self || expectedSelf !== row.self_hash) {
				return false;
			}
			tails.set(key, envelope.hash_chain.self);
		}
		return true;
	}

	private appendOnce(input: AppendInput): AppendResult {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.assertMaintenanceWritable();
			const chainEpoch =
				input.chainEpoch ??
				this.getCurrentEpochInsideTx(input.scope.machine_id, input.scope.agent_id);
			const recoveryState = this.getChainRecoveryStateInsideTx(
				input.scope.machine_id,
				input.scope.agent_id,
				chainEpoch,
			);
			if (recoveryState !== null) {
				throw new ChainUnavailableError(recoveryState);
			}
			const tail = this.getTailInsideTx(input.scope.machine_id, input.scope.agent_id, chainEpoch);
			const seq = tail === undefined ? 0 : tail.last_seq + 1;
			const prev = tail === undefined ? GENESIS : tail.last_self_hash;
			if (seq === 0 && (prev !== GENESIS || input.eventType !== "agent.identify")) {
				throw new ChainSeedError();
			}
			// agent.identify is reserved for seq=0. If we lost a bootstrap race and
			// landed at seq>=1, fail with ChainSeedError so the caller skips emitting
			// a second identify (per design.md Decision 8 / plugin-integration-spec.md §4.2).
			if (seq > 0 && input.eventType === "agent.identify") {
				throw new ChainSeedError();
			}
			const selfHash = computeSelfHash({
				eventId: input.eventId,
				eventType: input.eventType,
				tsEdgeMs: input.tsEdgeMs,
				scope: input.scope,
				chainEpoch,
				seq,
				consentLevel: input.consentLevel,
				redacted: input.redacted,
				payload: input.payload,
				prev,
			});
			const envelope = createEnvelope({
				eventId: input.eventId,
				eventType: input.eventType,
				lane: input.lane,
				tsEdgeMs: input.tsEdgeMs,
				consentLevel: input.consentLevel,
				redacted: input.redacted,
				chainEpoch,
				seq,
				scope: input.scope,
				hashChain: {
					prev,
					self: selfHash,
				},
				payload: input.payload,
			});
			const serialized = serializeEnvelope(envelope);
			const pageSize = this.db.prepare("PRAGMA page_size").get() as PragmaValueRow;
			const projectedBytes =
				this.databaseSizeBytes() +
				Buffer.byteLength(serialized, "utf8") +
				2 * (pageSize.page_size ?? 4_096);
			if (projectedBytes > RETENTION_MAX_BYTES) {
				throw new BufferCapacityError();
			}
			const createdAt = Date.now();
			const insert = this.db
				.prepare(
					`INSERT INTO events (
						event_id, machine_id, agent_id, chain_epoch, seq, self_hash, prev,
						payload, shipped, terminal, created_at, attempts
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`,
				)
				.run(
					input.eventId,
					input.scope.machine_id,
					input.scope.agent_id,
					chainEpoch,
					seq,
					selfHash,
					prev,
					Buffer.from(serialized, "utf8"),
					input.terminal ? 1 : 0,
					createdAt,
				);
			this.db
				.prepare(
					`INSERT INTO chain_tail (
						machine_id, agent_id, chain_epoch, last_seq, last_self_hash, updated_at
					) VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(machine_id, agent_id, chain_epoch)
					DO UPDATE SET
						last_seq = excluded.last_seq,
						last_self_hash = excluded.last_self_hash,
						updated_at = excluded.updated_at`,
				)
				.run(input.scope.machine_id, input.scope.agent_id, chainEpoch, seq, selfHash, createdAt);
			this.db.exec("COMMIT");
			return {
				rowid: Number(insert.lastInsertRowid),
				eventId: input.eventId,
				chainEpoch,
				seq,
				selfHash,
				envelope,
				serialized,
			};
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS events (
				event_id TEXT PRIMARY KEY,
				machine_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				chain_epoch INTEGER NOT NULL,
				seq INTEGER NOT NULL,
				self_hash TEXT NOT NULL,
				prev TEXT NOT NULL,
				payload BLOB NOT NULL,
				shipped INTEGER NOT NULL DEFAULT 0,
				terminal INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0
			);
			CREATE UNIQUE INDEX IF NOT EXISTS events_chain_unique
				ON events(machine_id, agent_id, chain_epoch, seq);
			CREATE INDEX IF NOT EXISTS events_pending_idx
				ON events(shipped, terminal);
			CREATE TABLE IF NOT EXISTS chain_tail (
				machine_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				chain_epoch INTEGER NOT NULL,
				last_seq INTEGER NOT NULL,
				last_self_hash TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY(machine_id, agent_id, chain_epoch)
			);
			CREATE TABLE IF NOT EXISTS quarantine (
				rowid INTEGER NOT NULL,
				event_id TEXT NOT NULL,
				status INTEGER NOT NULL,
				reason TEXT NOT NULL,
				response_body TEXT NOT NULL,
				quarantined_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS chain_state (
				machine_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				chain_epoch INTEGER NOT NULL,
				state TEXT NOT NULL,
				reason TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY(machine_id, agent_id, chain_epoch)
			);
			CREATE TABLE IF NOT EXISTS sender_control (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				retry_not_before INTEGER NOT NULL DEFAULT 0,
				lease_owner TEXT,
				lease_until INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS chain_retry (
				machine_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				chain_epoch INTEGER NOT NULL,
				retry_not_before INTEGER NOT NULL,
				PRIMARY KEY(machine_id, agent_id, chain_epoch)
			);
			CREATE TABLE IF NOT EXISTS maintenance_control (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				lease_owner TEXT,
				lease_until_ms INTEGER NOT NULL DEFAULT 0,
				phase TEXT NOT NULL DEFAULT 'idle',
				protected_inventory_json TEXT,
				last_compaction_at_ms INTEGER,
				last_reason TEXT NOT NULL DEFAULT 'not_run',
				updated_at_ms INTEGER NOT NULL DEFAULT 0
			);
			INSERT OR IGNORE INTO sender_control (id) VALUES (1);
			INSERT OR IGNORE INTO maintenance_control (id) VALUES (1);
		`);
		const quarantineColumns = this.db.prepare("PRAGMA table_info(quarantine)").all() as TableInfoRow[];
		if (!quarantineColumns.some((column) => column.name === "reason")) {
			this.db.exec(
				"ALTER TABLE quarantine ADD COLUMN reason TEXT NOT NULL DEFAULT 'unspecified'",
			);
		}
	}

	private getTailInsideTx(
		machineId: string,
		agentId: AgentId,
		chainEpoch: number,
	): TailRow | undefined {
		return this.db
			.prepare(
				`SELECT last_seq, last_self_hash
				FROM chain_tail
				WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ?`,
			)
			.get(machineId, agentId, chainEpoch) as TailRow | undefined;
	}

	private getCurrentEpochInsideTx(machineId: string, agentId: AgentId): number {
		const row = this.db
			.prepare(
				`SELECT MAX(chain_epoch) AS chain_epoch
				FROM chain_tail
				WHERE machine_id = ? AND agent_id = ?`,
			)
			.get(machineId, agentId) as EpochRow | undefined;
		return row?.chain_epoch ?? 0;
	}

	private getChainRecoveryStateInsideTx(
		machineId: string,
		agentId: AgentId,
		chainEpoch: number,
	): ChainRecoveryState | null {
		const row = this.db
			.prepare(
				`SELECT state FROM chain_state
				WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ?`,
			)
			.get(machineId, agentId, chainEpoch) as ChainStateRow | undefined;
		return row?.state ?? null;
	}

	private senderControl(): SenderControlRow {
		return this.db.prepare("SELECT * FROM sender_control WHERE id = 1").get() as SenderControlRow;
	}

	private maintenanceControl(): MaintenanceControlRow {
		const control = this.readMaintenanceControl();
		if (!isMaintenanceControlRow(control)) {
			throw new Error("sno observe maintenance metadata is invalid");
		}
		return control;
	}

	private readMaintenanceControl(): unknown {
		return this.db
			.prepare(
				`SELECT lease_owner, lease_until_ms, phase, protected_inventory_json,
					last_compaction_at_ms, last_reason, updated_at_ms
				FROM maintenance_control WHERE id = 1`,
			)
			.get();
	}

	private hasMalformedRetentionMetadata(): boolean {
		return (
			this.count(
				`SELECT COUNT(*) AS count FROM chain_state
				WHERE typeof(state) != 'text' OR state NOT IN ('reseed_required', 'retired')`,
			) > 0 ||
			this.count(
				`SELECT COUNT(*) AS count FROM chain_retry
				WHERE typeof(retry_not_before) != 'integer' OR retry_not_before < 0`,
			) > 0
		);
	}

	private acquireMaintenance(owner: string, now: number): boolean {
		let acquired = false;
		this.withImmediateTransaction(() => {
			acquired =
				this.db
					.prepare(
						`UPDATE maintenance_control
						SET lease_owner = ?, lease_until_ms = ?, phase = 'leased',
							protected_inventory_json = NULL, last_reason = 'not_run', updated_at_ms = ?
						WHERE id = 1 AND phase = 'idle'
							AND (lease_owner IS NULL OR lease_until_ms <= ?)`,
					)
					.run(owner, now + COMPACTION_LEASE_MS, now, now).changes === 1;
		}, true);
		return acquired;
	}

	private transitionMaintenance(
		owner: string,
		leaseUntilMs: number,
		phase: string,
		inventory: string | null,
		reason: CompactionReason,
		updatedAtMs: number,
	): void {
		this.withImmediateTransaction(() => {
			const changed = this.db
				.prepare(
					`UPDATE maintenance_control
					SET lease_owner = ?, lease_until_ms = ?, phase = ?,
						protected_inventory_json = ?, last_reason = ?, updated_at_ms = ?
					WHERE id = 1 AND lease_owner = ?`,
				)
				.run(owner, leaseUntilMs, phase, inventory, reason, updatedAtMs, owner).changes;
			if (changed !== 1) {
				throw new Error("sno observe maintenance lease ownership changed");
			}
		}, true);
	}

	private releaseMaintenance(owner: string, reason: CompactionReason, now: number): void {
		this.transitionMaintenance(owner, 0, "idle", null, reason, now);
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					`UPDATE maintenance_control SET lease_owner = NULL
					WHERE id = 1 AND lease_owner = ? AND phase = 'idle'`,
				)
				.run(owner);
		}, true);
	}

	private completeMaintenance(owner: string, now: number): void {
		this.withImmediateTransaction(() => {
			const changed = this.db
				.prepare(
					`UPDATE maintenance_control
					SET lease_owner = NULL, lease_until_ms = 0, phase = 'idle',
						protected_inventory_json = NULL, last_compaction_at_ms = ?,
						last_reason = 'completed', updated_at_ms = ?
					WHERE id = 1 AND lease_owner = ?`,
				)
				.run(now, now, owner).changes;
			if (changed !== 1) {
				throw new Error("sno observe maintenance lease ownership changed");
			}
		}, true);
	}

	private recoverInterruptedMaintenance(now = Date.now(), recoveringOwner?: string): void {
		const rawControl = this.readMaintenanceControl();
		if (!isMaintenanceControlRow(rawControl)) {
			return;
		}
		const control = rawControl;
		const backupPath = `${this.path}.pre-compaction.bak`;
		if (control.phase === "idle") {
			this.recoverIdleBackup(backupPath, control, now);
			return;
		}
		if (
			control.lease_until_ms > now ||
			(control.lease_owner !== recoveringOwner && maintenanceOwnerIsRunning(control.lease_owner))
		) {
			return;
		}
		if (control.phase === "leased") {
			if (this.db.pragma("integrity_check", { simple: true }) !== "ok") {
				this.markRecoveryRequired(control, now, "pre_backup_primary_integrity_failed");
			}
			if (existsSync(backupPath)) {
				unlinkSync(backupPath);
			}
			this.clearInterruptedMaintenance(now);
			return;
		}
		if (control.protected_inventory_json === null || !existsSync(backupPath)) {
			this.markRecoveryRequired(control, now, "verified_backup_missing");
		}
		const backup = new DatabaseConstructor(backupPath, { readonly: true });
		try {
			const primarySafe =
				this.db.pragma("integrity_check", { simple: true }) === "ok" &&
				this.protectedInventory(this.db) === control.protected_inventory_json;
			const backupSafe =
				backup.pragma("integrity_check", { simple: true }) === "ok" &&
				this.protectedInventory(backup) === control.protected_inventory_json;
			if (!primarySafe || !backupSafe) {
				this.markRecoveryRequired(control, now, "primary_or_backup_verification_failed");
			}
		} finally {
			backup.close();
		}
		unlinkSync(backupPath);
		this.clearInterruptedMaintenance(now);
	}

	private recoverIdleBackup(
		backupPath: string,
		control: MaintenanceControlRow,
		now: number,
	): void {
		if (!existsSync(backupPath)) {
			return;
		}
		const backup = new DatabaseConstructor(backupPath, { readonly: true });
		try {
			const safe =
				this.db.pragma("integrity_check", { simple: true }) === "ok" &&
				backup.pragma("integrity_check", { simple: true }) === "ok" &&
				this.protectedInventory(this.db) === this.protectedInventory(backup);
			if (!safe) {
				this.markRecoveryRequired(control, now, "idle_backup_verification_failed");
			}
		} finally {
			backup.close();
		}
		unlinkSync(backupPath);
	}

	private expireOwnedMaintenance(owner: string, now: number): void {
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					`UPDATE maintenance_control SET lease_until_ms = ?, updated_at_ms = ?
					WHERE id = 1 AND lease_owner = ?`,
				)
				.run(now, now, owner);
		}, true);
	}

	private markRecoveryRequired(
		control: MaintenanceControlRow,
		detectedAtMs: number,
		reason: string,
	): never {
		const markerPath = this.recoveryMarkerPath();
		const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
		const payload = `${JSON.stringify({
			schema_version: 1,
			attempt_owner: control.lease_owner,
			detected_at_ms: detectedAtMs,
			reason,
			primary: basename(this.path),
			backup: basename(`${this.path}.pre-compaction.bak`),
		})}\n`;
		const file = openSync(temporaryPath, "wx", 0o600);
		try {
			writeFileSync(file, payload, "utf8");
			fsyncSync(file);
		} finally {
			closeSync(file);
		}
		renameSync(temporaryPath, markerPath);
		const directory = openSync(dirname(markerPath), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
		throw new Error("sno observe maintenance recovery requires operator action");
	}

	private recoveryMarkerPath(): string {
		return `${this.path}.recovery-required.json`;
	}

	private clearInterruptedMaintenance(now: number): void {
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					`UPDATE maintenance_control
					SET lease_owner = NULL, lease_until_ms = 0, phase = 'idle',
						protected_inventory_json = NULL,
						last_reason = 'interrupted_primary_recovered', updated_at_ms = ?
					WHERE id = 1 AND lease_until_ms <= ?`,
				)
				.run(now, now);
		}, true);
	}

	private assertMaintenanceWritable(now = Date.now()): void {
		const rawControl = this.readMaintenanceControl();
		if (!isMaintenanceControlRow(rawControl)) {
			throw new Error("sno observe maintenance metadata is invalid");
		}
		const control = rawControl;
		if (
			control.phase !== "idle" ||
			(control.lease_owner !== null && control.lease_until_ms > now)
		) {
			throw new Error("sno observe maintenance lease blocks buffer mutation");
		}
	}

	private compactionReport(reason: CompactionReason, startedAt: number): RetentionReport {
		const rawMaintenance = this.readMaintenanceControl();
		const lastCompactionAtMs = isMaintenanceControlRow(rawMaintenance)
			? rawMaintenance.last_compaction_at_ms
			: null;
		return {
			deletedEvents: 0,
			deletedChainTail: 0,
			deletedChainState: 0,
			deletedChainRetry: 0,
			...this.readStorageMetrics(),
			maintenanceDurationMs: Date.now() - startedAt,
			lastCompactionAtMs,
			compactionReason: reason,
		};
	}

	private protectedInventory(
		database: InstanceType<typeof DatabaseConstructor>,
	): string {
		const countFrom = (sql: string): number => {
			const row = database.prepare(sql).get() as CountRow | undefined;
			return row?.count ?? 0;
		};
		return JSON.stringify({
			events: countFrom("SELECT COUNT(*) AS count FROM events"),
			quarantine: countFrom("SELECT COUNT(*) AS count FROM quarantine"),
			chainTail: countFrom("SELECT COUNT(*) AS count FROM chain_tail"),
			chainState: countFrom("SELECT COUNT(*) AS count FROM chain_state"),
			chainRetry: countFrom("SELECT COUNT(*) AS count FROM chain_retry"),
			unshippedEvents: countFrom("SELECT COUNT(*) AS count FROM events WHERE shipped = 0"),
			terminalEvents: countFrom("SELECT COUNT(*) AS count FROM events WHERE terminal = 1"),
			activeStateReferences: countFrom(
				`SELECT COUNT(*) AS count FROM chain_state AS state
				WHERE EXISTS (
					SELECT 1 FROM chain_tail AS tail
					WHERE tail.machine_id = state.machine_id
						AND tail.agent_id = state.agent_id
						AND tail.chain_epoch = state.chain_epoch
				)`,
			),
			activeRetryReferences: countFrom(
				`SELECT COUNT(*) AS count FROM chain_retry AS retry
				WHERE EXISTS (
					SELECT 1 FROM chain_tail AS tail
					WHERE tail.machine_id = retry.machine_id
						AND tail.agent_id = retry.agent_id
						AND tail.chain_epoch = retry.chain_epoch
				)`,
			),
		});
	}

	private logCompactionPhase(
		phase: "backup_verified" | "vacuuming" | "reopening" | "completed",
		owner: string,
		attemptStartedAtMs: number,
	): void {
		logger.debug("sno observe buffer compaction phase", {
			maintenance_phase: phase,
			maintenance_owner: owner,
			attempt_started_at_ms: attemptStartedAtMs,
		}, {
			event_name: "sno.observe.internal.buffer.store.logcompactionphase",
			file: "packages/sno-observe/src/internal/buffer-store.ts",
			function: "logCompactionPhase",
			site_id: "sno.observe.internal.buffer.store.logcompactionphase.2",
		});
	}

	private openDatabase(): InstanceType<typeof DatabaseConstructor> {
		const database = new DatabaseConstructor(this.path);
		database.pragma("journal_mode = WAL");
		database.pragma("busy_timeout = 5000");
		return database;
	}

	private count(sql: string, ...params: BindValue[]): number {
		const row = this.db.prepare(sql).get(...params) as CountRow | undefined;
		return row?.count ?? 0;
	}

	private pruneQuarantineInsideTx(maxRows: number, maxAgeMs: number, now: number): number {
		let pruned = this.db
			.prepare("DELETE FROM quarantine WHERE quarantined_at < ?")
			.run(now - maxAgeMs).changes;
		const overflow = this.count("SELECT COUNT(*) AS count FROM quarantine") - maxRows;
		if (overflow > 0) {
			pruned += this.db
				.prepare(
					`DELETE FROM quarantine
					WHERE _rowid_ IN (
						SELECT _rowid_
						FROM quarantine
						ORDER BY quarantined_at ASC, _rowid_ ASC
						LIMIT ?
					)`,
				)
				.run(overflow).changes;
		}
		return pruned;
	}

	private scanChainRetentionInsideTx(): ChainRetentionScanRow[] {
		if (this.chainRetentionCursor !== null) {
			const rows = this.db
				.prepare(CHAIN_RETENTION_SCAN_SQL.afterCursor)
				.all(
					this.chainRetentionCursor.machine_id,
					this.chainRetentionCursor.agent_id,
					this.chainRetentionCursor.chain_epoch,
					CHAIN_RETENTION_SCAN_LIMIT,
					CHAIN_FORENSIC_CLOSED_EPOCHS,
				) as ChainRetentionScanRow[];
			if (rows.length === CHAIN_RETENTION_SCAN_LIMIT) {
				return rows;
			}
			if (rows.length > 0) {
				const cursor = this.chainRetentionCursor;
				const wrapped = (
					this.db
						.prepare(CHAIN_RETENTION_SCAN_SQL.fromStart)
						.all(
							CHAIN_RETENTION_SCAN_LIMIT - rows.length,
							CHAIN_FORENSIC_CLOSED_EPOCHS,
						) as ChainRetentionScanRow[]
				).filter((row) => compareChainRetentionKeys(row, cursor) <= 0);
				return [...rows, ...wrapped];
			}
		}
		return this.db
			.prepare(CHAIN_RETENTION_SCAN_SQL.fromStart)
			.all(CHAIN_RETENTION_SCAN_LIMIT, CHAIN_FORENSIC_CLOSED_EPOCHS) as ChainRetentionScanRow[];
	}

	private deleteOrphanChainRowsInsideTx(table: "chain_state" | "chain_retry"): number {
		const rows = this.db
			.prepare(
				`SELECT child.machine_id, child.agent_id, child.chain_epoch
				FROM ${table} AS child
				WHERE NOT EXISTS (
					SELECT 1 FROM chain_tail AS tail
					WHERE tail.machine_id = child.machine_id
						AND tail.agent_id = child.agent_id
						AND tail.chain_epoch = child.chain_epoch
				)
				AND NOT EXISTS (
					SELECT 1 FROM events AS event
					WHERE event.machine_id = child.machine_id
						AND event.agent_id = child.agent_id
						AND event.chain_epoch = child.chain_epoch
						AND event.shipped = 0
				)
				ORDER BY child.machine_id, child.agent_id, child.chain_epoch
				LIMIT ?`,
			)
			.all(CHAIN_RETENTION_BATCH_SIZE) as ChainRetentionKey[];
		const deleteRow = this.db.prepare(
			`DELETE FROM ${table}
			WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ?`,
		);
		let deleted = 0;
		for (const row of rows) {
			deleted += deleteRow.run(row.machine_id, row.agent_id, row.chain_epoch).changes;
		}
		return deleted;
	}

	private databaseSizeBytes(): number {
		return this.readPageStorageMetrics().databaseSizeBytes;
	}

	private logicalDataSizeBytes(): number {
		return this.readPageStorageMetrics().logicalBytes;
	}

	private readStorageMetrics(): BufferStorageMetrics {
		return {
			...this.readPageStorageMetrics(),
			remainingEpochs: this.count("SELECT COUNT(*) AS count FROM chain_tail"),
		};
	}

	private readPageStorageMetrics(): PageStorageMetrics {
		const pageCount = this.db.prepare("PRAGMA page_count").get() as PragmaValueRow;
		const pageSize = this.db.prepare("PRAGMA page_size").get() as PragmaValueRow;
		const freelistCount = this.db.prepare("PRAGMA freelist_count").get() as PragmaValueRow;
		const totalPages = pageCount.page_count ?? 0;
		const pageSizeBytes = pageSize.page_size ?? 0;
		const freelistPages = freelistCount.freelist_count ?? 0;
		const logicalBytes = Math.max(0, totalPages - freelistPages) * pageSizeBytes;
		const walBytes = fileSize(`${this.path}-wal`);
		return {
			logicalBytes,
			physicalBytes: fileSize(this.path),
			walBytes,
			freelistPages,
			freelistBytes: freelistPages * pageSizeBytes,
			freelistRatio: totalPages === 0 ? 0 : freelistPages / totalPages,
			databaseSizeBytes: logicalBytes + walBytes,
		};
	}

	private checkpointWal(): boolean {
		try {
			const result = this.db.pragma("wal_checkpoint(TRUNCATE)") as unknown;
			const row = Array.isArray(result) ? result[0] : undefined;
			if (!isCheckpointRow(row) || row.busy > 0 || row.checkpointed < row.log) {
				logger.warnRateLimited("buffer-maintenance:checkpoint", "sno observe buffer checkpoint deferred", checkpointWarningContext(this.path, row), {
					event_name: "sno.observe.internal.buffer.store.checkpointwal",
					file: "packages/sno-observe/src/internal/buffer-store.ts",
					function: "checkpointWal",
					site_id: "sno.observe.internal.buffer.store.checkpointwal.3",
				});
				return false;
			}
			return true;
		} catch (error) {
			logger.warnRateLimited("buffer-maintenance:checkpoint", "sno observe buffer checkpoint deferred", { path: this.path, error }, {
				event_name: "sno.observe.internal.buffer.store.checkpointwal",
				file: "packages/sno-observe/src/internal/buffer-store.ts",
				function: "checkpointWal",
				site_id: "sno.observe.internal.buffer.store.checkpointwal.4",
			});
			return false;
		}
	}

	private deleteChainRetryForRow(rowid: number): void {
		this.db
			.prepare(
				`DELETE FROM chain_retry
				WHERE (machine_id, agent_id, chain_epoch) = (
					SELECT machine_id, agent_id, chain_epoch FROM events WHERE rowid = ?
				)`,
			)
			.run(rowid);
	}

	private withImmediateTransaction(fn: () => void, maintenanceMutation = false): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!maintenanceMutation) {
				this.assertMaintenanceWritable();
			}
			fn();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

function greatestChainRetentionKey(rows: ChainRetentionScanRow[]): ChainRetentionKey | null {
	let greatest: ChainRetentionKey | null = null;
	for (const row of rows) {
		if (greatest === null || compareChainRetentionKeys(row, greatest) > 0) {
			greatest = {
				machine_id: row.machine_id,
				agent_id: row.agent_id,
				chain_epoch: row.chain_epoch,
			};
		}
	}
	return greatest;
}

function compareChainRetentionKeys(left: ChainRetentionKey, right: ChainRetentionKey): number {
	const machineOrder = compareSqliteText(left.machine_id, right.machine_id);
	if (machineOrder !== 0) {
		return machineOrder;
	}
	const agentOrder = compareSqliteText(left.agent_id, right.agent_id);
	return agentOrder === 0 ? left.chain_epoch - right.chain_epoch : agentOrder;
}

function compareSqliteText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isCheckpointRow(value: unknown): value is CheckpointRow {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value["busy"] === "number" &&
		typeof value["log"] === "number" &&
		typeof value["checkpointed"] === "number"
	);
}

function checkpointWarningContext(
	path: string,
	row: unknown,
): { path: string; busy?: number; log_pages?: number; checkpointed_pages?: number; result?: string } {
	if (!isCheckpointRow(row)) {
		return { path, result: "missing_or_malformed" };
	}
	return {
		path,
		busy: row.busy,
		log_pages: row.log,
		checkpointed_pages: row.checkpointed,
	};
}

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export function decodeEnvelope(payload: Buffer): WireEnvelope {
	const parsed = JSON.parse(payload.toString("utf8")) as unknown;
	if (!isRecord(parsed)) {
		return parsed as unknown as WireEnvelope;
	}
	const envelopeRecord = parsed as DecodedEnvelopeRecord;
	const hashChain = envelopeRecord.hash_chain;
	if (!isRecord(hashChain)) {
		return parsed as unknown as WireEnvelope;
	}
	const hashChainRecord = hashChain as DecodedHashChainRecord;
	const chainEpoch =
		typeof envelopeRecord.chain_epoch === "number"
			? envelopeRecord.chain_epoch
			: typeof hashChainRecord.chain_epoch === "number"
				? hashChainRecord.chain_epoch
				: undefined;
	const seq =
		typeof envelopeRecord.seq === "number"
			? envelopeRecord.seq
			: typeof hashChainRecord.seq === "number"
				? hashChainRecord.seq
				: undefined;
	if (chainEpoch === undefined || seq === undefined) {
		return parsed as unknown as WireEnvelope;
	}
	return {
		...parsed,
		schema_version: "v1",
		chain_epoch: chainEpoch,
		seq,
		hash_chain: {
			prev: hashChainRecord.prev,
			self: hashChainRecord.self,
		},
	} as unknown as WireEnvelope;
}

interface DecodedEnvelopeRecord extends Record<string, unknown> {
	hash_chain?: unknown;
	chain_epoch?: unknown;
	seq?: unknown;
}

interface DecodedHashChainRecord extends Record<string, unknown> {
	prev?: unknown;
	self?: unknown;
	chain_epoch?: unknown;
	seq?: unknown;
}

function isUniqueConstraintError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return code === "SQLITE_CONSTRAINT_UNIQUE" || error.message.includes("UNIQUE constraint failed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function compactionRequiredFreeBytes(primaryMainBytes: bigint, walBytes: bigint): bigint {
	return 3n * primaryMainBytes + walBytes + BigInt(COMPACTION_SPACE_RESERVE_BYTES);
}

function maintenanceOwnerIsRunning(owner: string | null): boolean {
	if (owner === null) {
		return false;
	}
	const [rawPid, expectedStartToken] = owner.split(":", 3);
	const pid = Number(rawPid);
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return false;
	}
	if (expectedStartToken === undefined || readProcessStartToken(pid) !== expectedStartToken) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isNodeErrorWithCode(error, "ESRCH");
	}
}

function createMaintenanceOwner(): string {
	const startToken = readProcessStartToken(process.pid);
	if (startToken === null) {
		return `${process.pid}:unverifiable:${randomUUID()}`;
	}
	return `${process.pid}:${startToken}:${randomUUID()}`;
}

function readProcessStartToken(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd === -1) {
			return null;
		}
		return stat.slice(commandEnd + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isMaintenanceControlRow(value: unknown): value is MaintenanceControlRow {
	if (!isRecord(value)) {
		return false;
	}
	const phase = value["phase"];
	const owner = value["lease_owner"];
	const inventory = value["protected_inventory_json"];
	return (
		(owner === null || (typeof owner === "string" && owner.length > 0)) &&
		isNonNegativeSafeInteger(value["lease_until_ms"]) &&
		isMaintenancePhase(phase) &&
		(inventory === null || isProtectedInventoryJson(inventory)) &&
		(value["last_compaction_at_ms"] === null ||
			isNonNegativeSafeInteger(value["last_compaction_at_ms"])) &&
		isCompactionReason(value["last_reason"]) &&
		isNonNegativeSafeInteger(value["updated_at_ms"]) &&
		(phase === "idle" ? inventory === null : owner !== null) &&
		(phase === "leased" ? inventory === null : true) &&
		(["backup_verified", "vacuuming", "reopening"].includes(phase)
			? inventory !== null
			: true)
	);
}

function isMaintenancePhase(value: unknown): value is MaintenanceControlRow["phase"] {
	return (
		typeof value === "string" &&
		["idle", "leased", "backup_verified", "vacuuming", "reopening"].includes(value)
	);
}

function isCompactionReason(value: unknown): value is CompactionReason {
	return (
		typeof value === "string" &&
		[
			"not_run",
			"not_needed",
			"lease_busy",
			"checkpoint_busy",
			"invalid_metadata",
			"insufficient_space",
			"backup_failed",
			"backup_verified",
			"vacuuming",
			"reopening",
			"interrupted_primary_recovered",
			"recovery_required",
			"completed",
		].includes(value)
	);
}

function isProtectedInventoryJson(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return (
			isRecord(parsed) &&
			[
				"events",
				"quarantine",
				"chainTail",
				"chainState",
				"chainRetry",
				"unshippedEvents",
				"terminalEvents",
				"activeStateReferences",
				"activeRetryReferences",
			].every((key) => isNonNegativeSafeInteger(parsed[key]))
		);
	} catch {
		return false;
	}
}
