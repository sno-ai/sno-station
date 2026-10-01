CREATE TABLE nodix_rem_journal (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	job_id TEXT NOT NULL,
	job_type TEXT NOT NULL CHECK (job_type IN ('rem-verdict', 'rem-restate')),
	stage TEXT NOT NULL,
	outcome TEXT NOT NULL CHECK (outcome IN ('done', 'failed', 'disabled', 'pending', 'refused', 'no-action')),
	row_id TEXT,
	pair_id TEXT,
	pairs_scanned INTEGER NOT NULL DEFAULT 0,
	verdicts INTEGER NOT NULL DEFAULT 0,
	actions_applied INTEGER NOT NULL DEFAULT 0,
	reason TEXT,
	CHECK (outcome NOT IN ('failed', 'refused') OR length(trim(reason)) > 0)
);

CREATE INDEX rem_journal_job_sequence ON nodix_rem_journal(job_id, sequence);

UPDATE __drizzle_migrations
SET hash = 'pre-rename-through-0024', created_at = 1740000000024;
