ALTER TABLE nodix_memories ADD COLUMN fact_id TEXT;
--> statement-breakpoint
UPDATE nodix_memories SET fact_id = id WHERE fact_id IS NULL;
--> statement-breakpoint
ALTER TABLE nodix_memories ADD COLUMN derived_from TEXT;
--> statement-breakpoint
ALTER TABLE nodix_memories ADD COLUMN consolidation_epoch_id TEXT;
--> statement-breakpoint
ALTER TABLE nodix_memories ADD COLUMN confidence_source TEXT;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS nodix_memories_fact_id_insert_guard
BEFORE INSERT ON nodix_memories
WHEN NEW.fact_id IS NULL
BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS nodix_memories_fact_id_update_guard
BEFORE UPDATE ON nodix_memories
WHEN NEW.fact_id IS NULL
BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS nodix_memory_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type    TEXT    NOT NULL,
  fact_id       TEXT,
  memory_kind   TEXT,
  timestamp_ms  INTEGER NOT NULL,
  session_uuid  TEXT,
  turn_id       TEXT,
  agent_id      TEXT    NOT NULL,
  project_id    TEXT,
  tenant_id     TEXT,

  source_event_id   INTEGER,
  derived_from      TEXT,

  consolidation_epoch_id  TEXT,

  content_hash    TEXT,
  receipt_hmac    TEXT,
  key_version     INTEGER,

  retrieval_rank    INTEGER,
  retrieval_score   REAL,

  query_tenant_id   TEXT,
  result_tenant_id  TEXT,

  metadata_json   TEXT,

  CHECK (event_type IN (
    'create',
    'update',
    'recall',
    'supersede',
    'delete',
    'inject',
    'epoch_boundary',
    'purge'
  )),
  CHECK (event_type = 'epoch_boundary' OR fact_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_events_fact      ON nodix_memory_events(fact_id);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_events_type      ON nodix_memory_events(event_type);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_events_epoch     ON nodix_memory_events(consolidation_epoch_id);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_events_session   ON nodix_memory_events(session_uuid);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_events_tenant    ON nodix_memory_events(tenant_id, timestamp_ms);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_events_kind      ON nodix_memory_events(memory_kind, timestamp_ms);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_events_project   ON nodix_memory_events(project_id, event_type, timestamp_ms);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_events_turn      ON nodix_memory_events(turn_id);
--> statement-breakpoint
CREATE TRIGGER memory_events_no_update BEFORE UPDATE ON nodix_memory_events
BEGIN SELECT RAISE(ABORT, 'nodix_memory_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER memory_events_no_delete BEFORE DELETE ON nodix_memory_events
BEGIN SELECT RAISE(ABORT, 'nodix_memory_events is append-only'); END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS nodix_memory_usage_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('recall', 'inject')),
  payload_json TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'flushing', 'quarantined')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_ms INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS nodix_memory_telemetry_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at_ms INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS nodix_memory_telemetry_sync_state (
  sink TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);
