-- Hand-rolled migration; do NOT run `npm run db:generate` against this file.
-- DB-optimization pass (2026-07): missing indexes for real query shapes, removal of
-- redundant/unused indexes to cut write amplification, and retention enablement for
-- usage events. Complete DDL for the pass lives in this single migration.

-- fact_id lookups (purge cascade deleteFacts/readAffectedEpochIds/readPurgeEventAnchor,
-- telemetry readCurrentContentHash) currently full-scan the memories table.
CREATE INDEX IF NOT EXISTS nodix_idx_memories_fact_id ON nodix_memories(fact_id);
--> statement-breakpoint
-- Outbox flush-candidate reads and pending scans filter on status (+ next_attempt_ms);
-- the table previously had no non-PK index at all.
CREATE INDEX IF NOT EXISTS nodix_idx_memory_usage_outbox_status_next
ON nodix_memory_usage_outbox(status, next_attempt_ms);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nodix_idx_memory_telemetry_incidents_created
ON nodix_memory_telemetry_incidents(created_at_ms);
--> statement-breakpoint
-- listReflectionItems full-scans + JSON-parses every row today. The partial predicate
-- restricts index content to reflection rows only, so even a project-filtered query is
-- bounded by the total number of reflection rows; timestamp keying serves the
-- unfiltered ORDER BY timestamp DESC LIMIT shape in index order.
CREATE INDEX IF NOT EXISTS nodix_idx_memories_reflection_items
ON nodix_memories(timestamp DESC)
WHERE json_valid(metadata) AND json_extract(metadata, '$.type') = 'memory-reflection-item';
--> statement-breakpoint
-- findByExtractionIdempotencyKey and the createEventAndSupersede duplicate probe
-- full-scan on json_extract today. Non-unique on purpose: uniqueness stays enforced by
-- the existing code guard, so pre-existing duplicate rows cannot break this migration.
CREATE INDEX IF NOT EXISTS nodix_idx_memories_idempotency_key
ON nodix_memories(project_id, json_extract(metadata, '$.idempotency_key'))
WHERE json_valid(metadata) AND json_extract(metadata, '$.idempotency_key') IS NOT NULL;
--> statement-breakpoint
-- Redundant left-prefix indexes: (project_id) is a prefix of
-- nodix_idx_memories_project_timestamp and of the UNIQUE
-- (project_id, content_hash, category); chunks(memory_id) is a prefix of the UNIQUE
-- (memory_id, chunk_index). Every write pays for them; no query needs them.
DROP INDEX IF EXISTS nodix_idx_memories_project;
--> statement-breakpoint
DROP INDEX IF EXISTS nodix_idx_memory_chunks_memory_id;
--> statement-breakpoint
-- nodix_memory_events index trim. Every memory write inserts an event inside the same
-- transaction, so each secondary index is per-write amplification. Verified by
-- repo-wide query sweep (2026-07-12): tenant_id and memory_kind are never queried;
-- session_uuid is only ever queried together with turn_id; bare event_type predicates
-- always pair with an indexed fact_id.
DROP INDEX IF EXISTS nodix_idx_memory_events_type;
--> statement-breakpoint
-- The hourly usage-event retention query filters
-- event_type IN ('recall','inject') AND timestamp_ms < cutoff — a partial index shaped
-- exactly for that scan, near-free for lifecycle inserts (outside the predicate).
CREATE INDEX IF NOT EXISTS nodix_idx_memory_events_usage_retention
ON nodix_memory_events(timestamp_ms)
WHERE event_type IN ('recall', 'inject');
--> statement-breakpoint
DROP INDEX IF EXISTS nodix_idx_memory_events_tenant;
--> statement-breakpoint
DROP INDEX IF EXISTS nodix_idx_memory_events_kind;
--> statement-breakpoint
DROP INDEX IF EXISTS nodix_idx_memory_events_session;
--> statement-breakpoint
DROP INDEX IF EXISTS nodix_idx_memory_events_epoch;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nodix_idx_memory_events_epoch ON nodix_memory_events(consolidation_epoch_id)
WHERE consolidation_epoch_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS nodix_idx_memory_events_turn;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nodix_idx_memory_events_turn ON nodix_memory_events(turn_id)
WHERE turn_id IS NOT NULL;
--> statement-breakpoint
-- Retention enablement. The blanket no-delete trigger is replaced by a GUARDED trigger:
-- only high-volume usage events ('recall','inject') may ever be deleted; receipt and
-- lineage events (create/update/supersede/delete/purge/epoch_boundary) stay
-- database-protected forever. Age policy (90d) lives in code; the schema enforces the
-- event-class boundary. Fail-safe order: the guarded trigger is created BEFORE the
-- blanket trigger is dropped, so an interrupted migration leaves BOTH triggers active
-- (deletes over-protected), never a window where lifecycle rows are deletable.
CREATE TRIGGER IF NOT EXISTS memory_events_lifecycle_delete_guard BEFORE DELETE ON nodix_memory_events
WHEN OLD.event_type NOT IN ('recall', 'inject')
BEGIN SELECT RAISE(ABORT, 'nodix_memory_events lifecycle rows are append-only'); END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS memory_events_no_delete;
