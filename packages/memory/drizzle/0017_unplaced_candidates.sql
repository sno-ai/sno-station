CREATE TABLE `nodix_unplaced_memory_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`text` text NOT NULL,
	`raw_candidate_json` text NOT NULL,
	`disposition_reason` text NOT NULL,
	`dispositioned_at_ms` integer NOT NULL,
	`session_key` text,
	`dedupe_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nodix_idx_unplaced_project_reason` ON `nodix_unplaced_memory_candidates` (`project_id`,`disposition_reason`);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodix_idx_unplaced_dedupe` ON `nodix_unplaced_memory_candidates` (`project_id`,`dedupe_hash`);
