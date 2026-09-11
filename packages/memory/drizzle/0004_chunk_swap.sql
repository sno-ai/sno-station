-- Hand-rolled migration; do NOT run `npm run db:generate` against this file.
CREATE TABLE IF NOT EXISTS nodix_memory_chunks (
  chunk_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  dense_payload TEXT NOT NULL,
  summary TEXT,
  entities TEXT,
  tags TEXT,
  source TEXT,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('conversation', 'prose', 'code')),
  chunking_version TEXT NOT NULL,
  embedder_provider TEXT NOT NULL,
  embedder_model TEXT NOT NULL,
  embedder_dim INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES nodix_memories(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS nodix_idx_memory_chunks_memory ON nodix_memory_chunks(memory_id, chunk_index);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nodix_idx_memory_chunks_memory_id ON nodix_memory_chunks(memory_id);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS nodix_memory_chunk_vectors USING vec0(
  id TEXT PRIMARY KEY,
  -- Placeholder dim; runtime ensureChunkVecTable recreates at the configured dim.
  embedding float[1024]
);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS nodix_memory_chunks_fts USING fts5(
  dense_payload,
  content='nodix_memory_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS nodix_memory_chunks_ai
AFTER INSERT ON nodix_memory_chunks BEGIN
  INSERT INTO nodix_memory_chunks_fts(rowid, dense_payload)
  VALUES (new.rowid, new.dense_payload);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS nodix_memory_chunks_ad
AFTER DELETE ON nodix_memory_chunks BEGIN
  INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rowid, dense_payload)
  VALUES ('delete', old.rowid, old.dense_payload);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS nodix_memory_chunks_au
AFTER UPDATE ON nodix_memory_chunks BEGIN
  INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts, rowid, dense_payload)
  VALUES ('delete', old.rowid, old.dense_payload);
  INSERT INTO nodix_memory_chunks_fts(rowid, dense_payload)
  VALUES (new.rowid, new.dense_payload);
END;
