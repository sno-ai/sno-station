CREATE TABLE IF NOT EXISTS `nodix_rem_write_verdicts` (
	`evidence_id` text PRIMARY KEY NOT NULL,
	`winner_row_id` text NOT NULL,
	`loser_row_id` text NOT NULL,
	`target_row_id` text NOT NULL,
	`retired_fact_atoms_json` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_write_attempts` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`stage` text NOT NULL,
	`row_id` text NOT NULL,
	`writer` text NOT NULL,
	`attempt_ordinal` integer NOT NULL CHECK (`attempt_ordinal` > 0),
	`outcome` text NOT NULL CHECK (`outcome` IN ('pending', 'succeeded', 'failed', 'refused', 'degraded')),
	`reason_code` text,
	`pre_write_content_sha256` text NOT NULL,
	`proposed_text_sha256` text NOT NULL,
	`evidence_id` text NOT NULL,
	`configuration_sha256` text NOT NULL,
	`post_write_content_sha256` text,
	`opened_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rem_write_attempts_outcome` ON `nodix_rem_write_attempts` (`outcome`, `opened_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_census_rows` (
	`row_id` text PRIMARY KEY NOT NULL,
	`write_identity_sha256` text,
	`candidate_set_sha256` text,
	`generation_id` text,
	`corpus_sha256` text,
	`embedder_sha256` text,
	`configuration_sha256` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_generation_transitions` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`outgoing_generation_id` text NOT NULL,
	`incoming_generation_id` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_batch_summaries` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`generation_id` text UNIQUE,
	`calls` integer NOT NULL DEFAULT 0,
	`tokens` integer NOT NULL DEFAULT 0,
	`pairCount` integer NOT NULL DEFAULT 0,
	`closeCount` integer NOT NULL DEFAULT 0,
	`refusalCount` integer NOT NULL DEFAULT 0,
	`verdict_distribution_json` text NOT NULL DEFAULT '{}',
	`pre_truncation_count` integer,
	`emitted_count` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `nodix_rem_verdict_observations` (
	`pair_id` text PRIMARY KEY NOT NULL,
	`audit_kind` text NOT NULL CHECK (`audit_kind` IN ('VERDICT', 'SAMPLE')),
	`persisted_verdict` text,
	`raw_value` text NOT NULL
);
