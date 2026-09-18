-- Destructive schema rollback: discards all facet text and facet recovery snapshots.
-- A later forward migration rebuilds current facets from primary-row text and silently loses
-- every applied current-state rewrite. Use only before any such rewrite or with an external backup.
DROP TABLE IF EXISTS `nodix_rem_facet_recovery`;
--> statement-breakpoint
DROP INDEX IF EXISTS `rem_memory_facets_by_facet`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `rem_memory_facets_after_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `rem_memory_facets_after_text_update`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_memory_facets`;
--> statement-breakpoint
ALTER TABLE `nodix_memory_chunks` DROP COLUMN `facet`;
