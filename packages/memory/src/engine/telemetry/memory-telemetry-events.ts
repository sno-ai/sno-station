import { FIXED_PROTOCOL_VALUE_74 } from "../../model/signed-registry-constants";
import { createLogger } from "@snoai/utils/logger";
import type { SqliteDatabaseLike, SqliteStatementLike } from "../../store/sqlite-runtime";
import { loadMemoryTelemetryKeySet, type MemoryTelemetryKeySet } from "./memory-telemetry-config";
import { validateMemoryTelemetryMetadata } from "./memory-telemetry-metadata";
import {
	createMemoryTelemetryReceiptService,
	type MemoryTelemetryReceiptService,
} from "./memory-telemetry-receipts";
import type { MemoryTelemetryEventType, MemoryTelemetryMetadata } from "./memory-telemetry-types";

const log = createLogger("sno-station-mem:memory-telemetry-events");

export interface MemoryTelemetryStoreConfig {
	enabled?: boolean;
	agentId?: string;
	currentKeyVersion?: number;
	keySet?: MemoryTelemetryKeySet;
	receiptService?: MemoryTelemetryReceiptService;
}

export interface MemoryTelemetryEventWriterOptions {
	sqlite: SqliteDatabaseLike;
	config?: MemoryTelemetryStoreConfig;
}

export interface WriteReceiptEventInput {
	eventType: Extract<MemoryTelemetryEventType, "create" | "update">;
	factId: string;
	memoryKind: string;
	projectId: string;
	contentHash: string;
	metadata: MemoryTelemetryMetadata;
	timestampMs?: number;
	sourceEventId?: number | null;
	derivedFrom?: readonly string[] | null;
}

export interface WriteLifecycleEventInput {
	eventType: Exclude<MemoryTelemetryEventType, "create" | "recall" | "inject" | "epoch_boundary">;
	factId: string;
	memoryKind: string;
	projectId: string;
	metadata: MemoryTelemetryMetadata;
	timestampMs?: number;
	sourceEventId?: number | null;
	derivedFrom?: readonly string[] | null;
}

export class MemoryTelemetryEventWriter {
	private readonly sqlite: SqliteDatabaseLike;
	private enabled: boolean;
	private readonly agentId: string;
	private readonly receiptService: MemoryTelemetryReceiptService | null;
	private readonly insertReceiptEventStatement: SqliteStatementLike;
	private readonly insertLifecycleEventStatement: SqliteStatementLike;
	private readonly readLatestReceiptEventIdStatement: SqliteStatementLike;

	constructor(options: MemoryTelemetryEventWriterOptions) {
		this.sqlite = options.sqlite;
		this.enabled = options.config?.enabled ?? true;
		this.agentId = options.config?.agentId ?? FIXED_PROTOCOL_VALUE_74;
		this.insertReceiptEventStatement = this.sqlite.prepare(
			`INSERT INTO nodix_memory_events
			 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id,
			  source_event_id, derived_from, content_hash, receipt_hmac, key_version, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.insertLifecycleEventStatement = this.sqlite.prepare(
			`INSERT INTO nodix_memory_events
			 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id,
			  source_event_id, derived_from, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.readLatestReceiptEventIdStatement = this.sqlite.prepare(
			"SELECT id FROM nodix_memory_events WHERE fact_id = ? AND event_type IN ('create', 'update') ORDER BY id DESC LIMIT 1",
		);
		if (!this.enabled) {
			this.receiptService = null;
			return;
		}
		// Receipt signing needs an HMAC key. `loadMemoryTelemetryKeySet` throws
		// when telemetry is enabled but the key env is absent (a deliberate
		// fail-closed contract on the loader). Catch it here and degrade to
		// disabled with a loud warning rather than letting it propagate out of
		// MemoryStore construction: telemetry receipts are best-effort
		// tamper-evidence, and a missing key must NOT brick store construction
		// (and the whole plugin's `register()`). Matches the sno-station-mem rule that
		// observability wiring never throws into agent code.
		try {
			const keySet =
				options.config?.keySet ??
				loadMemoryTelemetryKeySet({
					enabled: true,
					currentKeyVersion: options.config?.currentKeyVersion,
				});
			this.receiptService =
				options.config?.receiptService ?? createMemoryTelemetryReceiptService(keySet);
		} catch (error) {
			log.warn("memory telemetry disabled: receipt key unavailable", {
				error,
			}, {
				event_name: "sno_station_mem.memory-telemetry-events.memory.telemetry.disabled.receipt.key.unavailable",
				file: "packages/sno-station-mem/src/engine/telemetry/memory-telemetry-events.ts",
				function: "<anonymous callback>",
				site_id: "memory-telemetry-events.<anonymous callback>.23cfef2d08",
			});
			this.enabled = false;
			this.receiptService = null;
		}
	}

	writeReceiptEvent(input: WriteReceiptEventInput): void {
		if (!this.enabled) return;
		const timestampMs = input.timestampMs ?? Date.now();
		const receipt = this.requireReceiptService().sign({
			factId: input.factId,
			contentHash: input.contentHash,
			timestampMs,
		});
		const metadata = validateMemoryTelemetryMetadata(input.eventType, input.metadata);
		this.insertReceiptEventStatement.run(
			input.eventType,
			input.factId,
			input.memoryKind,
			timestampMs,
			this.agentId,
			input.projectId,
			input.sourceEventId ?? null,
			input.derivedFrom ? JSON.stringify(input.derivedFrom) : null,
			receipt.contentHash,
			receipt.receiptHmac,
			receipt.keyVersion,
			JSON.stringify(metadata),
		);
	}

	writeLifecycleEvent(input: WriteLifecycleEventInput): void {
		if (!this.enabled) return;
		const timestampMs = input.timestampMs ?? Date.now();
		const metadata = validateMemoryTelemetryMetadata(input.eventType, input.metadata);
		this.insertLifecycleEventStatement.run(
			input.eventType,
			input.factId,
			input.memoryKind,
			timestampMs,
			this.agentId,
			input.projectId,
			input.sourceEventId ?? null,
			input.derivedFrom ? JSON.stringify(input.derivedFrom) : null,
			JSON.stringify(metadata),
		);
	}

	readLatestReceiptEventId(factId: string): number | null {
		if (!this.enabled) return null;
		const row = this.readLatestReceiptEventIdStatement.get(factId) as { id: number } | undefined;
		return row?.id ?? null;
	}

	private requireReceiptService(): MemoryTelemetryReceiptService {
		if (!this.receiptService) {
			throw new Error("memory telemetry receipt service is unavailable");
		}
		return this.receiptService;
	}
}
