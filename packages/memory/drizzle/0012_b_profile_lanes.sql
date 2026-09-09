ALTER TABLE `nodix_memories` ADD `lane` text DEFAULT 'active' NOT NULL CHECK (`lane` IN ('active', 'parked', 'quarantined'));
--> statement-breakpoint
ALTER TABLE `nodix_memories` ADD `raw_candidate_json` text;
--> statement-breakpoint
ALTER TABLE `nodix_memories` ADD `disposition_reason` text;
--> statement-breakpoint
ALTER TABLE `nodix_memories` ADD `dispositioned_at_ms` integer;
--> statement-breakpoint
CREATE INDEX `nodix_idx_memories_lane_project` ON `nodix_memories` (`lane`,`project_id`);
