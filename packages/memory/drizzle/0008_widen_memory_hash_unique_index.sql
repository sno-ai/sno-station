DROP INDEX IF EXISTS nodix_idx_memories_project_content_hash;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS nodix_idx_memories_project_content_hash
ON nodix_memories (project_id, content_hash, category);
