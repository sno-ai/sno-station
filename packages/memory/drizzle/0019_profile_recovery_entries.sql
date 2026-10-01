CREATE TABLE `nodix_profile_recovery_entries` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`mutation_attempt_id` text NOT NULL,
	`removed_row_id` text NOT NULL,
	`project_id` text NOT NULL,
	`profile_fact_id` text NOT NULL,
	`section_name` text NOT NULL,
	`removed_value` text NOT NULL,
	`removed_at_ms` integer NOT NULL,
	FOREIGN KEY (`removed_row_id`) REFERENCES `nodix_memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nodix_idx_profile_recovery_lineage`
	ON `nodix_profile_recovery_entries` (`project_id`, `profile_fact_id`, `removed_at_ms`);
--> statement-breakpoint
CREATE INDEX `nodix_idx_profile_recovery_attempt`
	ON `nodix_profile_recovery_entries` (`mutation_attempt_id`);
