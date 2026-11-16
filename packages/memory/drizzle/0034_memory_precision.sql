CREATE TABLE nodix_place_modes (
  skin_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK (mode IN ('work', 'chat')),
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (skin_id, project_id, surface)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE nodix_place_loaded_files (
  skin_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (skin_id, project_id, surface)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE nodix_loaded_file_judgments (
  memory_id TEXT NOT NULL REFERENCES nodix_memories(id) ON DELETE CASCADE,
  memory_content_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('said', 'not-said', 'opposite')),
  judged_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, file_path)
) WITHOUT ROWID;
