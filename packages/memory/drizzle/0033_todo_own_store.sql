CREATE TABLE nodix_todos (
  project_id TEXT NOT NULL,
  active_task_id TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'done', 'removed')),
  opened_at INTEGER NOT NULL,
  transitioned_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT,
  source_session TEXT NOT NULL,
  extraction_path TEXT NOT NULL,
  PRIMARY KEY(project_id, active_task_id),
  FOREIGN KEY(project_id, active_task_id)
    REFERENCES nodix_active_task_instances(project_id, active_task_id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX nodix_idx_todos_scope_status_opened
ON nodix_todos(project_id, status, opened_at, active_task_id);
--> statement-breakpoint
INSERT INTO nodix_todos(
  project_id, active_task_id, description, status, opened_at, transitioned_at,
  closed_at, close_reason, source_session, extraction_path
)
SELECT
  instance.project_id,
  instance.active_task_id,
  revision.description,
  CASE instance.status
    WHEN 'active' THEN 'open'
    WHEN 'completed' THEN 'done'
    ELSE 'removed'
  END,
  instance.created_at_ms,
  COALESCE(instance.terminal_at_ms, instance.created_at_ms),
  instance.terminal_at_ms,
  CASE WHEN instance.terminal_at_ms IS NULL THEN NULL ELSE COALESCE(
    json_extract(terminal_command.identity_json, '$.candidate.text'),
    json_extract(terminal_command.identity_json, '$.canonicalTuple[3]'),
    terminal_command.command_id
  ) END,
  COALESCE(
    json_extract(opening_command.identity_json, '$.sessionKey'),
    json_extract(opening_command.identity_json, '$.canonicalTuple[2]'),
    opening_command.command_id
  ),
  COALESCE(json_extract(opening_command.identity_json, '$.kind'), 'legacy')
FROM nodix_active_task_instances AS instance
JOIN nodix_active_task_revisions AS revision
  ON revision.project_id = instance.project_id
  AND revision.active_task_id = instance.active_task_id
  AND revision.active_task_revision_id = (
    SELECT candidate.active_task_revision_id
    FROM nodix_active_task_revisions AS candidate
    WHERE candidate.project_id = instance.project_id
      AND candidate.active_task_id = instance.active_task_id
    ORDER BY candidate.is_current DESC, candidate.created_at_ms DESC,
      candidate.active_task_revision_id DESC
    LIMIT 1
  )
JOIN nodix_task_lifecycle_commands AS opening_command
  ON opening_command.project_id = instance.project_id
  AND opening_command.command_id = instance.opening_command_id
LEFT JOIN nodix_active_task_transitions AS terminal_transition
  ON terminal_transition.project_id = instance.project_id
  AND terminal_transition.active_task_id = instance.active_task_id
  AND terminal_transition.transition_kind IN ('complete', 'remove')
LEFT JOIN nodix_task_lifecycle_commands AS terminal_command
  ON terminal_command.project_id = terminal_transition.project_id
  AND terminal_command.command_id = terminal_transition.command_id;
--> statement-breakpoint
CREATE TABLE nodix_todo_migration_receipts (
  migration_id TEXT PRIMARY KEY,
  before_count INTEGER NOT NULL,
  after_count INTEGER NOT NULL,
  migrated_at INTEGER NOT NULL,
  CHECK(before_count = after_count)
) WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO nodix_todo_migration_receipts(
  migration_id, before_count, after_count, migrated_at
)
SELECT
  '0033_todo_own_store',
  (SELECT COUNT(*) FROM nodix_active_task_instances),
  (SELECT COUNT(*) FROM nodix_todos),
  1740000000033;
--> statement-breakpoint
DELETE FROM nodix_memory_chunk_vectors
WHERE id IN (
  SELECT chunk.chunk_id
  FROM nodix_memory_chunks AS chunk
  JOIN nodix_memories AS memory ON memory.id = chunk.memory_id
  WHERE json_valid(memory.metadata)
    AND json_extract(memory.metadata, '$.active_task_kind') IN ('task', 'projection')
);
--> statement-breakpoint
DELETE FROM nodix_memories
WHERE json_valid(metadata)
  AND json_extract(metadata, '$.active_task_kind') IN ('task', 'projection');
