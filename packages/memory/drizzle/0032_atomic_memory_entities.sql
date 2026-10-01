CREATE TABLE nodix_memory_entities (
  project_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, entity_id),
  UNIQUE(project_id, normalized_name)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_entities_display_name
ON nodix_memory_entities(project_id, display_name);
