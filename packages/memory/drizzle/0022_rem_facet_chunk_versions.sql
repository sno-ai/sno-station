DROP INDEX IF EXISTS `nodix_idx_memory_chunks_memory`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `nodix_idx_memory_chunks_memory_facet`
	ON `nodix_memory_chunks` (`memory_id`, `facet`, `chunk_index`);
