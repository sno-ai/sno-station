CREATE TABLE IF NOT EXISTS nodix_memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  project_id TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.7,
  timestamp INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}',
  content_hash TEXT NOT NULL
);
