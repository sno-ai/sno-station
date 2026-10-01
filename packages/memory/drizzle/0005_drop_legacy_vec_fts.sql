-- Drop parent-level FTS/vector objects superseded by 0004_chunk_swap.
DROP TRIGGER IF EXISTS nodix_memories_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nodix_memories_ad;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nodix_memories_au;
--> statement-breakpoint
DROP TABLE IF EXISTS nodix_memories_fts;
--> statement-breakpoint
DROP TABLE IF EXISTS nodix_memory_vectors;
