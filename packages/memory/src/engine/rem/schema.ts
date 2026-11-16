import type { RemDatabaseLike } from "./types.js";

export function installRemSchema(database: RemDatabaseLike): void {
	database.exec(`
CREATE TABLE IF NOT EXISTS nodix_rem_journal (
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
CREATE INDEX IF NOT EXISTS rem_journal_job_sequence ON nodix_rem_journal(job_id, sequence);

CREATE TABLE IF NOT EXISTS nodix_rem_memory_facets (
	memory_id TEXT NOT NULL,
	facet TEXT NOT NULL CHECK (facet IN ('current', 'history')),
	text TEXT NOT NULL,
	updated_at_ms INTEGER NOT NULL,
	PRIMARY KEY (memory_id, facet),
	FOREIGN KEY (memory_id) REFERENCES nodix_memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS rem_memory_facets_by_facet
	ON nodix_rem_memory_facets(facet, memory_id);

CREATE TRIGGER IF NOT EXISTS rem_memory_facets_after_insert
AFTER INSERT ON nodix_memories
BEGIN
	INSERT INTO nodix_rem_memory_facets(memory_id, facet, text, updated_at_ms)
		VALUES (NEW.id, 'current', NEW.text, NEW.timestamp);
END;

CREATE TRIGGER IF NOT EXISTS rem_memory_facets_after_text_update
AFTER UPDATE OF text ON nodix_memories
BEGIN
	INSERT INTO nodix_rem_memory_facets(memory_id, facet, text, updated_at_ms)
		VALUES (NEW.id, 'current', NEW.text, NEW.timestamp)
	ON CONFLICT(memory_id, facet) DO UPDATE SET
		text = excluded.text, updated_at_ms = excluded.updated_at_ms;
END;

`);
}
