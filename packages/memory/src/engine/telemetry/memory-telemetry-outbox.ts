import { FIXED_PROTOCOL_VALUE_74 } from "../../model/signed-registry-constants";
import { createLogger, privateLogReference } from "@snoai/utils/logger";
import type { SqliteDatabaseLike, SqliteStatementLike } from "../../store/sqlite-runtime";
import { recordMemoryTelemetryIncident } from "./memory-telemetry-incidents";
import { validateMemoryTelemetryMetadata } from "./memory-telemetry-metadata";
import type { MemoryTelemetryMetadata } from "./memory-telemetry-types";

type MemoryTelemetryUsageEventType = "recall" | "inject";
type OutboxStatus = "pending" | "failed" | "flushing" | "quarantined";

export interface MemoryTelemetryUsageInput {
	eventType: MemoryTelemetryUsageEventType;
	factId: string;
	memoryKind: string;
	projectId: string;
	agentId?: string;
	sessionUuid?: string;
	turnId?: string;
	retrievalRank?: number;
	retrievalScore?: number;
	metadata: MemoryTelemetryMetadata;
}

export interface MemoryTelemetryUsageSummary {
	recall: number;
	inject: number;
	pendingRecall: number;
	pendingInject: number;
	committedRecall: number;
	committedInject: number;
}

export interface MemoryTelemetryFlushResult {
	selected: number;
	inserted: number;
	deleted: number;
	failed: number;
}

export interface MemoryTelemetryUsageOutboxOptions {
	sqlite: SqliteDatabaseLike;
	dbPath: string;
	agentId?: string;
	batchSize?: number;
}

interface UsageOutboxRow {
	id: number;
	event_type: MemoryTelemetryUsageEventType;
	payload_json: string;
	accepted_at_ms: number;
	status: OutboxStatus;
}

interface ClaimedUsageOutboxRow extends UsageOutboxRow {
	claim_expires_at_ms: number;
}

interface CountRow {
	count: number;
}

const DEFAULT_USAGE_OUTBOX_BATCH_SIZE = 50;
const USAGE_OUTBOX_CLAIM_LEASE_MS = 60_000;
const activeFlushes = new Map<string, Promise<MemoryTelemetryFlushResult>>();
const log = createLogger("sno-station-mem:usage-outbox");

export class MemoryTelemetryUsageOutbox {
	private readonly sqlite: SqliteDatabaseLike;
	private readonly dbPath: string;
	private readonly agentId: string;
	private readonly batchSize: number;
	private readonly insertUsageStatement: SqliteStatementLike;

	constructor(options: MemoryTelemetryUsageOutboxOptions) {
		this.sqlite = options.sqlite;
		this.dbPath = options.dbPath;
		this.agentId = options.agentId ?? FIXED_PROTOCOL_VALUE_74;
		this.batchSize = options.batchSize ?? DEFAULT_USAGE_OUTBOX_BATCH_SIZE;
		this.insertUsageStatement = this.sqlite.prepare(
			`INSERT INTO nodix_memory_usage_outbox
			 (event_type, payload_json, accepted_at_ms, status, attempt_count)
			 VALUES (?, ?, ?, 'pending', 0)`,
		);
	}

	acceptUsage(input: MemoryTelemetryUsageInput): void {
		const payload = normalizeUsageInput(input, this.agentId);
		this.insertUsageStatement.run(payload.event_type, JSON.stringify(payload), Date.now());
	}

	tryAcceptUsage(input: MemoryTelemetryUsageInput): boolean {
		try {
			this.acceptUsage(input);
			return true;
		} catch (error) {
			let incidentPersisted = false;
			try {
				recordMemoryTelemetryIncident(this.sqlite, {
					incidentType: "memory_usage_outbox_accept_failed",
					severity: "error",
					message: "memory telemetry usage accept failed",
					payload: {
						event_type: input.eventType,
						fact_id: input.factId,
						error_code: "usage_accept_failed",
						retry_state: "not_counted",
					},
				});
				incidentPersisted = true;
			} catch {
				// The caller already gets a failed accept result; incident persistence is best-effort.
			}
			log.warn("Memory usage queue acceptance failed", {
				outcome: "failed", error, accepted_count: 0, incident_persisted: incidentPersisted,
				memory_id: input.factId, operation: input.eventType,
				store_reference: privateLogReference(this.dbPath),
			}, {
				event_name: "memory.usage.accept.failed",
				file: "packages/sno-station-mem/src/engine/telemetry/memory-telemetry-outbox.ts",
				function: "MemoryTelemetryUsageOutbox.tryAcceptUsage",
				site_id: "memory.usage.accept.failed",
			});
			return false;
		}
	}

	usageSummary(factId: string): MemoryTelemetryUsageSummary {
		const committedRecall = this.countCommitted(factId, "recall");
		const committedInject = this.countCommitted(factId, "inject");
		const pendingRecall = this.countPending(factId, "recall");
		const pendingInject = this.countPending(factId, "inject");
		return {
			recall: committedRecall + pendingRecall,
			inject: committedInject + pendingInject,
			pendingRecall,
			pendingInject,
			committedRecall,
			committedInject,
		};
	}

	flushPending(batchSize: number = this.batchSize): MemoryTelemetryFlushResult {
		const started = performance.now();
		let rows: ClaimedUsageOutboxRow[];
		try { rows = this.claimFlushRows(batchSize); }
		catch (error) {
			log.warn("Memory usage queue claim failed", {
				error, outcome: "failed", committed_count: 0, duration_ms: performance.now() - started,
				store_reference: privateLogReference(this.dbPath),
			}, {
				event_name: "memory.usage.flush.failed",
				file: "packages/sno-station-mem/src/engine/telemetry/memory-telemetry-outbox.ts",
				function: "MemoryTelemetryUsageOutbox.flushPending",
				site_id: "memory.usage.flush.claim_failed",
			});
			throw error;
		}
		if (rows.length === 0) {
			log.debug("Memory usage queue has no pending rows", {
				outcome: "empty_success", selected_count: 0, committed_count: 0,
				duration_ms: performance.now() - started,
			}, {
				event_name: "memory.usage.flush.completed",
				file: "packages/sno-station-mem/src/engine/telemetry/memory-telemetry-outbox.ts",
				function: "MemoryTelemetryUsageOutbox.flushPending", site_id: "memory.usage.flush.empty",
			});
			return { selected: 0, inserted: 0, deleted: 0, failed: 0 };
		}

		// One IMMEDIATE transaction per claimed batch (not per row). The write lock is
		// held for the whole batch, so no other writer can touch claims mid-flight.
		// Per row: delete-first, then insert — a delete of 0 rows means the claim went
		// stale BEFORE this transaction began, and skipping it can never leave a
		// duplicate event behind. Permanent (unparseable) rows are quarantined inside
		// the same transaction; a transient error rolls the whole batch back (claims
		// stay leased and retry after expiry — the rolled-back inserts vanish with them).
		let inserted = 0;
		let deleted = 0;
		let failed = 0;
		const quarantined: Array<{ row: UsageOutboxRow; message: string }> = [];
		let failingRow: ClaimedUsageOutboxRow | undefined;
		try {
			this.sqlite
				.transaction(() => {
					for (const row of rows) {
						try {
							// Validate BEFORE deleting: an unparseable row must survive as a
							// quarantined row (evidence + retry protection), never be deleted.
							const payload = this.parseValidatedPayload(row);
							if (this.deleteClaimedRow(row) !== 1) continue;
							this.insertEvent(row, payload);
							deleted += 1;
							inserted += 1;
						} catch (error) {
							if (error instanceof PermanentUsageOutboxRowError) {
								const message = safeErrorMessage(error);
								if (this.quarantineClaimedRow(row, message) === 1) {
									failed += 1;
									quarantined.push({ row, message });
								}
								continue;
							}
							failingRow = row;
							throw error;
						}
					}
				})
				.immediate();
		} catch (error) {
			// The batch rolled back; counters describe nothing durable.
			inserted = 0;
			deleted = 0;
			failed = 0;
			log.warn("Memory usage queue flush rolled back", {
				error, outcome: "failed", selected_count: rows.length, committed_count: 0,
				deleted_count: 0, quarantined_count: 0, duration_ms: performance.now() - started,
				store_reference: privateLogReference(this.dbPath),
			}, {
				event_name: "memory.usage.flush.failed",
				file: "packages/sno-station-mem/src/engine/telemetry/memory-telemetry-outbox.ts",
				function: "MemoryTelemetryUsageOutbox.flushPending",
				site_id: "memory.usage.flush.rollback",
			});
			if (failingRow) {
				this.markRowsFailed([failingRow], safeErrorMessage(error));
			}
			throw error;
		}
		for (const entry of quarantined) {
			this.recordQuarantineIncident(entry.row, entry.message);
		}
		log.info("Memory usage queue flush completed", {
			outcome: failed > 0 ? "partial" : "success", selected_count: rows.length,
			committed_count: inserted, deleted_count: deleted, quarantined_count: failed,
			duration_ms: performance.now() - started, store_reference: privateLogReference(this.dbPath),
		}, {
			event_name: "memory.usage.flush.completed",
			file: "packages/sno-station-mem/src/engine/telemetry/memory-telemetry-outbox.ts",
			function: "MemoryTelemetryUsageOutbox.flushPending",
			site_id: "memory.usage.flush.completed",
		});
		return { selected: rows.length, inserted, deleted, failed };
	}

	/**
	 * Bounded catch-up drain: flush batches until a pass claims zero rows or the
	 * time budget is exhausted. Used by the hourly maintenance tick and shutdown so
	 * a historical backlog drains across passes without monopolizing the writer.
	 */
	drainPending(budgetMs = 30_000): MemoryTelemetryFlushResult {
		const startedAt = Date.now();
		const totals: MemoryTelemetryFlushResult = { selected: 0, inserted: 0, deleted: 0, failed: 0 };
		while (Date.now() - startedAt < budgetMs) {
			const pass = this.flushPending();
			totals.selected += pass.selected;
			totals.inserted += pass.inserted;
			totals.deleted += pass.deleted;
			totals.failed += pass.failed;
			if (pass.selected === 0) break;
		}
		return totals;
	}

	/**
	 * Deletes quarantined rows older than the cutoff. Portable batched shape
	 * (`DELETE ... LIMIT` is a compile-option extension — never assume it).
	 */
	pruneQuarantined(cutoffMs: number): number {
		let pruned = 0;
		while (true) {
			const result = this.sqlite
				.prepare(
					`DELETE FROM nodix_memory_usage_outbox
					 WHERE id IN (
					   SELECT id FROM nodix_memory_usage_outbox
					   WHERE status = 'quarantined' AND accepted_at_ms < ?
					   LIMIT 5000
					 )`,
				)
				.run(cutoffMs) as { changes?: number };
			const changes = result.changes ?? 0;
			pruned += changes;
			if (changes === 0) break;
		}
		return pruned;
	}

	flushPendingAsync(batchSize: number = this.batchSize): Promise<MemoryTelemetryFlushResult> {
		const active = activeFlushes.get(this.dbPath);
		if (active) return active;
		const promise = Promise.resolve()
			.then(() => this.flushPending(batchSize))
			.finally(() => {
				if (activeFlushes.get(this.dbPath) === promise) {
					activeFlushes.delete(this.dbPath);
				}
			});
		activeFlushes.set(this.dbPath, promise);
		return promise;
	}

	private countCommitted(factId: string, eventType: MemoryTelemetryUsageEventType): number {
		const row = this.sqlite
			.prepare(
				"SELECT COUNT(*) AS count FROM nodix_memory_events WHERE fact_id = ? AND event_type = ?",
			)
			.get(factId, eventType) as CountRow;
		return row.count;
	}

	private countPending(factId: string, eventType: MemoryTelemetryUsageEventType): number {
		const row = this.sqlite
			.prepare(
				`SELECT COUNT(*) AS count
				 FROM nodix_memory_usage_outbox
				 WHERE event_type = ?
				   AND status IN ('pending', 'failed', 'flushing')
				   AND json_extract(payload_json, '$.fact_id') = ?`,
			)
			.get(eventType, factId) as CountRow;
		return row.count;
	}

	private claimFlushRows(batchSize: number): ClaimedUsageOutboxRow[] {
		const now = Date.now();
		const claimExpiresAt = now + USAGE_OUTBOX_CLAIM_LEASE_MS;
		const tx = this.sqlite.transaction((): ClaimedUsageOutboxRow[] => {
			const candidates = this.readFlushCandidates(batchSize, now);
			const claimed: ClaimedUsageOutboxRow[] = [];
			for (const row of candidates) {
				if (this.claimRow(row.id, now, claimExpiresAt) === 1) {
					claimed.push({ ...row, claim_expires_at_ms: claimExpiresAt });
				}
			}
			return claimed;
		});
		return tx.immediate() as ClaimedUsageOutboxRow[];
	}

	private readFlushCandidates(batchSize: number, now: number): UsageOutboxRow[] {
		return this.sqlite
			.prepare(
				`SELECT id, event_type, payload_json, accepted_at_ms, status
				 FROM nodix_memory_usage_outbox
				 WHERE (
				     status IN ('pending', 'failed')
				     AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
				   )
				   OR (
				     status = 'flushing'
				     AND next_attempt_ms IS NOT NULL
				     AND next_attempt_ms <= ?
				   )
				 ORDER BY id ASC
				 LIMIT ?`,
			)
			.all(now, now, batchSize) as UsageOutboxRow[];
	}

	private claimRow(id: number, now: number, claimExpiresAt: number): number {
		const result = this.sqlite
			.prepare(
				`UPDATE nodix_memory_usage_outbox
				 SET status = 'flushing',
				     last_error = NULL,
				     next_attempt_ms = ?
				 WHERE id = ?
				   AND (
				     (
				       status IN ('pending', 'failed')
				       AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
				     )
				     OR (
				       status = 'flushing'
				       AND next_attempt_ms IS NOT NULL
				       AND next_attempt_ms <= ?
				     )
				   )`,
			)
			.run(claimExpiresAt, id, now, now) as { changes?: number };
		return result.changes ?? 0;
	}

	/** Parses and validates a claimed row; throws PermanentUsageOutboxRowError on bad payloads. */
	private parseValidatedPayload(row: UsageOutboxRow): ValidatedUsagePayload {
		const payload = parseUsagePayload(row);
		try {
			return {
				...payload,
				metadata_json: validateMemoryTelemetryMetadata(payload.event_type, payload.metadata_json),
			};
		} catch (error) {
			if (error instanceof PermanentUsageOutboxRowError) throw error;
			throw new PermanentUsageOutboxRowError(
				`nodix_memory_usage_outbox row ${row.id} has invalid metadata_json: ${safeErrorMessage(error)}`,
			);
		}
	}

	private insertEvent(row: UsageOutboxRow, payload: ValidatedUsagePayload): void {
		const metadata = payload.metadata_json;
		this.sqlite
			.prepare(
				`INSERT INTO nodix_memory_events
				 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id,
				  session_uuid, turn_id, retrieval_rank, retrieval_score, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				payload.event_type,
				payload.fact_id,
				payload.memory_kind,
				row.accepted_at_ms,
				payload.agent_id ?? this.agentId,
				payload.project_id,
				payload.session_uuid,
				payload.turn_id,
				payload.retrieval_rank,
				payload.retrieval_score,
				JSON.stringify(metadata),
			);
	}

	private deleteClaimedRow(row: ClaimedUsageOutboxRow): number {
		const result = this.sqlite
			.prepare(
				`DELETE FROM nodix_memory_usage_outbox
				 WHERE id = ?
				   AND status = 'flushing'
				   AND next_attempt_ms = ?`,
			)
			.run(row.id, row.claim_expires_at_ms) as { changes?: number };
		return result.changes ?? 0;
	}

	private markRowsFailed(rows: readonly ClaimedUsageOutboxRow[], lastError: string): number {
		let changed = 0;
		for (const row of rows) {
			const result = this.sqlite
				.prepare(
					`UPDATE nodix_memory_usage_outbox
					 SET status = 'failed',
					     attempt_count = attempt_count + 1,
					     last_error = ?,
					     next_attempt_ms = NULL
					 WHERE id = ?
					   AND status = 'flushing'
					   AND next_attempt_ms = ?`,
				)
				.run(lastError, row.id, row.claim_expires_at_ms) as { changes?: number };
			changed += result.changes ?? 0;
		}
		return changed;
	}

	private quarantineClaimedRow(row: ClaimedUsageOutboxRow, lastError: string): number {
		const result = this.sqlite
			.prepare(
				`UPDATE nodix_memory_usage_outbox
				 SET status = 'quarantined',
				     attempt_count = attempt_count + 1,
				     last_error = ?,
				     next_attempt_ms = NULL
				 WHERE id = ?
				   AND status = 'flushing'
				   AND next_attempt_ms = ?`,
			)
			.run(lastError, row.id, row.claim_expires_at_ms) as { changes?: number };
		return result.changes ?? 0;
	}

	private recordQuarantineIncident(row: UsageOutboxRow, lastError: string): void {
		try {
			recordMemoryTelemetryIncident(this.sqlite, {
				incidentType: "memory_usage_outbox_quarantined",
				severity: "error",
				message: "memory telemetry usage outbox row quarantined",
				payload: {
					row_id: row.id,
					event_type: row.event_type,
					error_code: "usage_outbox_invalid_payload",
					retry_state: "quarantined",
					last_error: lastError,
				},
			});
		} catch {
			// Quarantine status and last_error remain visible even if incident persistence fails.
		}
	}
}

interface UsagePayload {
	event_type: MemoryTelemetryUsageEventType;
	fact_id: string;
	memory_kind: string;
	project_id: string;
	agent_id: string | null;
	session_uuid: string | null;
	turn_id: string | null;
	retrieval_rank: number | null;
	retrieval_score: number | null;
	metadata_json: MemoryTelemetryMetadata;
}

/** A UsagePayload whose metadata has passed validateMemoryTelemetryMetadata. */
type ValidatedUsagePayload = UsagePayload;

function normalizeUsageInput(
	input: MemoryTelemetryUsageInput,
	defaultAgentId: string,
): UsagePayload {
	if (input.eventType !== "recall" && input.eventType !== "inject") {
		throw new Error(`Unsupported memory telemetry usage event type: ${String(input.eventType)}`);
	}
	if (input.factId.trim().length === 0) {
		throw new Error("memory telemetry usage requires factId");
	}
	if (input.memoryKind.trim().length === 0) {
		throw new Error("memory telemetry usage requires memoryKind");
	}
	if (input.projectId.trim().length === 0) {
		throw new Error("memory telemetry usage requires projectId");
	}
	const metadata = validateMemoryTelemetryMetadata(input.eventType, input.metadata);
	return {
		event_type: input.eventType,
		fact_id: input.factId,
		memory_kind: input.memoryKind,
		project_id: input.projectId,
		agent_id: input.agentId ?? defaultAgentId,
		session_uuid: input.sessionUuid ?? null,
		turn_id: input.turnId ?? null,
		retrieval_rank: input.retrievalRank ?? null,
		retrieval_score: input.retrievalScore ?? null,
		metadata_json: metadata,
	};
}

function parseUsagePayload(row: UsageOutboxRow): UsagePayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.payload_json) as unknown;
	} catch (error) {
		throw new PermanentUsageOutboxRowError(
			`nodix_memory_usage_outbox row ${row.id} has invalid payload_json: ${safeErrorMessage(error)}`,
		);
	}
	if (!isRecord(parsed)) {
		throw new PermanentUsageOutboxRowError(
			`nodix_memory_usage_outbox row ${row.id} has invalid payload`,
		);
	}
	if (parsed.event_type !== row.event_type) {
		throw new PermanentUsageOutboxRowError(
			`nodix_memory_usage_outbox row ${row.id} event type drifted`,
		);
	}
	return {
		event_type: parseUsageEventType(parsed.event_type, row.id),
		fact_id: parseRequiredString(parsed.fact_id, "fact_id", row.id),
		memory_kind: parseRequiredString(parsed.memory_kind, "memory_kind", row.id),
		project_id: parseRequiredString(parsed.project_id, "project_id", row.id),
		agent_id: parseNullableString(parsed.agent_id, "agent_id", row.id),
		session_uuid: parseNullableString(parsed.session_uuid, "session_uuid", row.id),
		turn_id: parseNullableString(parsed.turn_id, "turn_id", row.id),
		retrieval_rank: parseNullableNumber(parsed.retrieval_rank, "retrieval_rank", row.id),
		retrieval_score: parseNullableNumber(parsed.retrieval_score, "retrieval_score", row.id),
		metadata_json: parseMetadata(parsed.metadata_json, row.id),
	};
}

function parseUsageEventType(value: unknown, rowId: number): MemoryTelemetryUsageEventType {
	if (value === "recall" || value === "inject") return value;
	throw new PermanentUsageOutboxRowError(
		`nodix_memory_usage_outbox row ${rowId} has invalid event_type`,
	);
}

function parseRequiredString(value: unknown, field: string, rowId: number): string {
	if (typeof value === "string" && value.trim().length > 0) return value;
	throw new PermanentUsageOutboxRowError(
		`nodix_memory_usage_outbox row ${rowId} has invalid ${field}`,
	);
}

function parseNullableString(value: unknown, field: string, rowId: number): string | null {
	if (value === null) return null;
	if (typeof value === "string") return value;
	throw new PermanentUsageOutboxRowError(
		`nodix_memory_usage_outbox row ${rowId} has invalid ${field}`,
	);
}

function parseNullableNumber(value: unknown, field: string, rowId: number): number | null {
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new PermanentUsageOutboxRowError(
		`nodix_memory_usage_outbox row ${rowId} has invalid ${field}`,
	);
}

function parseMetadata(value: unknown, rowId: number): MemoryTelemetryMetadata {
	if (isRecord(value)) return value;
	throw new PermanentUsageOutboxRowError(
		`nodix_memory_usage_outbox row ${rowId} has invalid metadata_json`,
	);
}

class PermanentUsageOutboxRowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PermanentUsageOutboxRowError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.slice(0, 500);
	}
	return "memory telemetry usage flush failed";
}
