/** @file schema.ts
 * @purpose Defines SQLite tables, indexes, and typed schema contracts for plugin storage.
 * @boundary Drizzle schema, migrations, and store query assumptions.
 * @see connection.ts, store.ts, memory-entry-projector.ts.
 */

import {
	index,
	integer,
	primaryKey,
	real,
	type SQLiteColumn,
	sqliteTable,
	type SQLiteTableWithColumns,
	text,
} from "drizzle-orm/sqlite-core";
import { DEFAULT_IMPORTANCE } from "../../config/index";

type TextColumn<
	Name extends string,
	Table extends string,
	NotNull extends boolean,
	HasDefault extends boolean,
	PrimaryKey extends boolean,
> = SQLiteColumn<
	{
		name: Name;
		tableName: Table;
		dataType: "string";
		columnType: "SQLiteText";
		data: string;
		driverParam: string;
		notNull: NotNull;
		hasDefault: HasDefault;
		isPrimaryKey: PrimaryKey;
		isAutoincrement: false;
		hasRuntimeDefault: false;
		enumValues: [string, ...string[]];
		baseColumn: never;
		identity: undefined;
		generated: undefined;
	},
	object,
	{ length: number | undefined }
>;

type IntegerColumn<
	Name extends string,
	Table extends string,
	NotNull extends boolean,
	HasDefault extends boolean,
	PrimaryKey extends boolean,
> = SQLiteColumn<{
	name: Name;
	tableName: Table;
	dataType: "number";
	columnType: "SQLiteInteger";
	data: number;
	driverParam: number;
	notNull: NotNull;
	hasDefault: HasDefault;
	isPrimaryKey: PrimaryKey;
	isAutoincrement: false;
	hasRuntimeDefault: false;
	enumValues: undefined;
	baseColumn: never;
	identity: undefined;
	generated: undefined;
}>;

type RealColumn<
	Name extends string,
	Table extends string,
	NotNull extends boolean,
	HasDefault extends boolean,
	PrimaryKey extends boolean,
> = SQLiteColumn<{
	name: Name;
	tableName: Table;
	dataType: "number";
	columnType: "SQLiteReal";
	data: number;
	driverParam: number;
	notNull: NotNull;
	hasDefault: HasDefault;
	isPrimaryKey: PrimaryKey;
	isAutoincrement: false;
	hasRuntimeDefault: false;
	enumValues: undefined;
	baseColumn: never;
	identity: undefined;
	generated: undefined;
}>;

// LH: This table is the canonical plugin-owned memory shape; keep host compatibility at adapters, not in the schema core.
// LH: content_hash exists to deduplicate before expensive embedding calls and to keep repeated captures idempotent.
// LH: metadata stays JSON so access data, temporal hints, and extraction provenance can evolve without schema churn.
// LH: project_id is a first-class column because isolation and listing filters need cheap SQL predicates.
// LH: category is native to the five-category memory system and should not be translated through legacy labels.
// LH: The vector companion table stores sqlite-vec bytes, not JSON arrays, to keep distance search compact and direct.
// LH: FTS content mirrors memory text for keyword recall; semantic and lexical indexes intentionally coexist.
// LH: Schema additions should preserve local migration determinism because plugins run inside many user workspaces.
export const nodixMemories: SQLiteTableWithColumns<{
	name: "nodix_memories";
	schema: undefined;
	columns: {
		id: TextColumn<"id", "nodix_memories", true, false, true>;
		text: TextColumn<"text", "nodix_memories", true, false, false>;
		category: TextColumn<"category", "nodix_memories", true, false, false>;
		projectId: TextColumn<"project_id", "nodix_memories", true, false, false>;
		importance: RealColumn<"importance", "nodix_memories", true, true, false>;
		timestamp: IntegerColumn<"timestamp", "nodix_memories", true, false, false>;
		timezone: TextColumn<"timezone", "nodix_memories", true, false, false>;
		metadata: TextColumn<"metadata", "nodix_memories", false, true, false>;
		contentHash: TextColumn<"content_hash", "nodix_memories", true, false, false>;
		factId: TextColumn<"fact_id", "nodix_memories", false, false, false>;
		derivedFrom: TextColumn<"derived_from", "nodix_memories", false, false, false>;
		consolidationEpochId: TextColumn<"consolidation_epoch_id", "nodix_memories", false, false, false>;
		confidenceSource: TextColumn<"confidence_source", "nodix_memories", false, false, false>;
		lane: TextColumn<"lane", "nodix_memories", true, true, false>;
		rawCandidateJson: TextColumn<"raw_candidate_json", "nodix_memories", false, false, false>;
		dispositionReason: TextColumn<"disposition_reason", "nodix_memories", false, false, false>;
		dispositionedAtMs: IntegerColumn<"dispositioned_at_ms", "nodix_memories", false, false, false>;
		subject: TextColumn<"subject", "nodix_memories", false, false, false>;
		attribute: TextColumn<"attribute", "nodix_memories", false, false, false>;
		validFrom: IntegerColumn<"valid_from", "nodix_memories", false, false, false>;
		validUntil: IntegerColumn<"valid_until", "nodix_memories", false, false, false>;
		maturity: TextColumn<"maturity", "nodix_memories", false, false, false>;
		source: TextColumn<"source", "nodix_memories", false, false, false>;
		extractorVersion: TextColumn<"extractor_version", "nodix_memories", false, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_memories", {
	id: text("id").primaryKey(),
	text: text("text").notNull(),
	category: text("category").notNull(),
	projectId: text("project_id").notNull(),
	importance: real("importance").notNull().default(DEFAULT_IMPORTANCE),
	timestamp: integer("timestamp").notNull(),
	timezone: text("timezone").notNull(),
	metadata: text("metadata").default("{}"),
	contentHash: text("content_hash").notNull(),
	factId: text("fact_id"),
	derivedFrom: text("derived_from"),
	consolidationEpochId: text("consolidation_epoch_id"),
	confidenceSource: text("confidence_source"),
	lane: text("lane", { enum: ["active", "parked", "quarantined"] })
		.notNull()
		.default("active"),
	rawCandidateJson: text("raw_candidate_json"),
	dispositionReason: text("disposition_reason"),
	dispositionedAtMs: integer("dispositioned_at_ms"),
	subject: text("subject"),
	attribute: text("attribute"),
	validFrom: integer("valid_from"),
	validUntil: integer("valid_until"),
	maturity: text("maturity"),
	source: text("source"),
	extractorVersion: text("extractor_version"),
});

export const nodixMemoryExtractionTimestamps: SQLiteTableWithColumns<{
	name: "nodix_memory_extraction_timestamps";
	schema: undefined;
	columns: {
		projectId: TextColumn<"project_id", "nodix_memory_extraction_timestamps", true, false, false>;
		replayKey: TextColumn<"replay_key", "nodix_memory_extraction_timestamps", true, false, false>;
		resolvedAtMs: IntegerColumn<
			"resolved_at_ms",
			"nodix_memory_extraction_timestamps",
			true,
			false,
			false
		>;
		timeSource: TextColumn<
			"time_source",
			"nodix_memory_extraction_timestamps",
			false,
			false,
			false
		>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_memory_extraction_timestamps", {
	projectId: text("project_id").notNull(),
	replayKey: text("replay_key").notNull(),
	resolvedAtMs: integer("resolved_at_ms").notNull(),
	timeSource: text("time_source", {
		enum: ["event_at", "session_time", "first_resolution"],
	}),
});

export const nodixMemoryRelations: SQLiteTableWithColumns<{
	name: "nodix_memory_relations";
	schema: undefined;
	columns: {
		sourceCardId: TextColumn<"source_card_id", "nodix_memory_relations", true, false, false>;
		subject: TextColumn<"subject", "nodix_memory_relations", true, false, false>;
		predicate: TextColumn<"predicate", "nodix_memory_relations", true, false, false>;
		object: TextColumn<"object", "nodix_memory_relations", true, false, false>;
		createdAt: IntegerColumn<"created_at", "nodix_memory_relations", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_memory_relations", {
	sourceCardId: text("source_card_id")
		.notNull()
		.references(() => nodixMemories.id, { onDelete: "cascade" }),
	subject: text("subject").notNull(),
	predicate: text("predicate", {
		enum: [
			"IS_A",
			"WORKS_ON",
			"NEEDS",
			"PREFERS",
			"FORBIDS",
			"USES",
			"DEPENDS_ON",
			"CAUSED",
			"FIXED_BY",
			"DECIDED",
			"SUPERSEDES",
			"GOVERNED_BY",
			"OWNED_BY",
			"MEMBER_OF",
			"LOCATED_AT",
			"HAS_SKILL",
			"INTERESTED_IN",
			"HAS_ACCOUNT",
			"HAS_OCCUPATION",
			"HAS_METRIC",
			"WORKS_AT",
			"ATTENDED",
			"MENTIONS",
		],
	}).notNull(),
	object: text("object").notNull(),
	createdAt: integer("created_at").notNull(),
});

export const nodixMemorySuppressions: SQLiteTableWithColumns<{
	name: "nodix_memory_suppressions";
	schema: undefined;
	columns: {
		projectId: TextColumn<"project_id", "nodix_memory_suppressions", true, false, false>;
		subject: TextColumn<"subject", "nodix_memory_suppressions", false, false, false>;
		attribute: TextColumn<"attribute", "nodix_memory_suppressions", false, false, false>;
		contentHash: TextColumn<"content_hash", "nodix_memory_suppressions", false, false, false>;
		createdAt: IntegerColumn<"created_at", "nodix_memory_suppressions", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_memory_suppressions", {
	projectId: text("project_id").notNull(),
	subject: text("subject"),
	attribute: text("attribute"),
	contentHash: text("content_hash"),
	createdAt: integer("created_at").notNull(),
});

export const nodixTodos: SQLiteTableWithColumns<{
	name: "nodix_todos";
	schema: undefined;
	columns: {
		projectId: TextColumn<"project_id", "nodix_todos", true, false, false>;
		activeTaskId: TextColumn<"active_task_id", "nodix_todos", true, false, false>;
		description: TextColumn<"description", "nodix_todos", true, false, false>;
		status: TextColumn<"status", "nodix_todos", true, false, false>;
		openedAt: IntegerColumn<"opened_at", "nodix_todos", true, false, false>;
		transitionedAt: IntegerColumn<"transitioned_at", "nodix_todos", true, false, false>;
		closedAt: IntegerColumn<"closed_at", "nodix_todos", false, false, false>;
		closeReason: TextColumn<"close_reason", "nodix_todos", false, false, false>;
		sourceSession: TextColumn<"source_session", "nodix_todos", true, false, false>;
		extractionPath: TextColumn<"extraction_path", "nodix_todos", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable(
	"nodix_todos",
	{
		projectId: text("project_id").notNull(),
		activeTaskId: text("active_task_id").notNull(),
		description: text("description").notNull(),
		status: text("status", { enum: ["open", "done", "removed"] }).notNull(),
		openedAt: integer("opened_at").notNull(),
		transitionedAt: integer("transitioned_at").notNull(),
		closedAt: integer("closed_at"),
		closeReason: text("close_reason"),
		sourceSession: text("source_session").notNull(),
		extractionPath: text("extraction_path").notNull(),
	},
	(table) => [primaryKey({ columns: [table.projectId, table.activeTaskId] })],
);

export const nodixTodoMigrationReceipts: SQLiteTableWithColumns<{
	name: "nodix_todo_migration_receipts";
	schema: undefined;
	columns: {
		migrationId: TextColumn<"migration_id", "nodix_todo_migration_receipts", true, false, true>;
		beforeCount: IntegerColumn<"before_count", "nodix_todo_migration_receipts", true, false, false>;
		afterCount: IntegerColumn<"after_count", "nodix_todo_migration_receipts", true, false, false>;
		migratedAt: IntegerColumn<"migrated_at", "nodix_todo_migration_receipts", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_todo_migration_receipts", {
	migrationId: text("migration_id").primaryKey(),
	beforeCount: integer("before_count").notNull(),
	afterCount: integer("after_count").notNull(),
	migratedAt: integer("migrated_at").notNull(),
});

export const nodixMemoryEntities: SQLiteTableWithColumns<{
	name: "nodix_memory_entities";
	schema: undefined;
	columns: {
		projectId: TextColumn<"project_id", "nodix_memory_entities", true, false, false>;
		entityId: TextColumn<"entity_id", "nodix_memory_entities", true, false, false>;
		displayName: TextColumn<"display_name", "nodix_memory_entities", true, false, false>;
		normalizedName: TextColumn<"normalized_name", "nodix_memory_entities", true, false, false>;
		createdAt: IntegerColumn<"created_at", "nodix_memory_entities", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable(
	"nodix_memory_entities",
	{
		projectId: text("project_id").notNull(),
		entityId: text("entity_id").notNull(),
		displayName: text("display_name").notNull(),
		normalizedName: text("normalized_name").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.projectId, table.normalizedName] }),
		index("nodix_idx_memory_entities_display_name").on(table.projectId, table.displayName),
		index("nodix_idx_memory_entities_entity_id").on(table.projectId, table.entityId),
	],
);

export const nodixAtomicExtractionLedger: SQLiteTableWithColumns<{
	name: "nodix_atomic_extraction_ledger";
	schema: undefined;
	columns: {
		conversationId: TextColumn<"conversation_id", "nodix_atomic_extraction_ledger", true, false, false>;
		chunkHash: TextColumn<"chunk_hash", "nodix_atomic_extraction_ledger", true, false, false>;
		pipelineVersion: TextColumn<"pipeline_version", "nodix_atomic_extraction_ledger", true, false, false>;
		state: TextColumn<"state", "nodix_atomic_extraction_ledger", true, false, false>;
		rawChunk: TextColumn<"raw_chunk", "nodix_atomic_extraction_ledger", true, false, false>;
		routingSnapshotId: TextColumn<"routing_snapshot_id", "nodix_atomic_extraction_ledger", true, false, false>;
		runParametersJson: TextColumn<"run_parameters_json", "nodix_atomic_extraction_ledger", true, false, false>;
		reprocessReason: TextColumn<"reprocess_reason", "nodix_atomic_extraction_ledger", false, false, false>;
		reprocessAttemptCount: IntegerColumn<"reprocess_attempt_count", "nodix_atomic_extraction_ledger", true, true, false>;
		failedReply: TextColumn<"failed_reply", "nodix_atomic_extraction_ledger", false, false, false>;
		createdAt: IntegerColumn<"created_at", "nodix_atomic_extraction_ledger", true, false, false>;
		updatedAt: IntegerColumn<"updated_at", "nodix_atomic_extraction_ledger", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable(
	"nodix_atomic_extraction_ledger",
	{
		conversationId: text("conversation_id").notNull(),
		chunkHash: text("chunk_hash").notNull(),
		pipelineVersion: text("pipeline_version").notNull(),
		state: text("state", {
			enum: ["open", "calls_recorded", "complete", "pending_reprocess"],
		}).notNull(),
		rawChunk: text("raw_chunk").notNull(),
		routingSnapshotId: text("routing_snapshot_id").notNull(),
		runParametersJson: text("run_parameters_json").notNull(),
		reprocessReason: text("reprocess_reason", {
			enum: [
				"input-overflow",
				"truncation-exhaustion",
				"parse-exhaustion",
			],
		}),
		reprocessAttemptCount: integer("reprocess_attempt_count").notNull().default(0),
		failedReply: text("failed_reply"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.conversationId, table.chunkHash, table.pipelineVersion] }),
	],
);

export const nodixProviderProjectMappings: SQLiteTableWithColumns<{
	name: "nodix_provider_project_mappings";
	schema: undefined;
	columns: {
		userId: TextColumn<"user_id", "nodix_provider_project_mappings", true, false, false>;
		externalSystem: TextColumn<"external_system", "nodix_provider_project_mappings", true, false, false>;
		externalProjectKey: TextColumn<"external_project_key", "nodix_provider_project_mappings", true, false, false>;
		projectId: TextColumn<"project_id", "nodix_provider_project_mappings", true, false, false>;
		createdAtMs: IntegerColumn<"created_at_ms", "nodix_provider_project_mappings", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_provider_project_mappings", {
	userId: text("user_id").notNull(),
	externalSystem: text("external_system").notNull(),
	externalProjectKey: text("external_project_key").notNull(),
	projectId: text("project_id").notNull().unique(),
	createdAtMs: integer("created_at_ms").notNull(),
});

export const nodixProviderAgentMappings: SQLiteTableWithColumns<{
	name: "nodix_provider_agent_mappings";
	schema: undefined;
	columns: {
		userId: TextColumn<"user_id", "nodix_provider_agent_mappings", true, false, false>;
		externalSystem: TextColumn<"external_system", "nodix_provider_agent_mappings", true, false, false>;
		externalAgentKey: TextColumn<"external_agent_key", "nodix_provider_agent_mappings", true, false, false>;
		agentId: TextColumn<"agent_id", "nodix_provider_agent_mappings", true, false, false>;
		createdAtMs: IntegerColumn<"created_at_ms", "nodix_provider_agent_mappings", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_provider_agent_mappings", {
	userId: text("user_id").notNull(),
	externalSystem: text("external_system").notNull(),
	externalAgentKey: text("external_agent_key").notNull(),
	agentId: text("agent_id").notNull().unique(),
	createdAtMs: integer("created_at_ms").notNull(),
});

export const nodixProviderProjectAgents: SQLiteTableWithColumns<{
	name: "nodix_provider_project_agents";
	schema: undefined;
	columns: {
		userId: TextColumn<"user_id", "nodix_provider_project_agents", true, false, false>;
		projectId: TextColumn<"project_id", "nodix_provider_project_agents", true, false, false>;
		agentId: TextColumn<"agent_id", "nodix_provider_project_agents", true, false, false>;
		createdAtMs: IntegerColumn<"created_at_ms", "nodix_provider_project_agents", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_provider_project_agents", {
	userId: text("user_id").notNull(),
	projectId: text("project_id").notNull(),
	agentId: text("agent_id").notNull(),
	createdAtMs: integer("created_at_ms").notNull(),
});

export const memoryEvents: SQLiteTableWithColumns<{
	name: "nodix_memory_events";
	schema: undefined;
	columns: {
		id: IntegerColumn<"id", "nodix_memory_events", true, true, true>;
		eventType: TextColumn<"event_type", "nodix_memory_events", true, false, false>;
		factId: TextColumn<"fact_id", "nodix_memory_events", false, false, false>;
		memoryKind: TextColumn<"memory_kind", "nodix_memory_events", false, false, false>;
		timestampMs: IntegerColumn<"timestamp_ms", "nodix_memory_events", true, false, false>;
		sessionUuid: TextColumn<"session_uuid", "nodix_memory_events", false, false, false>;
		turnId: TextColumn<"turn_id", "nodix_memory_events", false, false, false>;
		agentId: TextColumn<"agent_id", "nodix_memory_events", true, false, false>;
		projectId: TextColumn<"project_id", "nodix_memory_events", false, false, false>;
		tenantId: TextColumn<"tenant_id", "nodix_memory_events", false, false, false>;
		sourceEventId: IntegerColumn<"source_event_id", "nodix_memory_events", false, false, false>;
		derivedFrom: TextColumn<"derived_from", "nodix_memory_events", false, false, false>;
		consolidationEpochId: TextColumn<"consolidation_epoch_id", "nodix_memory_events", false, false, false>;
		contentHash: TextColumn<"content_hash", "nodix_memory_events", false, false, false>;
		receiptHmac: TextColumn<"receipt_hmac", "nodix_memory_events", false, false, false>;
		keyVersion: IntegerColumn<"key_version", "nodix_memory_events", false, false, false>;
		retrievalRank: IntegerColumn<"retrieval_rank", "nodix_memory_events", false, false, false>;
		retrievalScore: RealColumn<"retrieval_score", "nodix_memory_events", false, false, false>;
		queryTenantId: TextColumn<"query_tenant_id", "nodix_memory_events", false, false, false>;
		resultTenantId: TextColumn<"result_tenant_id", "nodix_memory_events", false, false, false>;
		metadataJson: TextColumn<"metadata_json", "nodix_memory_events", false, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_memory_events", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	eventType: text("event_type").notNull(),
	factId: text("fact_id"),
	memoryKind: text("memory_kind"),
	timestampMs: integer("timestamp_ms").notNull(),
	sessionUuid: text("session_uuid"),
	turnId: text("turn_id"),
	agentId: text("agent_id").notNull(),
	projectId: text("project_id"),
	tenantId: text("tenant_id"),
	sourceEventId: integer("source_event_id"),
	derivedFrom: text("derived_from"),
	consolidationEpochId: text("consolidation_epoch_id"),
	contentHash: text("content_hash"),
	receiptHmac: text("receipt_hmac"),
	keyVersion: integer("key_version"),
	retrievalRank: integer("retrieval_rank"),
	retrievalScore: real("retrieval_score"),
	queryTenantId: text("query_tenant_id"),
	resultTenantId: text("result_tenant_id"),
	metadataJson: text("metadata_json"),
});

export const memoryUsageOutbox: SQLiteTableWithColumns<{
	name: "nodix_memory_usage_outbox";
	schema: undefined;
	columns: {
		id: IntegerColumn<"id", "nodix_memory_usage_outbox", true, true, true>;
		eventType: TextColumn<"event_type", "nodix_memory_usage_outbox", true, false, false>;
		payloadJson: TextColumn<"payload_json", "nodix_memory_usage_outbox", true, false, false>;
		acceptedAtMs: IntegerColumn<"accepted_at_ms", "nodix_memory_usage_outbox", true, false, false>;
		status: TextColumn<"status", "nodix_memory_usage_outbox", true, false, false>;
		attemptCount: IntegerColumn<"attempt_count", "nodix_memory_usage_outbox", true, true, false>;
		lastError: TextColumn<"last_error", "nodix_memory_usage_outbox", false, false, false>;
		nextAttemptMs: IntegerColumn<"next_attempt_ms", "nodix_memory_usage_outbox", false, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_memory_usage_outbox", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	eventType: text("event_type").notNull(),
	payloadJson: text("payload_json").notNull(),
	acceptedAtMs: integer("accepted_at_ms").notNull(),
	status: text("status").notNull(),
	attemptCount: integer("attempt_count").notNull().default(0),
	lastError: text("last_error"),
	nextAttemptMs: integer("next_attempt_ms"),
});

export const memoryTelemetryIncidents: SQLiteTableWithColumns<{
	name: "nodix_memory_telemetry_incidents";
	schema: undefined;
	columns: {
		id: IntegerColumn<"id", "nodix_memory_telemetry_incidents", true, true, true>;
		incidentType: TextColumn<"incident_type", "nodix_memory_telemetry_incidents", true, false, false>;
		severity: TextColumn<"severity", "nodix_memory_telemetry_incidents", true, false, false>;
		message: TextColumn<"message", "nodix_memory_telemetry_incidents", true, false, false>;
		payloadJson: TextColumn<"payload_json", "nodix_memory_telemetry_incidents", false, false, false>;
		createdAtMs: IntegerColumn<"created_at_ms", "nodix_memory_telemetry_incidents", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_memory_telemetry_incidents", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	incidentType: text("incident_type").notNull(),
	severity: text("severity").notNull(),
	message: text("message").notNull(),
	payloadJson: text("payload_json"),
	createdAtMs: integer("created_at_ms").notNull(),
});

export const memoryTelemetrySyncState: SQLiteTableWithColumns<{
	name: "nodix_memory_telemetry_sync_state";
	schema: undefined;
	columns: {
		sink: TextColumn<"sink", "nodix_memory_telemetry_sync_state", true, false, true>;
		lastEventId: IntegerColumn<"last_event_id", "nodix_memory_telemetry_sync_state", true, true, false>;
		updatedAtMs: IntegerColumn<"updated_at_ms", "nodix_memory_telemetry_sync_state", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_memory_telemetry_sync_state", {
	sink: text("sink").primaryKey(),
	lastEventId: integer("last_event_id").notNull().default(0),
	updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Write attempts the extraction path could not place. A rejected candidate is
 * preserved here with the raw model output that produced it, so a failed write
 * costs retrievability and never the content. Rows here are NOT memories: no
 * retrieval path reads this table.
 */
export const nodixUnplacedMemoryCandidates: SQLiteTableWithColumns<{
	name: "nodix_unplaced_memory_candidates";
	schema: undefined;
	columns: {
		id: TextColumn<"id", "nodix_unplaced_memory_candidates", true, false, true>;
		projectId: TextColumn<"project_id", "nodix_unplaced_memory_candidates", true, false, false>;
		category: TextColumn<"category", "nodix_unplaced_memory_candidates", true, false, false>;
		text: TextColumn<"text", "nodix_unplaced_memory_candidates", true, false, false>;
		rawCandidateJson: TextColumn<
			"raw_candidate_json",
			"nodix_unplaced_memory_candidates",
			true,
			false,
			false
		>;
		dispositionReason: TextColumn<
			"disposition_reason",
			"nodix_unplaced_memory_candidates",
			true,
			false,
			false
		>;
		dispositionedAtMs: IntegerColumn<
			"dispositioned_at_ms",
			"nodix_unplaced_memory_candidates",
			true,
			false,
			false
		>;
		sessionKey: TextColumn<"session_key", "nodix_unplaced_memory_candidates", false, false, false>;
		dedupeHash: TextColumn<"dedupe_hash", "nodix_unplaced_memory_candidates", true, false, false>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_unplaced_memory_candidates", {
	id: text("id").primaryKey(),
	projectId: text("project_id").notNull(),
	category: text("category").notNull(),
	text: text("text").notNull(),
	rawCandidateJson: text("raw_candidate_json").notNull(),
	dispositionReason: text("disposition_reason").notNull(),
	dispositionedAtMs: integer("dispositioned_at_ms").notNull(),
	sessionKey: text("session_key"),
	dedupeHash: text("dedupe_hash").notNull(),
});

export const nodixProfileRecoveryEntries: SQLiteTableWithColumns<{
	name: "nodix_profile_recovery_entries";
	schema: undefined;
	columns: {
		entryId: TextColumn<"entry_id", "nodix_profile_recovery_entries", true, false, true>;
		mutationAttemptId: TextColumn<
			"mutation_attempt_id",
			"nodix_profile_recovery_entries",
			true,
			false,
			false
		>;
		removedRowId: TextColumn<
			"removed_row_id",
			"nodix_profile_recovery_entries",
			true,
			false,
			false
		>;
		projectId: TextColumn<
			"project_id",
			"nodix_profile_recovery_entries",
			true,
			false,
			false
		>;
		profileFactId: TextColumn<
			"profile_fact_id",
			"nodix_profile_recovery_entries",
			true,
			false,
			false
		>;
		sectionName: TextColumn<
			"section_name",
			"nodix_profile_recovery_entries",
			true,
			false,
			false
		>;
		removedValue: TextColumn<
			"removed_value",
			"nodix_profile_recovery_entries",
			true,
			false,
			false
		>;
		removedAtMs: IntegerColumn<
			"removed_at_ms",
			"nodix_profile_recovery_entries",
			true,
			false,
			false
		>;
	};
	dialect: "sqlite";
}> = sqliteTable("nodix_profile_recovery_entries", {
	entryId: text("entry_id").primaryKey(),
	mutationAttemptId: text("mutation_attempt_id").notNull(),
	removedRowId: text("removed_row_id")
		.notNull()
		.references(() => nodixMemories.id, { onDelete: "cascade" }),
	projectId: text("project_id").notNull(),
	profileFactId: text("profile_fact_id").notNull(),
	sectionName: text("section_name").notNull(),
	removedValue: text("removed_value").notNull(),
	removedAtMs: integer("removed_at_ms").notNull(),
});
