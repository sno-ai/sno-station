CREATE TABLE IF NOT EXISTS `nodix_rem_pair_stage_budgets` (
	`generation_id` text NOT NULL,
	`pair_id` text NOT NULL,
	`stage` text NOT NULL,
	`invocation_id` text NOT NULL,
	`reserved_tokens` integer NOT NULL CHECK (`reserved_tokens` >= 0),
	`idempotency_key` text NOT NULL,
	PRIMARY KEY (`generation_id`, `pair_id`, `stage`),
	FOREIGN KEY (`generation_id`, `pair_id`) REFERENCES `nodix_rem_scan_pairs`(`generation_id`, `pair_id`),
	FOREIGN KEY (`generation_id`, `invocation_id`) REFERENCES `nodix_rem_scan_invocations`(`generation_id`, `invocation_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_journal_next` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`job_id` text NOT NULL,
	`job_type` text NOT NULL CHECK (`job_type` IN ('rem-verdict', 'rem-restate')),
	`stage` text NOT NULL,
	`outcome` text NOT NULL CHECK (`outcome` IN ('done', 'failed', 'disabled', 'pending', 'refused', 'no-action')),
	`pairs_scanned` integer NOT NULL DEFAULT 0,
	`verdicts` integer NOT NULL DEFAULT 0,
	`actions_applied` integer NOT NULL DEFAULT 0,
	`reason` text,
	`row_id` text,
	`pair_id` text,
	CHECK (`outcome` NOT IN ('failed', 'refused') OR length(trim(`reason`)) > 0)
);
--> statement-breakpoint
INSERT INTO `nodix_rem_journal_next`(
	`sequence`, `job_id`, `job_type`, `stage`, `outcome`, `pairs_scanned`, `verdicts`,
	`actions_applied`, `reason`
)
	SELECT `sequence`, `job_id`, `job_type`, `stage`, `outcome`, `pairs_scanned`, `verdicts`,
		`actions_applied`, `reason`
	FROM `nodix_rem_journal`;
--> statement-breakpoint
DROP TABLE `nodix_rem_journal`;
--> statement-breakpoint
ALTER TABLE `nodix_rem_journal_next` RENAME TO `nodix_rem_journal`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rem_journal_job_sequence` ON `nodix_rem_journal` (`job_id`, `sequence`);
