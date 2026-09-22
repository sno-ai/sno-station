import { statSync } from "node:fs";
import { createUUIDv7 } from "@snoai/common-core";
import DatabaseConstructor from "better-sqlite3";
import { computeSelfHash } from "./canonical-hash.js";
import { ChainContentionError, ChainSeedError } from "./errors.js";
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
const QUARANTINE_MAX_ROWS = 1_000;
const QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OVERFLOW_DELETE_BATCH = 100;

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

export interface QuarantineDetail {
	status: number;
	reason: string;
	body: string;
}

export interface CarryForwardResult {
	chainEpoch: number;
	carried: number;
	quarantined: number;
}

export interface RetentionReport {
	deletedEvents: number;
	overflowDeleted: number;
}

export interface QueueStats {
	pendingCount: number;
	oldestPendingAgeMs: number;
	maxAttempts: number;
	quarantinedCount: number;
	latestQuarantineReason: string | null;
	shippedTotal: number;
	databaseSizeBytes: number;
}

/** Builds the `agent.identify` payload that seeds a fresh chain epoch. */
export type IdentifyPayloadFor = (agentId: AgentId, machineId: string) => JsonObject;

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

interface SenderControlRow {
	retry_not_before: number;
	lease_owner: string | null;
	lease_until: number;
	shipped_total: number;
}

interface RetryDeadlineRow {
	retry_not_before: number | null;
}

interface QueueAggregateRow {
	pending_count: number;
	oldest_created_at: number | null;
	max_attempts: number | null;
}

interface QuarantineReasonRow {
	reason: string;
}

const ROW_COLUMNS = `rowid, event_id, machine_id, agent_id, chain_epoch, seq, self_hash, prev,
	payload, shipped, terminal, created_at, attempts`;

export class BufferStore {
	private readonly db: InstanceType<typeof DatabaseConstructor>;

	constructor(readonly path: string) {
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
				let result: AppendResult | undefined;
				this.withImmediateTransaction(() => {
					result = this.appendInsideTx(input);
				});
				if (result === undefined) {
					throw new ChainContentionError();
				}
				return result;
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
				`SELECT ${ROW_COLUMNS} FROM events
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
				`SELECT ${ROW_COLUMNS} FROM events
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
			.prepare(`SELECT ${ROW_COLUMNS} FROM events ORDER BY rowid ASC`)
			.all() as PendingRow[];
	}

	getByEventId(eventId: string): PendingRow | null {
		const row = this.db
			.prepare(`SELECT ${ROW_COLUMNS} FROM events WHERE event_id = ?`)
			.get(eventId) as PendingRow | undefined;
		return row ?? null;
	}

	markShipped(rowid: number): void {
		this.withImmediateTransaction(() => {
			this.deleteChainRetryForRow(rowid);
			this.db.prepare("UPDATE events SET shipped = 1 WHERE rowid = ?").run(rowid);
			this.db
				.prepare("UPDATE sender_control SET shipped_total = shipped_total + 1 WHERE id = 1")
				.run();
		});
	}

	incrementAttempts(rowid: number): void {
		this.withImmediateTransaction(() => {
			this.db.prepare("UPDATE events SET attempts = attempts + 1 WHERE rowid = ?").run(rowid);
		});
	}

	/**
	 * Moves every pending row of `row`'s chain from `row.seq` onward into a fresh epoch,
	 * seeded by a new `agent.identify`. `quarantine: "head"` records the head row as evidence
	 * and drops it; `"all"` records the whole run as evidence and opens no new epoch (the
	 * server will not take any of it right now); `rewrite` lets the caller change what travels.
	 */
	carryForward(
		row: PendingRow,
		identifyPayloadFor: IdentifyPayloadFor,
		options: {
			quarantine?: "head" | "all";
			detail?: QuarantineDetail;
			rewrite?: (envelope: WireEnvelope) => Pick<WireEnvelope, "consent_level" | "payload">;
		} = {},
	): CarryForwardResult {
		const result: CarryForwardResult = { chainEpoch: row.chain_epoch, carried: 0, quarantined: 0 };
		this.withImmediateTransaction(() => {
			const suffix = this.db
				.prepare(
					`SELECT ${ROW_COLUMNS} FROM events
					WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ? AND seq >= ?
						AND shipped = 0 AND terminal = 0
					ORDER BY seq ASC`,
				)
				.all(row.machine_id, row.agent_id, row.chain_epoch, row.seq) as PendingRow[];
			const now = Date.now();
			const deleteRow = this.db.prepare("DELETE FROM events WHERE rowid = ?");
			for (const old of suffix) {
				deleteRow.run(old.rowid);
			}
			this.db
				.prepare(
					"DELETE FROM chain_retry WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ?",
				)
				.run(row.machine_id, row.agent_id, row.chain_epoch);
			const evidenceCount =
				options.quarantine === "all" ? suffix.length : options.quarantine === "head" ? 1 : 0;
			for (const evidence of suffix.slice(0, evidenceCount)) {
				this.insertQuarantineInsideTx(evidence, options.detail ?? { status: 0, reason: "carried", body: "" }, now);
				result.quarantined += 1;
			}
			if (options.quarantine === "all") {
				this.pruneQuarantineInsideTx(now);
				return;
			}
			const envelopes = suffix.slice(evidenceCount).map((old) => decodeEnvelope(old.payload));
			const chainEpoch = this.getCurrentEpochInsideTx(row.machine_id, row.agent_id) + 1;
			const head = decodeEnvelope(row.payload);
			const headRewrite = options.rewrite?.(head);
			this.seedEpochInsideTx({
				agentId: row.agent_id,
				machineId: row.machine_id,
				chainEpoch,
				consentLevel: headRewrite?.consent_level ?? head.consent_level,
				scope: scopeWithoutSession(head.scope),
				payload: identifyPayloadFor(row.agent_id, row.machine_id),
			});
			for (const envelope of envelopes) {
				if (envelope.event_type === "agent.identify") {
					continue;
				}
				const rewritten = options.rewrite?.(envelope);
				this.appendInsideTx({
					eventId: envelope.event_id,
					eventType: envelope.event_type,
					lane: envelope.lane,
					tsEdgeMs: envelope.ts_edge_ms,
					consentLevel: rewritten?.consent_level ?? envelope.consent_level,
					redacted: envelope.redacted,
					scope: envelope.scope,
					payload: rewritten?.payload ?? envelope.payload,
					terminal: false,
					chainEpoch,
				});
				result.carried += 1;
			}
			result.chainEpoch = chainEpoch;
			this.pruneQuarantineInsideTx(now);
		});
		return result;
	}

	getRetryDelay(now = Date.now()): number {
		const control = this.senderControl();
		return Math.max(0, control.retry_not_before - now);
	}

	deferRetriesUntil(deadlineMs: number): void {
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					`UPDATE sender_control SET retry_not_before = MAX(retry_not_before, ?) WHERE id = 1`,
				)
				.run(deadlineMs);
		});
	}

	clearElapsedRetryDeadline(now = Date.now()): void {
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					`UPDATE sender_control SET retry_not_before = 0 WHERE id = 1 AND retry_not_before <= ?`,
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
				.prepare("UPDATE sender_control SET lease_owner = ?, lease_until = ? WHERE id = 1")
				.run(owner, now + leaseMs);
		});
		return retryAfterMs;
	}

	renewFlushLease(owner: string, now = Date.now(), leaseMs = 30_000): boolean {
		let renewed = false;
		this.withImmediateTransaction(() => {
			renewed =
				this.db
					.prepare("UPDATE sender_control SET lease_until = ? WHERE id = 1 AND lease_owner = ?")
					.run(now + leaseMs, owner).changes === 1;
		});
		return renewed;
	}

	releaseFlushLease(owner: string): void {
		this.withImmediateTransaction(() => {
			this.db
				.prepare(
					"UPDATE sender_control SET lease_owner = NULL, lease_until = 0 WHERE id = 1 AND lease_owner = ?",
				)
				.run(owner);
		});
	}

	/**
	 * Deletes shipped and consent-off rows older than a day, closed epochs with no rows left,
	 * and stale quarantine evidence. Over the byte cap the oldest rows go regardless of state;
	 * the count comes back so the caller can say so loudly.
	 */
	pruneRetention(
		maxBytes = RETENTION_MAX_BYTES,
		maxAgeMs = RETENTION_MAX_AGE_MS,
		now = Date.now(),
	): RetentionReport {
		const report: RetentionReport = { deletedEvents: 0, overflowDeleted: 0 };
		this.withImmediateTransaction(() => {
			report.deletedEvents = this.db
				.prepare("DELETE FROM events WHERE (shipped = 1 OR terminal = 1) AND created_at < ?")
				.run(now - maxAgeMs).changes;
			this.db
				.prepare(
					`DELETE FROM chain_tail
					WHERE chain_epoch < (
						SELECT MAX(t.chain_epoch) FROM chain_tail AS t
						WHERE t.machine_id = chain_tail.machine_id AND t.agent_id = chain_tail.agent_id
					)
					AND NOT EXISTS (
						SELECT 1 FROM events
						WHERE events.machine_id = chain_tail.machine_id
							AND events.agent_id = chain_tail.agent_id
							AND events.chain_epoch = chain_tail.chain_epoch
					)`,
				)
				.run();
			this.db
				.prepare(
					`DELETE FROM chain_retry WHERE NOT EXISTS (
						SELECT 1 FROM events
						WHERE events.machine_id = chain_retry.machine_id
							AND events.agent_id = chain_retry.agent_id
							AND events.chain_epoch = chain_retry.chain_epoch
							AND events.shipped = 0 AND events.terminal = 0
					)`,
				)
				.run();
			this.pruneQuarantineInsideTx(now);
			const oldest = this.db.prepare(
				"DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY rowid ASC LIMIT ?)",
			);
			while (this.logicalDataSizeBytes() > maxBytes) {
				const deleted = oldest.run(OVERFLOW_DELETE_BATCH).changes;
				if (deleted === 0) {
					break;
				}
				report.overflowDeleted += deleted;
			}
		});
		if (report.deletedEvents + report.overflowDeleted > 0) {
			this.db.pragma("wal_checkpoint(TRUNCATE)");
		}
		return report;
	}

	countPending(): number {
		return this.count("SELECT COUNT(*) AS count FROM events WHERE shipped = 0 AND terminal = 0");
	}

	countAll(): number {
		return this.count("SELECT COUNT(*) AS count FROM events");
	}

	countShipped(): number {
		return this.senderControl().shipped_total;
	}

	countQuarantined(): number {
		return this.count("SELECT COUNT(*) AS count FROM quarantine");
	}

	getQueueStats(now = Date.now()): QueueStats {
		const aggregate = this.db
			.prepare(
				`SELECT COUNT(*) AS pending_count, MIN(created_at) AS oldest_created_at,
					MAX(attempts) AS max_attempts
				FROM events WHERE shipped = 0 AND terminal = 0`,
			)
			.get() as QueueAggregateRow;
		const latest = this.db
			.prepare("SELECT reason FROM quarantine ORDER BY quarantined_at DESC, _rowid_ DESC LIMIT 1")
			.get() as QuarantineReasonRow | undefined;
		return {
			pendingCount: aggregate.pending_count,
			oldestPendingAgeMs:
				aggregate.oldest_created_at === null ? 0 : Math.max(0, now - aggregate.oldest_created_at),
			maxAttempts: aggregate.max_attempts ?? 0,
			quarantinedCount: this.countQuarantined(),
			latestQuarantineReason: latest?.reason ?? null,
			shippedTotal: this.countShipped(),
			databaseSizeBytes: this.databaseSizeBytes(),
		};
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

	private seedEpochInsideTx(input: {
		agentId: AgentId;
		machineId: string;
		chainEpoch: number;
		consentLevel: ConsentValue;
		scope: EventScope;
		payload: JsonObject;
	}): void {
		this.appendInsideTx({
			eventId: createUUIDv7(),
			eventType: "agent.identify",
			lane: "memory",
			tsEdgeMs: Date.now(),
			consentLevel: input.consentLevel,
			redacted: false,
			scope: { ...input.scope, agent_id: input.agentId, machine_id: input.machineId },
			payload: input.payload,
			terminal: false,
			chainEpoch: input.chainEpoch,
		});
	}

	private appendInsideTx(input: AppendInput): AppendResult {
		const chainEpoch =
			input.chainEpoch ?? this.getCurrentEpochInsideTx(input.scope.machine_id, input.scope.agent_id);
		const tail = this.getTailInsideTx(input.scope.machine_id, input.scope.agent_id, chainEpoch);
		const seq = tail === undefined ? 0 : tail.last_seq + 1;
		const prev = tail === undefined ? GENESIS : tail.last_self_hash;
		// agent.identify is seq 0 of every epoch and nothing else may sit there; a second
		// identify that lost the bootstrap race is skipped by the caller, never blocked.
		if ((seq === 0) !== (input.eventType === "agent.identify")) {
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
			hashChain: { prev, self: selfHash },
			payload: input.payload,
		});
		const serialized = serializeEnvelope(envelope);
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
				`INSERT INTO chain_tail (machine_id, agent_id, chain_epoch, last_seq, last_self_hash, updated_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(machine_id, agent_id, chain_epoch)
				DO UPDATE SET last_seq = excluded.last_seq, last_self_hash = excluded.last_self_hash,
					updated_at = excluded.updated_at`,
			)
			.run(input.scope.machine_id, input.scope.agent_id, chainEpoch, seq, selfHash, createdAt);
		return {
			rowid: Number(insert.lastInsertRowid),
			eventId: input.eventId,
			chainEpoch,
			seq,
			selfHash,
			envelope,
			serialized,
		};
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
			CREATE INDEX IF NOT EXISTS events_pending_idx ON events(shipped, terminal);
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
				reason TEXT NOT NULL DEFAULT 'unspecified',
				response_body TEXT NOT NULL,
				quarantined_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS sender_control (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				retry_not_before INTEGER NOT NULL DEFAULT 0,
				lease_owner TEXT,
				lease_until INTEGER NOT NULL DEFAULT 0,
				shipped_total INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS chain_retry (
				machine_id TEXT NOT NULL,
				agent_id TEXT NOT NULL,
				chain_epoch INTEGER NOT NULL,
				retry_not_before INTEGER NOT NULL,
				PRIMARY KEY(machine_id, agent_id, chain_epoch)
			);
			INSERT OR IGNORE INTO sender_control (id) VALUES (1);
			DROP TABLE IF EXISTS chain_state;
			DROP TABLE IF EXISTS maintenance_control;
			DROP TABLE IF EXISTS consent_transitions;
		`);
		const senderColumns = this.db.prepare("PRAGMA table_info(sender_control)").all() as {
			name: string;
		}[];
		if (!senderColumns.some((column) => column.name === "shipped_total")) {
			this.db.exec(
				"ALTER TABLE sender_control ADD COLUMN shipped_total INTEGER NOT NULL DEFAULT 0",
			);
		}
		const quarantineColumns = this.db.prepare("PRAGMA table_info(quarantine)").all() as {
			name: string;
		}[];
		if (!quarantineColumns.some((column) => column.name === "reason")) {
			this.db.exec("ALTER TABLE quarantine ADD COLUMN reason TEXT NOT NULL DEFAULT 'unspecified'");
		}
	}

	private getTailInsideTx(
		machineId: string,
		agentId: AgentId,
		chainEpoch: number,
	): TailRow | undefined {
		return this.db
			.prepare(
				`SELECT last_seq, last_self_hash FROM chain_tail
				WHERE machine_id = ? AND agent_id = ? AND chain_epoch = ?`,
			)
			.get(machineId, agentId, chainEpoch) as TailRow | undefined;
	}

	private getCurrentEpochInsideTx(machineId: string, agentId: AgentId): number {
		const row = this.db
			.prepare(
				"SELECT MAX(chain_epoch) AS chain_epoch FROM chain_tail WHERE machine_id = ? AND agent_id = ?",
			)
			.get(machineId, agentId) as EpochRow | undefined;
		return row?.chain_epoch ?? 0;
	}

	private senderControl(): SenderControlRow {
		return this.db.prepare("SELECT * FROM sender_control WHERE id = 1").get() as SenderControlRow;
	}

	private insertQuarantineInsideTx(row: PendingRow, detail: QuarantineDetail, now: number): void {
		this.db
			.prepare(
				`INSERT INTO quarantine (rowid, event_id, status, reason, response_body, quarantined_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(row.rowid, row.event_id, detail.status, detail.reason, detail.body.slice(0, 8_192), now);
	}

	private pruneQuarantineInsideTx(now: number): void {
		this.db
			.prepare("DELETE FROM quarantine WHERE quarantined_at < ?")
			.run(now - QUARANTINE_MAX_AGE_MS);
		this.db
			.prepare(
				`DELETE FROM quarantine WHERE _rowid_ NOT IN (
					SELECT _rowid_ FROM quarantine ORDER BY quarantined_at DESC, _rowid_ DESC LIMIT ?
				)`,
			)
			.run(QUARANTINE_MAX_ROWS);
	}

	private count(sql: string, ...params: BindValue[]): number {
		const row = this.db.prepare(sql).get(...params) as CountRow | undefined;
		return row?.count ?? 0;
	}

	private databaseSizeBytes(): number {
		let size = 0;
		for (const suffix of ["", "-wal"]) {
			try {
				size += statSync(`${this.path}${suffix}`).size;
			} catch {
				// A missing WAL file simply contributes nothing.
			}
		}
		return size;
	}

	private logicalDataSizeBytes(): number {
		const pageSize = this.db.pragma("page_size", { simple: true }) as number;
		const pageCount = this.db.pragma("page_count", { simple: true }) as number;
		const freelist = this.db.pragma("freelist_count", { simple: true }) as number;
		return (pageCount - freelist) * pageSize;
	}

	private deleteChainRetryForRow(rowid: number): void {
		this.db
			.prepare(
				`DELETE FROM chain_retry WHERE (machine_id, agent_id, chain_epoch) = (
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

function scopeWithoutSession(scope: EventScope): EventScope {
	const { session_uuid: _session, project_id: _project, ...rest } = scope;
	return rest as EventScope;
}

export function decodeEnvelope(payload: Buffer): WireEnvelope {
	return JSON.parse(payload.toString("utf8")) as WireEnvelope;
}

function isUniqueConstraintError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return code === "SQLITE_CONSTRAINT_UNIQUE" || error.message.includes("UNIQUE constraint failed");
}
