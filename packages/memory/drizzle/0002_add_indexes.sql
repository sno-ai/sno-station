CREATE UNIQUE INDEX IF NOT EXISTS nodix_idx_memories_project_content_hash
ON nodix_memories (project_id, content_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nodix_idx_memories_project
ON nodix_memories (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nodix_idx_memories_category
ON nodix_memories (category);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nodix_idx_memories_project_timestamp
ON nodix_memories (project_id, timestamp DESC);
