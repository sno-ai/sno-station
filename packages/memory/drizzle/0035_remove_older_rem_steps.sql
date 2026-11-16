DROP TABLE IF EXISTS `nodix_rem_pair_stage_budgets`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_pair_claims`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_row_claims`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_scan_pairs`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_scan_invocations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_scan_generations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_relation_ledger`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_facet_recovery`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_recovery_history`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_write_verdicts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_write_attempts`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_generation_transitions`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_batch_summaries`;
--> statement-breakpoint
DROP TABLE IF EXISTS `nodix_rem_verdict_observations`;
--> statement-breakpoint
CREATE TABLE nodix_rem_journal_next (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 job_id TEXT NOT NULL,
 job_type TEXT NOT NULL,
 stage TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK (outcome IN ('done', 'failed', 'disabled', 'pending', 'refused', 'no-action', 'replaced', 'merged', 'corrected', 'removed', 'fine', 'undecided')),
 row_id TEXT,
 pair_id TEXT,
 pairs_scanned INTEGER NOT NULL DEFAULT 0,
 verdicts INTEGER NOT NULL DEFAULT 0,
 actions_applied INTEGER NOT NULL DEFAULT 0,
 reason TEXT,
 detail TEXT,
 CHECK (outcome NOT IN ('failed', 'refused') OR length(trim(reason)) > 0)
);
--> statement-breakpoint
INSERT INTO nodix_rem_journal_next(sequence, job_id, job_type, stage, outcome, row_id, pair_id, pairs_scanned, verdicts, actions_applied, reason, detail)
 SELECT sequence, job_id, job_type, stage, outcome, row_id, pair_id, pairs_scanned, verdicts, actions_applied, reason, detail FROM nodix_rem_journal;
--> statement-breakpoint
DROP TABLE nodix_rem_journal;
--> statement-breakpoint
ALTER TABLE nodix_rem_journal_next RENAME TO nodix_rem_journal;
--> statement-breakpoint
CREATE INDEX rem_journal_job_sequence ON nodix_rem_journal(job_id, sequence);
