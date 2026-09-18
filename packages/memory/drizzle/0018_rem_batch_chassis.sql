CREATE TABLE IF NOT EXISTS `nodix_rem_relation_ledger` (
	`row_id` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`state` text NOT NULL CHECK (`state` IN ('transition', 'stale-current', 'pure-negation')),
	`owner` text DEFAULT 'none' NOT NULL CHECK (`owner` IN ('restate', 'verdict', 'none')),
	`claim_ts` text,
	`classified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_scan_generations` (
	`generation_id` text PRIMARY KEY NOT NULL,
	`corpus_snapshot_hash` text NOT NULL,
	`pairing_config_hash` text NOT NULL,
	`max_llm_calls` integer NOT NULL CHECK (`max_llm_calls` >= 0),
	`max_tokens` integer NOT NULL CHECK (`max_tokens` >= 0),
	`llm_calls_used` integer DEFAULT 0 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`pending_stages_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_scan_pairs` (
	`generation_id` text NOT NULL,
	`pair_id` text NOT NULL,
	`left_row_id` text NOT NULL,
	`right_row_id` text NOT NULL,
	`sort_key` text NOT NULL,
	`claim_state` text DEFAULT 'unvisited' NOT NULL
		CHECK (`claim_state` IN ('unvisited', 'claimed', 'done')),
	`invocation_id` text,
	`claimed_at` text,
	`checkpoint` text,
	`verdict` text,
	`actions_applied` integer DEFAULT 0 NOT NULL CHECK (`actions_applied` IN (0, 1)),
	`budget_reserved` integer DEFAULT 0 NOT NULL CHECK (`budget_reserved` IN (0, 1)),
	`reserved_tokens` integer DEFAULT 0 NOT NULL CHECK (`reserved_tokens` >= 0),
	PRIMARY KEY (`generation_id`, `pair_id`),
	FOREIGN KEY (`generation_id`) REFERENCES `nodix_rem_scan_generations`(`generation_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rem_scan_pairs_cursor`
	ON `nodix_rem_scan_pairs` (`generation_id`, `claim_state`, `sort_key`, `pair_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_journal` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`job_type` text NOT NULL CHECK (`job_type` IN ('rem-verdict', 'rem-restate')),
	`stage` text NOT NULL,
	`outcome` text NOT NULL
		CHECK (`outcome` IN ('done', 'failed', 'disabled', 'pending', 'refused')),
	`pairs_scanned` integer DEFAULT 0 NOT NULL,
	`verdicts` integer DEFAULT 0 NOT NULL,
	`actions_applied` integer DEFAULT 0 NOT NULL,
	`reason` text,
	CHECK (`outcome` NOT IN ('failed', 'refused') OR length(trim(`reason`)) > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rem_journal_job_sequence` ON `nodix_rem_journal` (`job_id`, `sequence`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_recovery_history` (
	`recovery_handle` text PRIMARY KEY NOT NULL,
	`row_id` text NOT NULL,
	`operation_kind` text NOT NULL CHECK (`operation_kind` IN ('lane', 'text-version', 'mark')),
	`prior_row_image` text NOT NULL,
	`prior_content_hash` text NOT NULL,
	`expected_post_hash` text NOT NULL,
	`reason` text NOT NULL CHECK (length(trim(`reason`)) > 0),
	`mutation_ts` text NOT NULL,
	`restored_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rem_recovery_history_row` ON `nodix_rem_recovery_history` (`row_id`);
