CREATE TABLE IF NOT EXISTS `nodix_rem_memory_facets` (
	`memory_id` text NOT NULL,
	`facet` text NOT NULL CHECK (`facet` IN ('current', 'history')),
	`text` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY (`memory_id`, `facet`),
	FOREIGN KEY (`memory_id`) REFERENCES `nodix_memories`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT OR IGNORE INTO `nodix_rem_memory_facets` (`memory_id`, `facet`, `text`, `updated_at_ms`)
	SELECT `id`, 'current', `text`, `timestamp` FROM `nodix_memories`;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `rem_memory_facets_after_insert`
AFTER INSERT ON `nodix_memories`
BEGIN
	INSERT INTO `nodix_rem_memory_facets` (`memory_id`, `facet`, `text`, `updated_at_ms`)
		VALUES (NEW.`id`, 'current', NEW.`text`, NEW.`timestamp`);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `rem_memory_facets_after_text_update`
AFTER UPDATE OF `text` ON `nodix_memories`
BEGIN
	INSERT INTO `nodix_rem_memory_facets` (`memory_id`, `facet`, `text`, `updated_at_ms`)
		VALUES (NEW.`id`, 'current', NEW.`text`, NEW.`timestamp`)
	ON CONFLICT(`memory_id`, `facet`) DO UPDATE SET
		`text` = excluded.`text`, `updated_at_ms` = excluded.`updated_at_ms`;
END;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rem_memory_facets_by_facet`
	ON `nodix_rem_memory_facets` (`facet`, `memory_id`);
--> statement-breakpoint
ALTER TABLE `nodix_memory_chunks`
	ADD COLUMN `facet` text NOT NULL DEFAULT 'current' CHECK (`facet` IN ('current', 'history'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_facet_recovery` (
	`recovery_handle` text PRIMARY KEY,
	`prior_facets_json` text NOT NULL,
	`prior_chunk_facets_json` text NOT NULL,
	`expected_facets_json` text NOT NULL,
	`expected_chunk_facets_json` text NOT NULL,
	FOREIGN KEY (`recovery_handle`) REFERENCES `nodix_rem_recovery_history`(`recovery_handle`)
);
