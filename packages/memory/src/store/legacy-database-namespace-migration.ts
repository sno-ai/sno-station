import type { SqliteDatabaseLike } from "./sqlite-runtime";

interface ObjectRename {
	legacy: string;
	current: string;
}

const TABLE_RENAMES: readonly ObjectRename[] = [
	{ legacy: "mem_claw_memories", current: "nodix_memories" },
	{ legacy: "mem_claw_chunks", current: "nodix_memory_chunks" },
	{ legacy: "mem_claw_extraction_timestamps", current: "nodix_memory_extraction_timestamps" },
	{ legacy: "mem_claw_provider_project_mappings", current: "nodix_provider_project_mappings" },
	{ legacy: "mem_claw_provider_agent_mappings", current: "nodix_provider_agent_mappings" },
	{ legacy: "mem_claw_provider_project_agents", current: "nodix_provider_project_agents" },
	{ legacy: "mem_claw_task_lifecycle_commands", current: "nodix_task_lifecycle_commands" },
	{ legacy: "mem_claw_active_task_instances", current: "nodix_active_task_instances" },
	{ legacy: "mem_claw_active_task_revisions", current: "nodix_active_task_revisions" },
	{ legacy: "mem_claw_active_task_transitions", current: "nodix_active_task_transitions" },
	{ legacy: "mem_claw_active_task_evidence", current: "nodix_active_task_evidence" },
	{
		legacy: "mem_claw_active_task_migration_evidence",
		current: "nodix_active_task_migration_evidence",
	},
	{
		legacy: "mem_claw_active_task_migration_manifests",
		current: "nodix_active_task_migration_manifests",
	},
	{ legacy: "mem_claw_unplaced_candidates", current: "nodix_unplaced_memory_candidates" },
	{ legacy: "mem_claw_profile_recovery_entries", current: "nodix_profile_recovery_entries" },
	{ legacy: "mem_claw_migration_markers", current: "nodix_memory_migration_markers" },
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
	{ legacy: "idx_mem_claw_memories_project_content_hash", current: "nodix_idx_memories_project_content_hash" },
	{ legacy: "idx_mem_claw_memories_project", current: "nodix_idx_memories_project" },
	{ legacy: "idx_mem_claw_memories_category", current: "nodix_idx_memories_category" },
	{ legacy: "idx_mem_claw_memories_project_timestamp", current: "nodix_idx_memories_project_timestamp" },
	{ legacy: "idx_mem_claw_memories_content_hash", current: "nodix_idx_memories_content_hash" },
	{ legacy: "idx_mem_claw_memories_fact_id", current: "nodix_idx_memories_fact_id" },
	{ legacy: "idx_mcm_reflection_items", current: "nodix_idx_memories_reflection_items" },
	{ legacy: "idx_mcm_idempotency_key", current: "nodix_idx_memories_idempotency_key" },
	{ legacy: "idx_mem_claw_memories_lane_project", current: "nodix_idx_memories_lane_project" },
	{
		legacy: "idx_mem_claw_memories_project_fact_key_active",
		current: "nodix_idx_memories_project_fact_key_active",
	},
	{ legacy: "mem_claw_chunks_mem_idx", current: "nodix_idx_memory_chunks_memory" },
	{ legacy: "mem_claw_chunks_memory_id_idx", current: "nodix_idx_memory_chunks_memory_id" },
	{ legacy: "mem_claw_chunks_mem_facet_idx", current: "nodix_idx_memory_chunks_memory_facet" },
	{
		legacy: "idx_mem_claw_active_task_current_revision",
		current: "nodix_idx_active_task_current_revision",
	},
	{
		legacy: "idx_mem_claw_active_task_instances_projection",
		current: "nodix_idx_active_task_instances_projection",
	},
	{
		legacy: "idx_mem_claw_active_task_evidence_instance",
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
	"mem_claw_chunks_ai",
	"mem_claw_chunks_ad",
	"mem_claw_chunks_au",
	"mem_claw_memories_fact_id_insert_guard",
	"mem_claw_memories_fact_id_update_guard",
] as const;

const LEGACY_MEMORY_GUARD_TRIGGER_NAMES = [
	"mem_claw_memories_fact_id_insert_guard",
	"mem_claw_memories_fact_id_update_guard",
] as const;

const KNOWN_LEGACY_OBJECT_NAMES = new Set([
	...TABLE_RENAMES.map(({ legacy }) => legacy),
	...INDEX_RENAMES.map(({ legacy }) => legacy),
	...LEGACY_TRIGGER_NAMES,
	"vec_mem_claw_chunks",
]);
const LEGACY_OBJECT_PREFIXES = ["mem_claw", "vec_mem_claw", "idx_mem_claw"] as const;

export type LegacyDatabaseNamespaceMigrationResult = "empty" | "current" | "migrated";

export function migrateLegacyDatabaseNamespace(
	database: SqliteDatabaseLike,
	configuredVectorDim?: number,
): LegacyDatabaseNamespaceMigrationResult {
	const hasLegacySchema = tableExists(database, "mem_claw_memories");
	const hasCurrentSchema = tableExists(database, "nodix_memories");
	if (hasLegacySchema && hasCurrentSchema) {
		throw new Error("database contains both mem_claw_memories and nodix_memories");
	}
	if (!hasLegacySchema) {
		assertLegacyObjectsRemoved(database);
		return hasCurrentSchema ? "current" : "empty";
	}
	assertLegacyBoundarySupported(database);
	if (configuredVectorDim !== undefined) {
		assertLegacyVectorDimensionSupported(database, configuredVectorDim);
	}
	const hadLegacyChunkSearch = tableExists(database, "mem_claw_chunks_fts");
	const hadLegacyMemoryGuards = LEGACY_MEMORY_GUARD_TRIGGER_NAMES.some(
		(name) => readSchemaSql(database, "trigger", name) !== undefined,
	);

	database.transaction(() => {
		const rowCounts = readLegacyRowCounts(database);
		const vectorCount = readTableRowCount(database, "vec_mem_claw_chunks");
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
	const rows = database.prepare("PRAGMA table_info(mem_claw_memories)").all() as Array<{
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
	const legacySql = readSchemaSql(database, "table", "vec_mem_claw_chunks");
	if (legacySql === undefined) return;
	const dimensionToken = legacySql.match(/embedding\s+float\[(\d+)\]/i)?.[1];
	if (dimensionToken === undefined) throw new Error("cannot read vec_mem_claw_chunks dimension");
	const dimension = Number.parseInt(dimensionToken, 10);
	const vectorCount = readTableRowCount(database, "vec_mem_claw_chunks") ?? 0;
	if (vectorCount > 0 && dimension !== configuredVectorDim) {
		throw new Error(
			`vec_mem_claw_chunks does not match the current schema (configured dim ${configuredVectorDim}, found dim ${dimension}); database left unchanged; wipe or re-import vectors before continuing`,
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
	if (tableExists(database, "mem_claw_chunks_fts")) {
		database.exec("DROP TABLE mem_claw_chunks_fts");
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
	const legacySql = readSchemaSql(database, "table", "vec_mem_claw_chunks");
	if (legacySql === undefined) return;
	if (tableExists(database, "nodix_memory_chunk_vectors")) {
		throw new Error("database contains both vec_mem_claw_chunks and nodix_memory_chunk_vectors");
	}
	const dimension = legacySql.match(/embedding\s+float\[(\d+)\]/i)?.[1];
	if (dimension === undefined) throw new Error("cannot read vec_mem_claw_chunks dimension");
	const hasPartitionKey = /partition\s+key/i.test(legacySql);
	const copyVectors = hasPartitionKey
		? "INSERT INTO nodix_memory_chunk_vectors(id, project_id, embedding) SELECT id, project_id, embedding FROM vec_mem_claw_chunks"
		: `INSERT INTO nodix_memory_chunk_vectors(id, project_id, embedding)
			SELECT vectors.id, memories.project_id, vectors.embedding
			FROM vec_mem_claw_chunks AS vectors
			JOIN nodix_memory_chunks AS chunks ON chunks.chunk_id = vectors.id
			JOIN nodix_memories AS memories ON memories.id = chunks.memory_id`;
	database.exec(`
		CREATE VIRTUAL TABLE nodix_memory_chunk_vectors USING vec0(
			id TEXT PRIMARY KEY,
			project_id TEXT PARTITION KEY,
			embedding float[${dimension}]
		);
		${copyVectors};
		DROP TABLE vec_mem_claw_chunks;
	`);
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
