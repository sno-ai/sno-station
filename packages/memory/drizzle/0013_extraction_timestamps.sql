CREATE TABLE IF NOT EXISTS `nodix_memory_extraction_timestamps` (
	`project_id` text NOT NULL,
	`replay_key` text NOT NULL,
	`resolved_at_ms` integer NOT NULL,
	PRIMARY KEY (`project_id`, `replay_key`)
) WITHOUT ROWID;
