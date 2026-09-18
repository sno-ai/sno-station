ALTER TABLE `nodix_rem_scan_pairs` ADD COLUMN `budget_invocation_id` text;
--> statement-breakpoint
ALTER TABLE `nodix_rem_scan_pairs` ADD COLUMN `attempt_count` integer DEFAULT 0 NOT NULL
	CHECK (`attempt_count` >= 0);
--> statement-breakpoint
ALTER TABLE `nodix_rem_scan_pairs` ADD COLUMN `progress_state` text DEFAULT 'pending' NOT NULL
	CHECK (`progress_state` IN ('pending', 'refused', 'closed', 'exhausted'));
--> statement-breakpoint
ALTER TABLE `nodix_rem_scan_pairs` ADD COLUMN `refusal_reason` text;
--> statement-breakpoint
ALTER TABLE `nodix_rem_scan_pairs` ADD COLUMN `inherited_from_generation_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rem_scan_pairs_progress`
	ON `nodix_rem_scan_pairs` (`generation_id`, `progress_state`, `sort_key`, `pair_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_scan_invocations` (
	`generation_id` text NOT NULL,
	`invocation_id` text NOT NULL,
	`llm_calls_used` integer DEFAULT 0 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY (`generation_id`, `invocation_id`),
	FOREIGN KEY (`generation_id`) REFERENCES `nodix_rem_scan_generations`(`generation_id`)
);
