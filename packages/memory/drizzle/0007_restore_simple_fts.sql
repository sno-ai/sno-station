-- Restore nodix_memory_chunks_fts to the wangfenjin/simple tokenizer after the
-- temporary 0006 rollback to porter unicode61.
DROP TRIGGER IF EXISTS nodix_memory_chunks_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nodix_memory_chunks_ad;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nodix_memory_chunks_au;
--> statement-breakpoint
DROP TABLE IF EXISTS nodix_memory_chunks_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE nodix_memory_chunks_fts USING fts5(
  dense_payload,
  content='nodix_memory_chunks',
  content_rowid='rowid',
  tokenize='simple 0'
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
--> statement-breakpoint
INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts)
SELECT 'rebuild'
WHERE EXISTS (SELECT 1 FROM nodix_memory_chunks LIMIT 1);
