import {
	getSnoStationMemStateDir,
	runWithMemoryAuditSync,
} from "../operations/runtime-audit-log";
import type { SqliteDatabaseLike } from "../../store/sqlite-runtime";
import { loadMemoryTelemetryKeySet, type MemoryTelemetryKeySet } from "./memory-telemetry-config";
import {
	createMemoryTelemetryReceiptService,
	type MemoryTelemetryReceiptService,
} from "./memory-telemetry-receipts";
import {
	createMemoryTelemetryPurgeService,
	type MemoryTelemetryConfirmPurgeInput,
	type MemoryTelemetryPurgePreview,
	type MemoryTelemetryPurgePreviewOptions,
	type MemoryTelemetryPurgeResult,
	type MemoryTelemetryPurgeService,
} from "./memory-telemetry-purge";
import type { MemoryTelemetryEventType, MemoryTelemetryReceiptStatus } from "./memory-telemetry-types";
import type { MemoryTelemetryUsageOutbox } from "./memory-telemetry-outbox";

export interface CreateMemoryTelemetryApiOptions {
	sqlite: SqliteDatabaseLike;
	usageOutbox?: MemoryTelemetryUsageOutbox;
	keySet?: MemoryTelemetryKeySet;
	receiptService?: MemoryTelemetryReceiptService;
	agentId?: string;
}

export interface MemoryTelemetryLatestReceipt {
	eventId: number;
	factId: string;
	memoryRowId: string | null;
	contentHash: string;
	timestampMs: number;
	receiptHmac: string;
	keyVersion: number;
	status: MemoryTelemetryReceiptStatus;
}

export interface MemoryTelemetryVerifyReceiptResult {
	status: MemoryTelemetryReceiptStatus;
	requestedFactId: string;
	terminalFactId: string;
	latestReceipt: MemoryTelemetryLatestReceipt;
	historicalReceipts: MemoryTelemetryLatestReceipt[];
}

export interface MemoryTelemetryProvenanceNode {
	eventId: number;
	eventType: MemoryTelemetryEventType;
	factId: string | null;
	timestampMs: number;
	sourceEventId: number | null;
	derivedFrom: string[];
}

export interface MemoryTelemetryProvenanceChain {
	factId: string;
	currentState: "active" | "superseded" | "deleted" | "purged" | "missing";
	nodes: MemoryTelemetryProvenanceNode[];
}

export interface MemoryTelemetryUsageSummaryInput {
	factId?: string;
	agentId?: string;
	projectId?: string;
	window?: {
		sinceMs?: number;
		untilMs?: number;
	};
}

export interface MemoryTelemetryUsageSummaryResult {
	factId?: string;
	agentId?: string;
	recallCount: number;
	injectionCount: number;
	lastRecalledAt: number | null;
	lastInjectedAt: number | null;
	source: "local";
	cloudForwarding: "ignored";
	tenantBoundary: {
		status: "unavailable";
		queryTenantId: null;
		resultTenantId: null;
	};
}

export interface MemoryTelemetryRecallTraceInput {
	sessionUuid?: string;
	turnId?: string;
}

export interface MemoryTelemetryRecallTraceEvent {
	eventId: number | null;
	factId: string;
	timestampMs: number;
	rank: number | null;
	score: number | null;
	agentId: string | null;
	projectId: string | null;
	source: "nodix_memory_events" | "nodix_memory_usage_outbox";
}

export interface MemoryTelemetryRecallTrace {
	sessionUuid: string;
	turnId: string;
	events: MemoryTelemetryRecallTraceEvent[];
}

export interface MemoryTelemetryEpochReport {
	epochId: string;
	status: "synthetic" | "real" | "unavailable";
	boundaryEvents: number[];
	createdFactIds: string[];
	supersededFactIds: string[];
}

export interface MemoryTelemetryApi {
	verifyReceipt(factId: string): MemoryTelemetryVerifyReceiptResult;
	provenanceChain(factId: string, depth?: number): MemoryTelemetryProvenanceChain;
	editImpactPreview(
		factId: string,
		options?: MemoryTelemetryPurgePreviewOptions,
	): MemoryTelemetryPurgePreview;
	confirmPurge(input: MemoryTelemetryConfirmPurgeInput): MemoryTelemetryPurgeResult;
	usageSummary(input: MemoryTelemetryUsageSummaryInput): MemoryTelemetryUsageSummaryResult;
	recallTrace(input: MemoryTelemetryRecallTraceInput): MemoryTelemetryRecallTrace;
	epochReport(epochId: string): MemoryTelemetryEpochReport;
}

interface MemoryEventRow {
	id: number;
	event_type: string;
	fact_id: string | null;
	memory_kind: string | null;
	timestamp_ms: number;
	session_uuid: string | null;
	turn_id: string | null;
	agent_id: string;
	project_id: string | null;
	source_event_id: number | null;
	derived_from: string | null;
	consolidation_epoch_id: string | null;
	content_hash: string | null;
	receipt_hmac: string | null;
	key_version: number | null;
	retrieval_rank: number | null;
	retrieval_score: number | null;
	query_tenant_id: string | null;
	result_tenant_id: string | null;
	metadata_json: string | null;
}

interface PrimaryMemoryRow {
	id: string;
	fact_id: string;
	content_hash: string;
	timestamp: number;
}

interface UsageOutboxRow {
	id: number;
	event_type: "recall" | "inject";
	payload_json: string;
	accepted_at_ms: number;
}

export function createMemoryTelemetryApi(options: CreateMemoryTelemetryApiOptions): MemoryTelemetryApi {
	const receiptService =
		options.receiptService ??
		createMemoryTelemetryReceiptService(
			options.keySet ?? loadMemoryTelemetryKeySet({ enabled: true }),
		);
	const purgeService = createMemoryTelemetryPurgeService({
		sqlite: options.sqlite,
		agentId: options.agentId,
	});
	return new DefaultMemoryTelemetryApi(options.sqlite, receiptService, purgeService);
}

class DefaultMemoryTelemetryApi implements MemoryTelemetryApi {
	constructor(
		private readonly sqlite: SqliteDatabaseLike,
		private readonly receiptService: MemoryTelemetryReceiptService,
		private readonly purgeService: MemoryTelemetryPurgeService,
	) {}

	verifyReceipt(factId: string): MemoryTelemetryVerifyReceiptResult {
		return runWithMemoryAuditSync({
			stateDir: getSnoStationMemStateDir(),
			event: "memory_read",
			operation: "verifyReceipt",
			startedDetails: {
				requested_fact_id: factId,
				fact_ids: [factId],
				requested_count: 1,
			},
			run: () => this.verifyReceiptUnaudited(factId),
			completedDetails: (result) => ({
				requested_fact_id: result.requestedFactId,
				resolved_fact_id: result.terminalFactId,
				fact_ids: [result.terminalFactId],
				requested_count: 1,
				result_count: 1,
				outcome: result.status,
			}),
		});
	}

	private verifyReceiptUnaudited(factId: string): MemoryTelemetryVerifyReceiptResult {
		const requestedFactId = normalizeRequired(factId, "fact_id");
		const terminalFactId = this.resolveTerminalFactId(requestedFactId);
		const receiptRows = this.readReceiptRows(terminalFactId);
		if (receiptRows.length === 0) {
			throw new Error(`missing fact receipt for fact_id=${requestedFactId}`);
		}
		const historicalReceipts = receiptRows.map((row) => this.verifyReceiptRow(row));
		const latestReceipt = historicalReceipts[historicalReceipts.length - 1];
		if (!latestReceipt) {
			throw new Error(`missing fact receipt for fact_id=${requestedFactId}`);
		}
		const currentHash = this.readCurrentContentHash(terminalFactId);
		const status =
			latestReceipt.status === "valid" && currentHash && currentHash !== latestReceipt.contentHash
				? "tampered"
				: latestReceipt.status;
		return {
			status,
			requestedFactId,
			terminalFactId,
			latestReceipt: { ...latestReceipt, status },
			historicalReceipts,
		};
	}

	provenanceChain(factId: string, depth = 100): MemoryTelemetryProvenanceChain {
		const normalizedFactId = normalizeRequired(factId, "fact_id");
		const rows = this.sqlite
			.prepare(
				`SELECT *
				 FROM nodix_memory_events
				 WHERE fact_id = ?
				 ORDER BY id ASC
				 LIMIT ?`,
			)
			.all(normalizedFactId, normalizeLimit(depth)) as MemoryEventRow[];
		const nodes = rows.map((row) => ({
			eventId: row.id,
			eventType: parseEventType(row.event_type),
			factId: row.fact_id,
			timestampMs: row.timestamp_ms,
			sourceEventId: row.source_event_id,
			derivedFrom: parseStringArray(row.derived_from),
		}));
		return {
			factId: normalizedFactId,
			currentState: currentState(nodes),
			nodes,
		};
	}

	editImpactPreview(
		factId: string,
		options?: MemoryTelemetryPurgePreviewOptions,
	): MemoryTelemetryPurgePreview {
		return this.purgeService.previewImpact(factId, options);
	}

	confirmPurge(input: MemoryTelemetryConfirmPurgeInput): MemoryTelemetryPurgeResult {
		return this.purgeService.confirmPurge(input);
	}

	usageSummary(input: MemoryTelemetryUsageSummaryInput): MemoryTelemetryUsageSummaryResult {
		if (!input.factId && !input.agentId) {
			throw new Error("usage_summary requires fact_id or agent_id");
		}
		const committed = this.readCommittedUsage(input);
		const pending = this.readPendingUsage(input);
		return {
			...(input.factId ? { factId: input.factId } : {}),
			...(input.agentId ? { agentId: input.agentId } : {}),
			recallCount: committed.recallCount + pending.recallCount,
			injectionCount: committed.injectionCount + pending.injectionCount,
			lastRecalledAt: maxNullable(committed.lastRecalledAt, pending.lastRecalledAt),
			lastInjectedAt: maxNullable(committed.lastInjectedAt, pending.lastInjectedAt),
			source: "local",
			cloudForwarding: "ignored",
			tenantBoundary: {
				status: "unavailable",
				queryTenantId: null,
				resultTenantId: null,
			},
		};
	}

	recallTrace(input: MemoryTelemetryRecallTraceInput): MemoryTelemetryRecallTrace {
		const sessionUuid = normalizeRequired(input.sessionUuid, "session_uuid");
		const turnId = normalizeRequired(input.turnId, "turn_id");
		const committed = this.sqlite
			.prepare(
				`SELECT *
				 FROM nodix_memory_events
				 WHERE event_type = 'recall'
				   AND session_uuid = ?
				   AND turn_id = ?
				 ORDER BY timestamp_ms ASC, id ASC`,
			)
			.all(sessionUuid, turnId) as MemoryEventRow[];
		const pending = this.readPendingUsageRows({ sessionUuid, turnId, eventType: "recall" });
		return {
			sessionUuid,
			turnId,
			events: [
				...committed.map((row) => ({
					eventId: row.id,
					factId: row.fact_id ?? "",
					timestampMs: row.timestamp_ms,
					rank: row.retrieval_rank,
					score: row.retrieval_score,
					agentId: row.agent_id,
					projectId: row.project_id,
					source: "nodix_memory_events" as const,
				})),
				...pending.map((row) => ({
					eventId: null,
					factId: row.payload.fact_id,
					timestampMs: row.acceptedAtMs,
					rank: row.payload.retrieval_rank,
					score: row.payload.retrieval_score,
					agentId: row.payload.agent_id,
					projectId: row.payload.project_id,
					source: "nodix_memory_usage_outbox" as const,
				})),
			].sort((a, b) => a.timestampMs - b.timestampMs),
		};
	}

	epochReport(epochId: string): MemoryTelemetryEpochReport {
		const normalizedEpochId = normalizeRequired(epochId, "epoch_id");
		const rows = this.sqlite
			.prepare(
				`SELECT *
				 FROM nodix_memory_events
				 WHERE consolidation_epoch_id = ?
				 ORDER BY id ASC`,
			)
			.all(normalizedEpochId) as MemoryEventRow[];
		if (rows.length === 0) {
			return {
				epochId: normalizedEpochId,
				status: "unavailable",
				boundaryEvents: [],
				createdFactIds: [],
				supersededFactIds: [],
			};
		}
		const boundaryRows = rows.filter((row) => row.event_type === "epoch_boundary");
		const hasSyntheticBoundary = boundaryRows.some(
			(row) => readMetadata(row).subtype === "synthetic",
		);
		return {
			epochId: normalizedEpochId,
			status: hasSyntheticBoundary ? "synthetic" : "real",
			boundaryEvents: boundaryRows.map((row) => row.id),
			createdFactIds: factIdsFor(rows, "create"),
			supersededFactIds: factIdsFor(rows, "supersede"),
		};
	}

	private resolveTerminalFactId(factId: string): string {
		const seen = new Set<string>();
		let current = factId;
		while (!seen.has(current)) {
			seen.add(current);
			const row = this.sqlite
				.prepare(
					`SELECT metadata_json
					 FROM nodix_memory_events
					 WHERE fact_id = ? AND event_type = 'supersede'
					 ORDER BY id DESC
					 LIMIT 1`,
				)
				.get(current) as { metadata_json: string | null } | undefined;
			const nextRowId = row ? readMetadata(row).superseded_by : undefined;
			if (typeof nextRowId !== "string" || nextRowId.trim().length === 0) return current;
			const nextFact = this.sqlite
				.prepare("SELECT fact_id FROM nodix_memories WHERE id = ? LIMIT 1")
				.get(nextRowId) as { fact_id: string | null } | undefined;
			if (!nextFact?.fact_id || nextFact.fact_id === current) return current;
			current = nextFact.fact_id;
		}
		return current;
	}

	private readReceiptRows(factId: string): MemoryEventRow[] {
		return this.sqlite
			.prepare(
				`SELECT *
				 FROM nodix_memory_events
				 WHERE fact_id = ?
				   AND event_type IN ('create', 'update')
				   AND content_hash IS NOT NULL
				   AND receipt_hmac IS NOT NULL
				   AND key_version IS NOT NULL
				 ORDER BY id ASC`,
			)
			.all(factId) as MemoryEventRow[];
	}

	private verifyReceiptRow(row: MemoryEventRow): MemoryTelemetryLatestReceipt {
		const factId = row.fact_id ?? "";
		const contentHash = row.content_hash ?? "";
		const timestampMs = row.timestamp_ms;
		const receiptHmac = row.receipt_hmac ?? "";
		const keyVersion = row.key_version ?? 0;
		const verification = this.receiptService.verify({
			factId,
			contentHash,
			timestampMs,
			receiptHmac,
			keyVersion,
		});
		return {
			eventId: row.id,
			factId,
			memoryRowId: this.readMemoryRowId(factId, contentHash),
			contentHash,
			timestampMs,
			receiptHmac,
			keyVersion,
			status: verification.status,
		};
	}

	private readMemoryRowId(factId: string, contentHash: string): string | null {
		const row = this.sqlite
			.prepare(
				`SELECT id
				 FROM nodix_memories
				 WHERE fact_id = ? AND content_hash = ?
				 ORDER BY timestamp DESC
				 LIMIT 1`,
			)
			.get(factId, contentHash) as { id: string } | undefined;
		return row?.id ?? null;
	}

	private readCurrentContentHash(factId: string): string | null {
		const row = this.sqlite
			.prepare(
				`SELECT id, fact_id, content_hash, timestamp
				 FROM nodix_memories
				 WHERE fact_id = ?
				 ORDER BY timestamp DESC
				 LIMIT 1`,
			)
			.get(factId) as PrimaryMemoryRow | undefined;
		return row?.content_hash ?? null;
	}

	private readCommittedUsage(input: MemoryTelemetryUsageSummaryInput): UsageAggregate {
		const clauses = ["event_type IN ('recall', 'inject')"];
		const params: Array<string | number> = [];
		if (input.factId) {
			clauses.push("fact_id = ?");
			params.push(input.factId);
		}
		if (input.agentId) {
			clauses.push("agent_id = ?");
			params.push(input.agentId);
		}
		if (input.projectId) {
			clauses.push("project_id = ?");
			params.push(input.projectId);
		}
		addWindowClauses(clauses, params, "timestamp_ms", input.window);
		const rows = this.sqlite
			.prepare(
				`SELECT event_type, timestamp_ms
				 FROM nodix_memory_events
				 WHERE ${clauses.join(" AND ")}`,
			)
			.all(...params) as Array<{ event_type: string; timestamp_ms: number }>;
		return aggregateUsageRows(
			rows.map((row) => ({ eventType: row.event_type, timestampMs: row.timestamp_ms })),
		);
	}

	private readPendingUsage(input: MemoryTelemetryUsageSummaryInput): UsageAggregate {
		const rows = this.readPendingUsageRows({
			factId: input.factId,
			agentId: input.agentId,
			projectId: input.projectId,
			window: input.window,
		});
		return aggregateUsageRows(
			rows.map((row) => ({
				eventType: row.payload.event_type,
				timestampMs: row.acceptedAtMs,
			})),
		);
	}

	private readPendingUsageRows(filter: PendingUsageFilter): ParsedPendingUsageRow[] {
		const clauses = ["status IN ('pending', 'failed', 'flushing')"];
		const params: Array<string | number> = [];
		if (filter.eventType) {
			clauses.push("event_type = ?");
			params.push(filter.eventType);
		}
		addWindowClauses(clauses, params, "accepted_at_ms", filter.window);
		const rows = this.sqlite
			.prepare(
				`SELECT id, event_type, payload_json, accepted_at_ms
				 FROM nodix_memory_usage_outbox
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY accepted_at_ms ASC, id ASC`,
			)
			.all(...params) as UsageOutboxRow[];
		return rows.flatMap((row) => {
			const payload = parseUsagePayload(row.payload_json);
			if (!payload) return [];
			if (this.hasCommittedUsage(payload, row.accepted_at_ms)) return [];
			if (filter.factId && payload.fact_id !== filter.factId) return [];
			if (filter.agentId && payload.agent_id !== filter.agentId) return [];
			if (filter.projectId && payload.project_id !== filter.projectId) return [];
			if (filter.sessionUuid && payload.session_uuid !== filter.sessionUuid) return [];
			if (filter.turnId && payload.turn_id !== filter.turnId) return [];
			return [{ id: row.id, acceptedAtMs: row.accepted_at_ms, payload }];
		});
	}

	private hasCommittedUsage(payload: UsagePayload, acceptedAtMs: number): boolean {
		const clauses = ["event_type = ?", "fact_id = ?", "timestamp_ms = ?"];
		const params: Array<string | number> = [
			payload.event_type,
			payload.fact_id,
			acceptedAtMs,
		];
		addNullableMatchClause(clauses, params, "memory_kind", payload.memory_kind);
		addNullableMatchClause(clauses, params, "agent_id", payload.agent_id);
		addNullableMatchClause(clauses, params, "project_id", payload.project_id);
		addNullableMatchClause(clauses, params, "session_uuid", payload.session_uuid);
		addNullableMatchClause(clauses, params, "turn_id", payload.turn_id);
		addNullableMatchClause(clauses, params, "retrieval_rank", payload.retrieval_rank);
		addNullableMatchClause(clauses, params, "retrieval_score", payload.retrieval_score);
		const row = this.sqlite
			.prepare(`SELECT COUNT(*) AS count FROM nodix_memory_events WHERE ${clauses.join(" AND ")}`)
			.get(...params) as { count: number };
		return row.count > 0;
	}
}

interface PendingUsageFilter {
	factId?: string;
	agentId?: string;
	projectId?: string;
	sessionUuid?: string;
	turnId?: string;
	eventType?: "recall" | "inject";
	window?: MemoryTelemetryUsageSummaryInput["window"];
}

interface ParsedPendingUsageRow {
	id: number;
	acceptedAtMs: number;
	payload: UsagePayload;
}

interface UsagePayload {
	event_type: "recall" | "inject";
	fact_id: string;
	memory_kind: string;
	project_id: string | null;
	agent_id: string | null;
	session_uuid: string | null;
	turn_id: string | null;
	retrieval_rank: number | null;
	retrieval_score: number | null;
}

interface UsageAggregate {
	recallCount: number;
	injectionCount: number;
	lastRecalledAt: number | null;
	lastInjectedAt: number | null;
}

function normalizeRequired(value: string | undefined, field: string): string {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	throw new Error(`${field} is required`);
}

function normalizeLimit(value: number): number {
	if (!Number.isFinite(value)) return 100;
	return Math.max(1, Math.min(500, Math.floor(value)));
}

function parseEventType(value: string): MemoryTelemetryEventType {
	switch (value) {
		case "create":
		case "update":
		case "recall":
		case "supersede":
		case "delete":
		case "inject":
		case "epoch_boundary":
		case "purge":
			return value;
		default:
			throw new Error(`unknown memory telemetry event type: ${value}`);
	}
}

function parseStringArray(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function readMetadata(row: { metadata_json: string | null }): Record<string, unknown> {
	if (!row.metadata_json) return {};
	try {
		const parsed = JSON.parse(row.metadata_json) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

function currentState(nodes: readonly MemoryTelemetryProvenanceNode[]): MemoryTelemetryProvenanceChain["currentState"] {
	const last = nodes[nodes.length - 1];
	if (!last) return "missing";
	if (last.eventType === "supersede") return "superseded";
	if (last.eventType === "delete") return "deleted";
	if (last.eventType === "purge") return "purged";
	return "active";
}

function addWindowClauses(
	clauses: string[],
	params: Array<string | number>,
	column: string,
	window?: MemoryTelemetryUsageSummaryInput["window"],
): void {
	if (!window) return;
	if (Number.isFinite(window.sinceMs)) {
		clauses.push(`${column} >= ?`);
		params.push(Number(window.sinceMs));
	}
	if (Number.isFinite(window.untilMs)) {
		clauses.push(`${column} <= ?`);
		params.push(Number(window.untilMs));
	}
}

function addNullableMatchClause(
	clauses: string[],
	params: Array<string | number>,
	column: string,
	value: string | number | null,
): void {
	if (value === null) {
		clauses.push(`${column} IS NULL`);
		return;
	}
	clauses.push(`${column} = ?`);
	params.push(value);
}

function aggregateUsageRows(rows: Array<{ eventType: string; timestampMs: number }>): UsageAggregate {
	let recallCount = 0;
	let injectionCount = 0;
	let lastRecalledAt: number | null = null;
	let lastInjectedAt: number | null = null;
	for (const row of rows) {
		if (row.eventType === "recall") {
			recallCount += 1;
			lastRecalledAt = maxNullable(lastRecalledAt, row.timestampMs);
		}
		if (row.eventType === "inject") {
			injectionCount += 1;
			lastInjectedAt = maxNullable(lastInjectedAt, row.timestampMs);
		}
	}
	return { recallCount, injectionCount, lastRecalledAt, lastInjectedAt };
}

function maxNullable(left: number | null, right: number | null): number | null {
	if (left === null) return right;
	if (right === null) return left;
	return Math.max(left, right);
}

function parseUsagePayload(payloadJson: string): UsagePayload | null {
	try {
		const parsed = JSON.parse(payloadJson) as unknown;
		if (!isRecord(parsed)) return null;
		if (parsed.event_type !== "recall" && parsed.event_type !== "inject") return null;
		const factId = requiredString(parsed.fact_id);
		const memoryKind = requiredString(parsed.memory_kind);
		if (!factId || !memoryKind) return null;
		return {
			event_type: parsed.event_type,
			fact_id: factId,
			memory_kind: memoryKind,
			project_id: nullableString(parsed.project_id),
			agent_id: nullableString(parsed.agent_id),
			session_uuid: nullableString(parsed.session_uuid),
			turn_id: nullableString(parsed.turn_id),
			retrieval_rank: nullableNumber(parsed.retrieval_rank),
			retrieval_score: nullableNumber(parsed.retrieval_score),
		};
	} catch {
		return null;
	}
}

function factIdsFor(rows: readonly MemoryEventRow[], eventType: MemoryTelemetryEventType): string[] {
	return rows.flatMap((row) => (row.event_type === eventType && row.fact_id ? [row.fact_id] : []));
}

function requiredString(value: unknown): string | null {
	if (typeof value === "string" && value.trim().length > 0) return value;
	return null;
}

function nullableString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
