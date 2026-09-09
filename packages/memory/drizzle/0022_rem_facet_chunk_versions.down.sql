DROP INDEX IF EXISTS `nodix_idx_memory_chunks_memory_facet`;
--> statement-breakpoint
CREATE UNIQUE INDEX `nodix_idx_memory_chunks_memory`
	ON `nodix_memory_chunks` (`memory_id`, `chunk_index`);
