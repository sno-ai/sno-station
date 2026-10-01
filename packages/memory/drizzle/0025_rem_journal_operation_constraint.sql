CREATE TABLE `nodix_rem_journal_next` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`job_id` text NOT NULL,
	`job_type` text NOT NULL,
	`stage` text NOT NULL,
	`outcome` text NOT NULL CHECK (`outcome` IN ('done', 'failed', 'disabled', 'pending', 'refused', 'no-action')),
	`row_id` text,
	`pair_id` text,
	`pairs_scanned` integer NOT NULL DEFAULT 0,
	`verdicts` integer NOT NULL DEFAULT 0,
	`actions_applied` integer NOT NULL DEFAULT 0,
	`reason` text,
	CHECK (`outcome` NOT IN ('failed', 'refused') OR length(trim(`reason`)) > 0)
);
--> statement-breakpoint
INSERT INTO `nodix_rem_journal_next`(
	`sequence`, `job_id`, `job_type`, `stage`, `outcome`, `row_id`, `pair_id`,
	`pairs_scanned`, `verdicts`, `actions_applied`, `reason`
)
	SELECT `sequence`, `job_id`, `job_type`, `stage`, `outcome`, `row_id`, `pair_id`,
		`pairs_scanned`, `verdicts`, `actions_applied`, `reason`
	FROM `nodix_rem_journal`;
--> statement-breakpoint
DROP TABLE `nodix_rem_journal`;
--> statement-breakpoint
ALTER TABLE `nodix_rem_journal_next` RENAME TO `nodix_rem_journal`;
--> statement-breakpoint
CREATE INDEX `rem_journal_job_sequence` ON `nodix_rem_journal` (`job_id`, `sequence`);
