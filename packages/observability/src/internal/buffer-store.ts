import { statSync } from "node:fs";
import { dirname } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { computeSelfHash } from "./canonical-hash.js";
import {
	BufferCapacityError,
	ChainContentionError,
	ChainSeedError,
	ChainUnavailableError,
} from "./errors.js";
import { ensureDir } from "./fs-utils.js";
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
const MAX_PENDING_ATTEMPTS = 100;
const QUARANTINE_MAX_ROWS = 1_000;
const QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const QUARANTINE_CAPACITY_RESERVE_BYTES = 1024 * 1024;

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

export type ChainRecoveryState = "reseed_required" | "retired";

export interface QueueStats {
	activeChainRecoveryCount: number;
	activeChainRecoveryReason: string | null;
	pendingCount: number;
	oldestPendingAgeMs: number;
	maxAttempts: number;
	quarantinedCount: number;
	databaseSizeBytes: number;
	latestQuarantineReason: string | null;
}

export type BufferSafeguardReason = "disk_size" | "max_attempts" | "queue_age";

export class BufferStore {
	private readonly db: InstanceType<typeof DatabaseConstructor>;

	constructor(readonly path: string) {
		ensureDir(dirname(path));
		this.db = new DatabaseConstructor(path);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this.migrate();
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
	): number {
		let pruned = 0;
		if (this.databaseSizeBytes() > maxBytes) {
			this.checkpointWal();
		}
		this.withImmediateTransaction(() => {
			const olderThan = now - maxAgeMs;
			pruned += this.db
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
					pruned += deleteRow.run(row.rowid).changes;
				}
				if (this.logicalDataSizeBytes() <= maxBytes) {
					break;
				}
			}
		});
		if (pruned > 0) {
			this.checkpointWal();
		}
		return pruned;
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
			activeChainRecoveryCount: activeRecoveryCount,
			activeChainRecoveryReason: activeRecovery?.reason ?? null,
			pendingCount: aggregate.pending_count,
			oldestPendingAgeMs:
				aggregate.oldest_created_at === null ? 0 : Math.max(0, now - aggregate.oldest_created_at),
			maxAttempts: aggregate.max_attempts ?? 0,
			quarantinedCount: this.countQuarantined(),
			databaseSizeBytes: this.databaseSizeBytes(),
			latestQuarantineReason: latest?.reason ?? null,
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
				this.logicalDataSizeBytes() +
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
			INSERT OR IGNORE INTO sender_control (id) VALUES (1);
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

	private databaseSizeBytes(): number {
		return this.logicalDataSizeBytes() + fileSize(`${this.path}-wal`);
	}

	private logicalDataSizeBytes(): number {
		const pageCount = this.db.prepare("PRAGMA page_count").get() as PragmaValueRow;
		const pageSize = this.db.prepare("PRAGMA page_size").get() as PragmaValueRow;
		const freelistCount = this.db.prepare("PRAGMA freelist_count").get() as PragmaValueRow;
		const usedPages = Math.max(
			0,
			(pageCount.page_count ?? 0) - (freelistCount.freelist_count ?? 0),
		);
		return usedPages * (pageSize.page_size ?? 0);
	}

	private checkpointWal(): void {
		try {
			this.db.pragma("wal_checkpoint(TRUNCATE)");
		} catch {
			// A concurrent reader can defer WAL truncation; the next prune will retry.
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

	private withImmediateTransaction(fn: () => void): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			fn();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
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
