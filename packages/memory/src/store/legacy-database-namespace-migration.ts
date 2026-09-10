import { FIXED_EXTERNAL_VALUE_49, FIXED_EXTERNAL_VALUE_51, FIXED_EXTERNAL_VALUE_52, FIXED_EXTERNAL_VALUE_53, FIXED_EXTERNAL_VALUE_54, FIXED_EXTERNAL_VALUE_55, FIXED_EXTERNAL_VALUE_56, FIXED_EXTERNAL_VALUE_57, FIXED_EXTERNAL_VALUE_58, FIXED_IDX_MEMORY, FIXED_IDX_MEMORY_ACTIVE_TASK_CURRENT_REVISION, FIXED_IDX_MEMORY_ACTIVE_TASK_EVIDENCE_INSTANCE, FIXED_IDX_MEMORY_ACTIVE_TASK_INSTANCES_PROJECTION, FIXED_IDX_MEMORY_MEMORIES_CATEGORY, FIXED_IDX_MEMORY_MEMORIES_CONTENT_HASH, FIXED_IDX_MEMORY_MEMORIES_FACT_ID, FIXED_IDX_MEMORY_MEMORIES_LANE_PROJECT, FIXED_IDX_MEMORY_MEMORIES_PROJECT, FIXED_IDX_MEMORY_MEMORIES_PROJECT_CONTENT_HASH, FIXED_IDX_MEMORY_MEMORIES_PROJECT_FACT_KEY_ACTIVE, FIXED_IDX_MEMORY_MEMORIES_PROJECT_TIMESTAMP, FIXED_MEMORY, FIXED_MEMORY_ACTIVE_TASK_EVIDENCE, FIXED_MEMORY_ACTIVE_TASK_INSTANCES, FIXED_MEMORY_ACTIVE_TASK_MIGRATION_EVIDENCE, FIXED_MEMORY_ACTIVE_TASK_MIGRATION_MANIFESTS, FIXED_MEMORY_ACTIVE_TASK_REVISIONS, FIXED_MEMORY_ACTIVE_TASK_TRANSITIONS, FIXED_MEMORY_CHUNKS, FIXED_MEMORY_CHUNKS_AD, FIXED_MEMORY_CHUNKS_AI, FIXED_MEMORY_CHUNKS_AU, FIXED_MEMORY_CHUNKS_FTS, FIXED_MEMORY_CHUNKS_MEMORY_ID_IDX, FIXED_MEMORY_CHUNKS_MEM_FACET_IDX, FIXED_MEMORY_CHUNKS_MEM_IDX, FIXED_MEMORY_EXTRACTION_TIMESTAMPS, FIXED_MEMORY_MEMORIES, FIXED_MEMORY_MEMORIES_FACT_ID_INSERT_GUARD, FIXED_MEMORY_MEMORIES_FACT_ID_UPDATE_GUARD, FIXED_MEMORY_MIGRATION_MARKERS, FIXED_MEMORY_PROFILE_RECOVERY_ENTRIES, FIXED_MEMORY_PROVIDER_AGENT_MAPPINGS, FIXED_MEMORY_PROVIDER_PROJECT_AGENTS, FIXED_MEMORY_PROVIDER_PROJECT_MAPPINGS, FIXED_MEMORY_TASK_LIFECYCLE_COMMANDS, FIXED_MEMORY_UNPLACED_CANDIDATES, FIXED_VEC_MEMORY, FIXED_VEC_MEMORY_CHUNKS } from "../model/signed-registry-constants";
import type { SqliteDatabaseLike } from "./sqlite-runtime";

interface ObjectRename {
	legacy: string;
	current: string;
}

const TABLE_RENAMES: readonly ObjectRename[] = [
	{ legacy: FIXED_MEMORY_MEMORIES, current: "nodix_memories" },
	{ legacy: FIXED_MEMORY_CHUNKS, current: "nodix_memory_chunks" },
	{ legacy: FIXED_MEMORY_EXTRACTION_TIMESTAMPS, current: "nodix_memory_extraction_timestamps" },
	{ legacy: FIXED_MEMORY_PROVIDER_PROJECT_MAPPINGS, current: "nodix_provider_project_mappings" },
	{ legacy: FIXED_MEMORY_PROVIDER_AGENT_MAPPINGS, current: "nodix_provider_agent_mappings" },
	{ legacy: FIXED_MEMORY_PROVIDER_PROJECT_AGENTS, current: "nodix_provider_project_agents" },
	{ legacy: FIXED_MEMORY_TASK_LIFECYCLE_COMMANDS, current: "nodix_task_lifecycle_commands" },
	{ legacy: FIXED_MEMORY_ACTIVE_TASK_INSTANCES, current: "nodix_active_task_instances" },
	{ legacy: FIXED_MEMORY_ACTIVE_TASK_REVISIONS, current: "nodix_active_task_revisions" },
	{ legacy: FIXED_MEMORY_ACTIVE_TASK_TRANSITIONS, current: "nodix_active_task_transitions" },
	{ legacy: FIXED_MEMORY_ACTIVE_TASK_EVIDENCE, current: "nodix_active_task_evidence" },
	{
		legacy: FIXED_MEMORY_ACTIVE_TASK_MIGRATION_EVIDENCE,
		current: "nodix_active_task_migration_evidence",
	},
	{
		legacy: FIXED_MEMORY_ACTIVE_TASK_MIGRATION_MANIFESTS,
		current: "nodix_active_task_migration_manifests",
	},
	{ legacy: FIXED_MEMORY_UNPLACED_CANDIDATES, current: "nodix_unplaced_memory_candidates" },
	{ legacy: FIXED_MEMORY_PROFILE_RECOVERY_ENTRIES, current: "nodix_profile_recovery_entries" },
	{ legacy: FIXED_MEMORY_MIGRATION_MARKERS, current: "nodix_memory_migration_markers" },
	{ legacy: "memory_events", current: "nodix_memory_events" },
	{ legacy: "memory_usage_outbox", current: "nodix_memory_usage_outbox" },
	{ legacy: "memory_telemetry_incidents", current: "nodix_memory_telemetry_incidents" },
	{ legacy: "memory_telemetry_sync_state", current: "nodix_memory_telemetry_sync_state" },
	{ legacy: "rem_relation_ledger", current: "nodix_rem_relation_ledger" },
	{ legacy: "rem_row_claims", current: "nodix_rem_row_claims" },
	{ legacy: "rem_scan_generations", current: "nodix_rem_scan_generations" },
	{ legacy: "rem_scan_pairs", current: "nodix_rem_scan_pairs" },
	{ legacy: "rem_scan_invocations", current: "nodix_rem_scan_invocations" },
	{ legacy: "rem_pair_stage_budgets", current: "nodix_rem_pair_stage_budgets" },
	{ legacy: "rem_pair_claims", current: "nodix_rem_pair_claims" },
	{ legacy: "rem_journal", current: "nodix_rem_journal" },
	{ legacy: "rem_recovery_history", current: "nodix_rem_recovery_history" },
	{ legacy: "rem_memory_facets", current: "nodix_rem_memory_facets" },
	{ legacy: "rem_facet_recovery", current: "nodix_rem_facet_recovery" },
	{ legacy: "rem_write_verdicts", current: "nodix_rem_write_verdicts" },
	{ legacy: "rem_write_attempts", current: "nodix_rem_write_attempts" },
	{ legacy: "rem_census_rows", current: "nodix_rem_census_rows" },
	{ legacy: "rem_generation_transitions", current: "nodix_rem_generation_transitions" },
	{ legacy: "rem_batch_summaries", current: "nodix_rem_batch_summaries" },
	{ legacy: "rem_verdict_observations", current: "nodix_rem_verdict_observations" },
];

const INDEX_RENAMES: readonly ObjectRename[] = [
	{ legacy: FIXED_IDX_MEMORY_MEMORIES_PROJECT_CONTENT_HASH, current: "nodix_idx_memories_project_content_hash" },
	{ legacy: FIXED_IDX_MEMORY_MEMORIES_PROJECT, current: "nodix_idx_memories_project" },
	{ legacy: FIXED_IDX_MEMORY_MEMORIES_CATEGORY, current: "nodix_idx_memories_category" },
	{ legacy: FIXED_IDX_MEMORY_MEMORIES_PROJECT_TIMESTAMP, current: "nodix_idx_memories_project_timestamp" },
	{ legacy: FIXED_IDX_MEMORY_MEMORIES_CONTENT_HASH, current: "nodix_idx_memories_content_hash" },
	{ legacy: FIXED_IDX_MEMORY_MEMORIES_FACT_ID, current: "nodix_idx_memories_fact_id" },
	{ legacy: "idx_mcm_reflection_items", current: "nodix_idx_memories_reflection_items" },
	{ legacy: "idx_mcm_idempotency_key", current: "nodix_idx_memories_idempotency_key" },
	{ legacy: FIXED_IDX_MEMORY_MEMORIES_LANE_PROJECT, current: "nodix_idx_memories_lane_project" },
	{
		legacy: FIXED_IDX_MEMORY_MEMORIES_PROJECT_FACT_KEY_ACTIVE,
		current: "nodix_idx_memories_project_fact_key_active",
	},
	{ legacy: FIXED_MEMORY_CHUNKS_MEM_IDX, current: "nodix_idx_memory_chunks_memory" },
	{ legacy: FIXED_MEMORY_CHUNKS_MEMORY_ID_IDX, current: "nodix_idx_memory_chunks_memory_id" },
	{ legacy: FIXED_MEMORY_CHUNKS_MEM_FACET_IDX, current: "nodix_idx_memory_chunks_memory_facet" },
	{
		legacy: FIXED_IDX_MEMORY_ACTIVE_TASK_CURRENT_REVISION,
		current: "nodix_idx_active_task_current_revision",
	},
	{
		legacy: FIXED_IDX_MEMORY_ACTIVE_TASK_INSTANCES_PROJECTION,
		current: "nodix_idx_active_task_instances_projection",
	},
	{
		legacy: FIXED_IDX_MEMORY_ACTIVE_TASK_EVIDENCE_INSTANCE,
		current: "nodix_idx_active_task_evidence_instance",
	},
	{ legacy: "idx_unplaced_project_reason", current: "nodix_idx_unplaced_project_reason" },
	{ legacy: "idx_unplaced_dedupe", current: "nodix_idx_unplaced_dedupe" },
	{ legacy: "idx_profile_recovery_lineage", current: "nodix_idx_profile_recovery_lineage" },
	{ legacy: "idx_profile_recovery_attempt", current: "nodix_idx_profile_recovery_attempt" },
	{ legacy: "idx_me_fact", current: "nodix_idx_memory_events_fact" },
	{ legacy: "idx_me_type", current: "nodix_idx_memory_events_type" },
	{ legacy: "idx_me_epoch", current: "nodix_idx_memory_events_epoch" },
	{ legacy: "idx_me_session", current: "nodix_idx_memory_events_session" },
	{ legacy: "idx_me_tenant", current: "nodix_idx_memory_events_tenant" },
	{ legacy: "idx_me_kind", current: "nodix_idx_memory_events_kind" },
	{ legacy: "idx_me_project", current: "nodix_idx_memory_events_project" },
	{ legacy: "idx_me_turn", current: "nodix_idx_memory_events_turn" },
	{ legacy: "idx_me_usage_retention", current: "nodix_idx_memory_events_usage_retention" },
	{ legacy: "idx_muo_status_next", current: "nodix_idx_memory_usage_outbox_status_next" },
	{ legacy: "idx_mti_created", current: "nodix_idx_memory_telemetry_incidents_created" },
];

const LEGACY_TRIGGER_NAMES = [
	FIXED_MEMORY_CHUNKS_AI,
	FIXED_MEMORY_CHUNKS_AD,
	FIXED_MEMORY_CHUNKS_AU,
	FIXED_MEMORY_MEMORIES_FACT_ID_INSERT_GUARD,
	FIXED_MEMORY_MEMORIES_FACT_ID_UPDATE_GUARD,
] as const;

const LEGACY_MEMORY_GUARD_TRIGGER_NAMES = [
	FIXED_MEMORY_MEMORIES_FACT_ID_INSERT_GUARD,
	FIXED_MEMORY_MEMORIES_FACT_ID_UPDATE_GUARD,
] as const;

const KNOWN_LEGACY_OBJECT_NAMES = new Set([
	...TABLE_RENAMES.map(({ legacy }) => legacy),
	...INDEX_RENAMES.map(({ legacy }) => legacy),
	...LEGACY_TRIGGER_NAMES,
	FIXED_VEC_MEMORY_CHUNKS,
]);
const LEGACY_OBJECT_PREFIXES = [FIXED_MEMORY, FIXED_VEC_MEMORY, FIXED_IDX_MEMORY] as const;

export type LegacyDatabaseNamespaceMigrationResult = "empty" | "current" | "migrated";

export function migrateLegacyDatabaseNamespace(
	database: SqliteDatabaseLike,
	configuredVectorDim?: number,
): LegacyDatabaseNamespaceMigrationResult {
	const hasLegacySchema = tableExists(database, FIXED_MEMORY_MEMORIES);
	const hasCurrentSchema = tableExists(database, "nodix_memories");
	if (hasLegacySchema && hasCurrentSchema) {
		throw new Error(FIXED_EXTERNAL_VALUE_49);
	}
	if (!hasLegacySchema) {
		assertLegacyObjectsRemoved(database);
		return hasCurrentSchema ? "current" : "empty";
	}
	assertLegacyBoundarySupported(database);
	if (configuredVectorDim !== undefined) {
		assertLegacyVectorDimensionSupported(database, configuredVectorDim);
	}
	const hadLegacyChunkSearch = tableExists(database, FIXED_MEMORY_CHUNKS_FTS);
	const hadLegacyMemoryGuards = LEGACY_MEMORY_GUARD_TRIGGER_NAMES.some(
		(name) => readSchemaSql(database, "trigger", name) !== undefined,
	);

	database.transaction(() => {
		const rowCounts = readLegacyRowCounts(database);
		const vectorCount = readTableRowCount(database, FIXED_VEC_MEMORY_CHUNKS);
		dropLegacyTriggers(database);
		dropLegacyFts(database);
		renameTables(database);
		migrateLegacyVectors(database);
		renameIndexes(database);
		if (hadLegacyChunkSearch) {
			createCurrentFts(database);
			createChunkTriggers(database);
		}
		if (hadLegacyMemoryGuards) createMemoryGuardTriggers(database);
		assertRowCounts(database, rowCounts);
		assertTableRowCount(database, "nodix_memory_chunk_vectors", vectorCount);
		assertLegacyObjectsRemoved(database);
	}).immediate();
	return "migrated";
}

function assertLegacyBoundarySupported(database: SqliteDatabaseLike): void {
	const rows = database.prepare(FIXED_EXTERNAL_VALUE_51).all() as Array<{
		name?: string;
	}>;
	const columnNames = new Set(rows.map(({ name }) => name).filter((name): name is string => !!name));
	const legacyBoundaryColumn = ["s", "c", "o", "p", "e"].join("");
	if (columnNames.has(legacyBoundaryColumn) && !columnNames.has("project_id")) {
		throw new Error("legacy boundary schema is unsupported for provider v1");
	}
}

function assertLegacyVectorDimensionSupported(
	database: SqliteDatabaseLike,
	configuredVectorDim: number,
): void {
	const legacySql = readSchemaSql(database, "table", FIXED_VEC_MEMORY_CHUNKS);
	if (legacySql === undefined) return;
	const dimensionToken = legacySql.match(/embedding\s+float\[(\d+)\]/i)?.[1];
	if (dimensionToken === undefined) throw new Error(FIXED_EXTERNAL_VALUE_52);
	const dimension = Number.parseInt(dimensionToken, 10);
	const vectorCount = readTableRowCount(database, FIXED_VEC_MEMORY_CHUNKS) ?? 0;
	if (vectorCount > 0 && dimension !== configuredVectorDim) {
		throw new Error(
			`${FIXED_EXTERNAL_VALUE_53}${configuredVectorDim}, found dim ${dimension}); database left unchanged; wipe or re-import vectors before continuing`,
		);
	}
}

function readLegacyRowCounts(database: SqliteDatabaseLike): Map<string, number> {
	const counts = new Map<string, number>();
	for (const { legacy, current } of TABLE_RENAMES) {
		if (!tableExists(database, legacy)) continue;
		const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(legacy)}`).get() as {
			count: number | bigint;
		};
		counts.set(current, Number(row.count));
	}
	return counts;
}

function readTableRowCount(database: SqliteDatabaseLike, tableName: string): number | undefined {
	if (!tableExists(database, tableName)) return undefined;
	const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get() as {
		count: number | bigint;
	};
	return Number(row.count);
}

function dropLegacyTriggers(database: SqliteDatabaseLike): void {
	for (const name of LEGACY_TRIGGER_NAMES) {
		database.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(name)}`);
	}
}

function dropLegacyFts(database: SqliteDatabaseLike): void {
	if (tableExists(database, FIXED_MEMORY_CHUNKS_FTS)) {
		database.exec(FIXED_EXTERNAL_VALUE_54);
	}
}

function renameTables(database: SqliteDatabaseLike): void {
	for (const { legacy, current } of TABLE_RENAMES) {
		const legacyExists = tableExists(database, legacy);
		const currentExists = tableExists(database, current);
		if (legacyExists && currentExists) {
			throw new Error(`database contains both ${legacy} and ${current}`);
		}
		if (legacyExists) {
			database.exec(
				`ALTER TABLE ${quoteIdentifier(legacy)} RENAME TO ${quoteIdentifier(current)}`,
			);
		}
	}
}

function migrateLegacyVectors(database: SqliteDatabaseLike): void {
	const legacySql = readSchemaSql(database, "table", FIXED_VEC_MEMORY_CHUNKS);
	if (legacySql === undefined) return;
	if (tableExists(database, "nodix_memory_chunk_vectors")) {
		throw new Error(FIXED_EXTERNAL_VALUE_55);
	}
	const dimension = legacySql.match(/embedding\s+float\[(\d+)\]/i)?.[1];
	if (dimension === undefined) throw new Error(FIXED_EXTERNAL_VALUE_52);
	const hasPartitionKey = /partition\s+key/i.test(legacySql);
	const copyVectors = hasPartitionKey
		? FIXED_EXTERNAL_VALUE_56
		: `${FIXED_EXTERNAL_VALUE_57}`;
	database.exec(`
		CREATE VIRTUAL TABLE nodix_memory_chunk_vectors USING vec0(
			id TEXT PRIMARY KEY,
			project_id TEXT PARTITION KEY,
			embedding float[${dimension}]
		);
		${copyVectors}${FIXED_EXTERNAL_VALUE_58}`);
}

function renameIndexes(database: SqliteDatabaseLike): void {
	for (const { legacy, current } of INDEX_RENAMES) {
		const legacySql = readSchemaSql(database, "index", legacy);
		if (legacySql === undefined) continue;
		if (readSchemaSql(database, "index", current) !== undefined) {
			throw new Error(`database contains both index ${legacy} and ${current}`);
		}
		const onClause = legacySql.match(/\sON\s[\s\S]+$/i)?.[0];
		if (onClause === undefined) throw new Error(`cannot parse index definition for ${legacy}`);
		const unique = /^CREATE\s+UNIQUE\s+INDEX/i.test(legacySql) ? "UNIQUE " : "";
		database.exec(`CREATE ${unique}INDEX ${quoteIdentifier(current)}${onClause}`);
		database.exec(`DROP INDEX ${quoteIdentifier(legacy)}`);
	}
}

function createCurrentFts(database: SqliteDatabaseLike): void {
	if (!tableExists(database, "nodix_memory_chunks")) return;
	database.exec(`
		CREATE VIRTUAL TABLE nodix_memory_chunks_fts USING fts5(
			dense_payload,
			content='nodix_memory_chunks',
			content_rowid='rowid',
			tokenize='simple 0'
		);
		INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts) VALUES('rebuild');
	`);
}

function createChunkTriggers(database: SqliteDatabaseLike): void {
	database.exec(`
		CREATE TRIGGER nodix_memory_chunks_ai AFTER INSERT ON nodix_memory_chunks BEGIN
			INSERT INTO nodix_memory_chunks_fts(rowid, dense_payload)
			VALUES (new.rowid, new.dense_payload);
		END;
		CREATE TRIGGER nodix_memory_chunks_ad AFTER DELETE ON nodix_memory_chunks BEGIN
			INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rowid, dense_payload)
			VALUES ('delete', old.rowid, old.dense_payload);
		END;
		CREATE TRIGGER nodix_memory_chunks_au AFTER UPDATE ON nodix_memory_chunks BEGIN
			INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rowid, dense_payload)
			VALUES ('delete', old.rowid, old.dense_payload);
			INSERT INTO nodix_memory_chunks_fts(rowid, dense_payload)
			VALUES (new.rowid, new.dense_payload);
		END;
	`);
}

function createMemoryGuardTriggers(database: SqliteDatabaseLike): void {
	database.exec(`
		CREATE TRIGGER nodix_memories_fact_id_insert_guard
		BEFORE INSERT ON nodix_memories WHEN NEW.fact_id IS NULL
		BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;
		CREATE TRIGGER nodix_memories_fact_id_update_guard
		BEFORE UPDATE ON nodix_memories WHEN NEW.fact_id IS NULL
		BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;
	`);
}

function assertRowCounts(database: SqliteDatabaseLike, expected: Map<string, number>): void {
	for (const [tableName, expectedCount] of expected) {
		const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get() as {
			count: number | bigint;
		};
		if (Number(row.count) !== expectedCount) {
			throw new Error(`row count changed for ${tableName}: ${expectedCount} -> ${String(row.count)}`);
		}
	}
}

function assertTableRowCount(
	database: SqliteDatabaseLike,
	tableName: string,
	expectedCount: number | undefined,
): void {
	if (expectedCount === undefined) return;
	const actualCount = readTableRowCount(database, tableName);
	if (actualCount !== expectedCount) {
		throw new Error(`row count changed for ${tableName}: ${expectedCount} -> ${String(actualCount)}`);
	}
}

function assertLegacyObjectsRemoved(database: SqliteDatabaseLike): void {
	const rows = database
		.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
		.all() as Array<{ name?: string }>;
	const legacyNames = rows
		.map(({ name }) => name)
		.filter((name): name is string =>
			name !== undefined &&
			(KNOWN_LEGACY_OBJECT_NAMES.has(name) ||
				LEGACY_OBJECT_PREFIXES.some((prefix) => name.startsWith(prefix))),
		);
	if (legacyNames.length > 0) {
		throw new Error(`legacy database objects remain: ${legacyNames.join(", ")}`);
	}
}

function tableExists(database: SqliteDatabaseLike, name: string): boolean {
	return readSchemaSql(database, "table", name) !== undefined;
}

function readSchemaSql(
	database: SqliteDatabaseLike,
	type: "index" | "table" | "trigger",
	name: string,
): string | undefined {
	const row = database
		.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
		.get(type, name) as { sql?: string | null } | undefined;
	return row?.sql ?? undefined;
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}
