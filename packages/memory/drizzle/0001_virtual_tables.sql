CREATE VIRTUAL TABLE IF NOT EXISTS nodix_memories_fts
USING fts5(
  text,
  content='nodix_memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS nodix_memories_ai
AFTER INSERT ON nodix_memories BEGIN
  INSERT INTO nodix_memories_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS nodix_memories_ad
AFTER DELETE ON nodix_memories BEGIN
  INSERT INTO nodix_memories_fts(nodix_memories_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS nodix_memories_au
AFTER UPDATE ON nodix_memories BEGIN
  INSERT INTO nodix_memories_fts(nodix_memories_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO nodix_memories_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS nodix_memory_vectors
USING vec0(
  id TEXT PRIMARY KEY,
  -- Keep this aligned with VECTOR_DIMENSION_DEFAULT (1024).
  embedding float[1024]
);
