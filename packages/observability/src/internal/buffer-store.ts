import { dirname } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { computeSelfHash } from "./canonical-hash.js";
import { ChainContentionError, ChainSeedError } from "./errors.js";
import { ensureDir } from "./fs-utils.js";
import type {
	AgentId,
	ConsentValue,
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

export interface AppendInput {
	eventId: string;
	eventType: EventType;
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

interface PragmaValueRow {
	page_count?: number;
	page_size?: number;
}

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
			this.db.prepare("UPDATE events SET shipped = 1 WHERE rowid = ?").run(rowid);
		});
	}

	markTerminal(rowid: number): void {
		this.withImmediateTransaction(() => {
			this.db.prepare("UPDATE events SET terminal = 1 WHERE rowid = ?").run(rowid);
		});
	}

	incrementAttempts(rowid: number): void {
		this.withImmediateTransaction(() => {
			this.db.prepare("UPDATE events SET attempts = attempts + 1 WHERE rowid = ?").run(rowid);
		});
	}

	quarantine(row: PendingRow, status: number, body: string): void {
		this.withImmediateTransaction(() => {
			const now = Date.now();
			this.db
				.prepare(
					`INSERT INTO quarantine (rowid, event_id, status, response_body, quarantined_at)
					VALUES (?, ?, ?, ?, ?)`,
				)
				.run(row.rowid, row.event_id, status, body.slice(0, 8_192), now);
			this.db.prepare("UPDATE events SET terminal = 1 WHERE rowid = ?").run(row.rowid);
			this.pruneQuarantineInsideTx(QUARANTINE_MAX_ROWS, QUARANTINE_MAX_AGE_MS, now);
		});
	}

	pruneRetention(
		maxBytes = RETENTION_MAX_BYTES,
		maxAgeMs = RETENTION_MAX_AGE_MS,
		now = Date.now(),
	): number {
		let pruned = 0;
		this.withImmediateTransaction(() => {
			const olderThan = now - maxAgeMs;
			pruned += this.db
				.prepare("DELETE FROM events WHERE shipped = 1 AND created_at < ?")
				.run(olderThan).changes;
			if (this.databaseSizeBytes() <= maxBytes) {
				return;
			}
			const rows = this.db
				.prepare("SELECT rowid FROM events WHERE shipped = 1 ORDER BY created_at ASC, rowid ASC")
				.all() as RowIdRow[];
			const deleteRow = this.db.prepare("DELETE FROM events WHERE rowid = ? AND shipped = 1");
			const batchSize = 50;
			for (let index = 0; index < rows.length; index += batchSize) {
				for (const row of rows.slice(index, index + batchSize)) {
					pruned += deleteRow.run(row.rowid).changes;
				}
				if (this.databaseSizeBytes() <= maxBytes) {
					break;
				}
			}
		});
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
				chainEpoch: envelope.hash_chain.chain_epoch,
				seq: envelope.hash_chain.seq,
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
				tsEdgeMs: input.tsEdgeMs,
				consentLevel: input.consentLevel,
				redacted: input.redacted,
				scope: input.scope,
				hashChain: {
					chain_epoch: chainEpoch,
					seq,
					prev,
					self: selfHash,
				},
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
				response_body TEXT NOT NULL,
				quarantined_at INTEGER NOT NULL
			);
		`);
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
		const pageCount = this.db.prepare("PRAGMA page_count").get() as PragmaValueRow;
		const pageSize = this.db.prepare("PRAGMA page_size").get() as PragmaValueRow;
		return (pageCount.page_count ?? 0) * (pageSize.page_size ?? 0);
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
