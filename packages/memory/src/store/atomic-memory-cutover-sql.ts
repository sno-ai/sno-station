/** @file atomic-memory-cutover-sql.ts
 * @purpose Holds the text-immutability trigger until the ordered Phase F cutover activates it.
 * @boundary Exported SQL only; importing this module never changes a store.
 */

import { MEMORY_CATEGORIES } from "../engine/shared/types";
import type { SqliteDatabaseLike } from "./sqlite-runtime";
import { StorageError } from "./memory-store-shared";

export const ATOMIC_MEMORY_TEXT_IMMUTABILITY_TRIGGER = "nodix_memories_text_immutable";

export const ATOMIC_MEMORY_VALID_INTERVAL_CHECK_SQL =
	"valid_until IS NULL OR (valid_from IS NOT NULL AND valid_until > valid_from)";

export const CREATE_ATOMIC_MEMORY_TEXT_IMMUTABILITY_TRIGGER_SQL: string = `
CREATE TRIGGER ${ATOMIC_MEMORY_TEXT_IMMUTABILITY_TRIGGER}
BEFORE UPDATE OF text ON nodix_memories
WHEN NEW.text IS NOT OLD.text
BEGIN
	SELECT RAISE(ABORT, 'nodix_memories.text is immutable; create a new card');
END;
`;

export const ATOMIC_MEMORY_ROW_CONSTRAINTS: ReadonlyArray<{ name: string; predicate: string }> = [
	{ name: "text", predicate: "text IS NOT NULL" },
	{ name: "category_not_null", predicate: "category IS NOT NULL" },
	{
		name: "category",
		predicate: `category IN (${[...MEMORY_CATEGORIES, "foresight"]
			.map((category) => `'${category}'`)
			.join(", ")})`,
	},
	{ name: "project_id", predicate: "project_id IS NOT NULL" },
	{
		name: "importance",
		predicate: "importance IS NOT NULL AND importance >= 0.0 AND importance <= 1.0",
	},
	{ name: "timestamp", predicate: "timestamp IS NOT NULL" },
	{ name: "content_hash", predicate: "content_hash IS NOT NULL" },
	{ name: "lane", predicate: "lane IS NOT NULL AND lane IN ('active', 'parked', 'quarantined')" },
	{ name: "timezone", predicate: "timezone IS NOT NULL" },
	{
		name: "maturity",
		predicate: "maturity IS NOT NULL AND maturity IN ('extracted', 'distilled', 'compiled')",
	},
	{ name: "source", predicate: "source IS NOT NULL AND source IN ('edge', 'cloud', 'manual')" },
	{ name: "extractor_version", predicate: "extractor_version IS NOT NULL" },
	{ name: "valid_interval", predicate: ATOMIC_MEMORY_VALID_INTERVAL_CHECK_SQL },
	{
		name: "maturity_derived_from",
		predicate:
			"maturity = 'extracted' OR (derived_from IS NOT NULL AND length(trim(derived_from)) > 0)",
	},
	{ name: "compiled_category", predicate: "maturity != 'compiled' OR category = 'lesson'" },
	{ name: "foresight_source", predicate: "category != 'foresight' OR source = 'cloud'" },
	{
		name: "persona_subject",
		predicate: "category != 'persona' OR (subject IS NOT NULL AND subject = 'agent')",
	},
	{ name: "lesson_subject", predicate: "category != 'lesson' OR subject IS NULL OR subject = 'agent'" },
	{
		name: "state_subject_metadata",
		predicate: `category != 'state'
		OR (
			subject IS NOT NULL
			AND subject GLOB 'entity:*'
			AND length(subject) > length('entity:')
			AND json_valid(metadata)
			AND json_type(metadata, '$.event_at') IS NULL
		)`,
	},
	{
		name: "foresight_subject",
		predicate: `category != 'foresight'
		OR (
			subject IS NOT NULL
			AND (
				subject = 'user'
				OR (subject GLOB 'entity:*' AND length(subject) > length('entity:'))
			)
		)`,
	},
	{
		name: "foresight_interval",
		predicate: `category != 'foresight'
		OR (
			valid_from IS NOT NULL
			AND valid_until IS NOT NULL
			AND valid_from > timestamp
			AND valid_until > valid_from
		)`,
	},
];

export const CREATE_ATOMIC_MEMORY_CUTOVER_TABLE_SQL: string = `
CREATE TABLE nodix_memories_cutover (
	id TEXT PRIMARY KEY,
	text TEXT,
	category TEXT,
	project_id TEXT,
	importance REAL DEFAULT 0.7,
	timestamp INTEGER,
	metadata TEXT DEFAULT '{}',
	content_hash TEXT,
	fact_id TEXT,
	derived_from TEXT,
	consolidation_epoch_id TEXT,
	confidence_source TEXT,
	lane TEXT DEFAULT 'active',
	raw_candidate_json TEXT,
	disposition_reason TEXT,
	dispositioned_at_ms INTEGER,
	timezone TEXT DEFAULT '__missing_timezone__',
	subject TEXT,
	attribute TEXT,
	valid_from INTEGER,
	valid_until INTEGER,
	maturity TEXT,
	source TEXT,
	extractor_version TEXT,
	${ATOMIC_MEMORY_ROW_CONSTRAINTS.map(({ predicate }) => `CHECK (${predicate})`).join(",\n\t")}
);
`;

const ATOMIC_MEMORY_CUTOVER_SCHEMA_SQL = `
${CREATE_ATOMIC_MEMORY_CUTOVER_TABLE_SQL}

DROP TABLE nodix_memories;
ALTER TABLE nodix_memories_cutover RENAME TO nodix_memories;

CREATE INDEX nodix_idx_memories_content_hash ON nodix_memories(content_hash);
CREATE UNIQUE INDEX nodix_idx_memories_project_content_hash
	ON nodix_memories(project_id, content_hash, category);
CREATE INDEX nodix_idx_memories_category ON nodix_memories(category);
CREATE INDEX nodix_idx_memories_project_timestamp ON nodix_memories(project_id, timestamp DESC);
CREATE INDEX nodix_idx_memories_fact_id ON nodix_memories(fact_id);
CREATE INDEX nodix_idx_memories_reflection_items ON nodix_memories(timestamp DESC)
	WHERE json_valid(metadata) AND json_extract(metadata, '$.type') = 'memory-reflection-item';
CREATE INDEX nodix_idx_memories_idempotency_key
	ON nodix_memories(project_id, json_extract(metadata, '$.idempotency_key'))
	WHERE json_valid(metadata) AND json_extract(metadata, '$.idempotency_key') IS NOT NULL;
CREATE INDEX nodix_idx_memories_lane_project ON nodix_memories(lane, project_id);
CREATE INDEX nodix_idx_memories_project_subject_attribute
	ON nodix_memories(project_id, subject, attribute);
CREATE INDEX nodix_idx_memories_project_valid_time
	ON nodix_memories(project_id, valid_from, valid_until);
CREATE INDEX nodix_idx_memories_project_maturity ON nodix_memories(project_id, maturity);
CREATE INDEX nodix_idx_memories_project_source ON nodix_memories(project_id, source);
CREATE INDEX nodix_idx_memories_project_extractor_version
	ON nodix_memories(project_id, extractor_version);
CREATE INDEX nodix_idx_memories_project_derived_from ON nodix_memories(project_id, derived_from);
CREATE INDEX nodix_idx_memories_project_importance ON nodix_memories(project_id, importance);

CREATE TRIGGER nodix_memories_fact_id_insert_guard
BEFORE INSERT ON nodix_memories
WHEN NEW.fact_id IS NULL
BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;

CREATE TRIGGER nodix_memories_fact_id_update_guard
BEFORE UPDATE ON nodix_memories
WHEN NEW.fact_id IS NULL
BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;

CREATE TRIGGER nodix_memories_timezone_required_before_insert
BEFORE INSERT ON nodix_memories
WHEN NEW.timezone = '__missing_timezone__' OR trim(NEW.timezone) = ''
BEGIN SELECT RAISE(ABORT, 'timezone is required'); END;

CREATE TRIGGER nodix_memories_timezone_required_before_update
BEFORE UPDATE OF timezone ON nodix_memories
WHEN NEW.timezone = '__missing_timezone__' OR trim(NEW.timezone) = ''
BEGIN SELECT RAISE(ABORT, 'timezone is required'); END;

CREATE TRIGGER rem_memory_facets_after_insert
AFTER INSERT ON nodix_memories
BEGIN
	INSERT INTO nodix_rem_memory_facets (memory_id, facet, text, updated_at_ms)
		VALUES (NEW.id, 'current', NEW.text, NEW.timestamp);
END;

CREATE TRIGGER rem_memory_facets_after_text_update
AFTER UPDATE OF text ON nodix_memories
BEGIN
	INSERT INTO nodix_rem_memory_facets (memory_id, facet, text, updated_at_ms)
		VALUES (NEW.id, 'current', NEW.text, NEW.timestamp)
	ON CONFLICT(memory_id, facet) DO UPDATE SET
		text = excluded.text, updated_at_ms = excluded.updated_at_ms;
END;

${CREATE_ATOMIC_MEMORY_TEXT_IMMUTABILITY_TRIGGER_SQL}
`;

export function installAtomicMemoryTextImmutabilityTrigger(database: SqliteDatabaseLike): void {
	database.exec(CREATE_ATOMIC_MEMORY_TEXT_IMMUTABILITY_TRIGGER_SQL);
}

export function applyAtomicMemoryCutoverMigration(database: SqliteDatabaseLike): void {
	database.exec("PRAGMA foreign_keys = OFF");
	try {
		const migrate = database.transaction(() => {
			const row = database.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get() as
				| { count: number }
				| undefined;
			if (row?.count !== 0) {
				throw new StorageError(
					`Atomic memory cutover requires zero stored memories; found ${String(row?.count ?? "unknown")}`,
				);
			}
			database.exec(ATOMIC_MEMORY_CUTOVER_SCHEMA_SQL);
		});
		migrate.immediate();
	} finally {
		database.exec("PRAGMA foreign_keys = ON");
	}
}
