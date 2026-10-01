import type { RemDatabaseLike } from "./types.js";

const REM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodix_rem_relation_ledger (
	row_id TEXT PRIMARY KEY,
	content_hash TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('transition', 'stale-current', 'pure-negation', 'ambiguous')),
	owner TEXT NOT NULL DEFAULT 'none' CHECK (owner IN ('restate', 'verdict', 'none')),
	claim_ts TEXT,
	classified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodix_rem_row_claims (
	row_id TEXT PRIMARY KEY,
	content_hash TEXT NOT NULL,
	owner TEXT NOT NULL CHECK (owner IN ('restate', 'verdict')),
	claim_token TEXT NOT NULL,
	holder_pid INTEGER NOT NULL CHECK (holder_pid > 0),
	holder_process_start TEXT NOT NULL,
	holder_boot_id TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'completed')),
	claimed_at TEXT NOT NULL,
	completed_at TEXT,
	FOREIGN KEY (row_id) REFERENCES nodix_rem_relation_ledger(row_id)
);

CREATE TABLE IF NOT EXISTS nodix_rem_scan_generations (
	generation_id TEXT PRIMARY KEY,
	corpus_snapshot_hash TEXT NOT NULL,
	pairing_config_hash TEXT NOT NULL,
	max_llm_calls INTEGER NOT NULL CHECK (max_llm_calls >= 0),
	max_tokens INTEGER NOT NULL CHECK (max_tokens >= 0),
	llm_calls_used INTEGER NOT NULL DEFAULT 0,
	tokens_used INTEGER NOT NULL DEFAULT 0,
	pending_stages_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS nodix_rem_scan_pairs (
	generation_id TEXT NOT NULL,
	pair_id TEXT NOT NULL,
	left_row_id TEXT NOT NULL,
	right_row_id TEXT NOT NULL,
	sort_key TEXT NOT NULL,
	claim_state TEXT NOT NULL DEFAULT 'unvisited'
		CHECK (claim_state IN ('unvisited', 'claimed', 'done')),
	invocation_id TEXT,
	claimed_at TEXT,
	checkpoint TEXT,
	verdict TEXT,
	actions_applied INTEGER NOT NULL DEFAULT 0 CHECK (actions_applied IN (0, 1)),
	budget_reserved INTEGER NOT NULL DEFAULT 0 CHECK (budget_reserved IN (0, 1)),
	budget_invocation_id TEXT,
	reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	progress_state TEXT NOT NULL DEFAULT 'pending'
		CHECK (progress_state IN ('pending', 'refused', 'closed', 'exhausted')),
	refusal_reason TEXT,
	inherited_from_generation_id TEXT,
	PRIMARY KEY (generation_id, pair_id),
	FOREIGN KEY (generation_id) REFERENCES nodix_rem_scan_generations(generation_id)
);
CREATE INDEX IF NOT EXISTS rem_scan_pairs_cursor
	ON nodix_rem_scan_pairs(generation_id, claim_state, sort_key, pair_id);

CREATE TABLE IF NOT EXISTS nodix_rem_scan_invocations (
	generation_id TEXT NOT NULL,
	invocation_id TEXT NOT NULL,
	llm_calls_used INTEGER NOT NULL DEFAULT 0,
	tokens_used INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	PRIMARY KEY (generation_id, invocation_id),
	FOREIGN KEY (generation_id) REFERENCES nodix_rem_scan_generations(generation_id)
);

CREATE TABLE IF NOT EXISTS nodix_rem_pair_stage_budgets (
	generation_id TEXT NOT NULL,
	pair_id TEXT NOT NULL,
	stage TEXT NOT NULL,
	invocation_id TEXT NOT NULL,
	reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens >= 0),
	idempotency_key TEXT NOT NULL,
	PRIMARY KEY (generation_id, pair_id, stage),
	FOREIGN KEY (generation_id, pair_id) REFERENCES nodix_rem_scan_pairs(generation_id, pair_id),
	FOREIGN KEY (generation_id, invocation_id) REFERENCES nodix_rem_scan_invocations(generation_id, invocation_id)
);

CREATE TABLE IF NOT EXISTS nodix_rem_pair_claims (
	generation_id TEXT NOT NULL,
	pair_id TEXT NOT NULL,
	claim_token TEXT NOT NULL,
	holder_pid INTEGER NOT NULL CHECK (holder_pid > 0),
	holder_process_start TEXT NOT NULL,
	holder_boot_id TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'completed')),
	claimed_at TEXT NOT NULL,
	completed_at TEXT,
	PRIMARY KEY (generation_id, pair_id),
	FOREIGN KEY (generation_id, pair_id) REFERENCES nodix_rem_scan_pairs(generation_id, pair_id)
);

CREATE TABLE IF NOT EXISTS nodix_rem_journal (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	job_id TEXT NOT NULL,
	job_type TEXT NOT NULL,
	stage TEXT NOT NULL,
	attempt_id TEXT,
	outcome TEXT NOT NULL CHECK (outcome IN ('done', 'failed', 'disabled', 'pending', 'refused', 'no-action')),
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

CREATE TABLE IF NOT EXISTS nodix_rem_recovery_history (
	recovery_handle TEXT PRIMARY KEY,
	row_id TEXT NOT NULL,
	operation_kind TEXT NOT NULL CHECK (operation_kind IN ('lane', 'text-version', 'mark')),
	prior_row_image TEXT NOT NULL,
	prior_content_hash TEXT NOT NULL,
	expected_post_hash TEXT NOT NULL,
	row_hash_version INTEGER NOT NULL DEFAULT 1,
	reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
	mutation_ts TEXT NOT NULL,
	restored_at TEXT
);
CREATE INDEX IF NOT EXISTS rem_recovery_history_row ON nodix_rem_recovery_history(row_id);

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

CREATE TABLE IF NOT EXISTS nodix_rem_facet_recovery (
	recovery_handle TEXT PRIMARY KEY,
	prior_facets_json TEXT NOT NULL,
	prior_chunk_facets_json TEXT NOT NULL,
	expected_facets_json TEXT NOT NULL,
	expected_chunk_facets_json TEXT NOT NULL,
	FOREIGN KEY (recovery_handle) REFERENCES nodix_rem_recovery_history(recovery_handle)
);

CREATE TABLE IF NOT EXISTS nodix_rem_write_verdicts (
	evidence_id TEXT PRIMARY KEY,
	winner_row_id TEXT NOT NULL,
	loser_row_id TEXT NOT NULL,
	target_row_id TEXT NOT NULL,
	retired_fact_atoms_json TEXT NOT NULL,
	recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodix_rem_write_attempts (
	attempt_id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	stage TEXT NOT NULL,
	row_id TEXT NOT NULL,
	writer TEXT NOT NULL,
	attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal > 0),
	outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'succeeded', 'failed', 'refused', 'degraded')),
	reason_code TEXT,
	pre_write_content_sha256 TEXT NOT NULL,
	proposed_text_sha256 TEXT NOT NULL,
	evidence_id TEXT NOT NULL,
	configuration_sha256 TEXT NOT NULL,
	expected_post_content_sha256 TEXT,
	post_write_content_sha256 TEXT,
	opened_at TEXT NOT NULL,
	closed_at TEXT
);
CREATE INDEX IF NOT EXISTS rem_write_attempts_outcome ON nodix_rem_write_attempts(outcome, opened_at);

CREATE TABLE IF NOT EXISTS nodix_rem_census_rows (
	row_id TEXT PRIMARY KEY,
	write_identity_sha256 TEXT,
	candidate_set_sha256 TEXT,
	generation_id TEXT,
	corpus_sha256 TEXT,
	embedder_sha256 TEXT,
	configuration_sha256 TEXT
);

CREATE TABLE IF NOT EXISTS nodix_rem_generation_transitions (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	outgoing_generation_id TEXT NOT NULL,
	incoming_generation_id TEXT NOT NULL,
	recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodix_rem_batch_summaries (
	batch_id TEXT PRIMARY KEY,
	generation_id TEXT UNIQUE,
	calls INTEGER NOT NULL DEFAULT 0,
	tokens INTEGER NOT NULL DEFAULT 0,
	pairCount INTEGER NOT NULL DEFAULT 0,
	closeCount INTEGER NOT NULL DEFAULT 0,
	refusalCount INTEGER NOT NULL DEFAULT 0,
	verdict_distribution_json TEXT NOT NULL DEFAULT '{}',
	pre_truncation_count INTEGER,
	emitted_count INTEGER
);

CREATE TABLE IF NOT EXISTS nodix_rem_verdict_observations (
	pair_id TEXT PRIMARY KEY,
	audit_kind TEXT NOT NULL CHECK (audit_kind IN ('VERDICT', 'SAMPLE')),
	persisted_verdict TEXT,
	raw_value TEXT NOT NULL
);
`;

export function installRemSchema(database: RemDatabaseLike): void {
	database.exec(REM_SCHEMA_SQL);
	ensureAmbiguousRowState(database);
	ensureHolderBootIdColumn(database, "nodix_rem_row_claims");
	ensureHolderBootIdColumn(database, "nodix_rem_pair_claims");
	ensureJournalNullableColumn(database, "row_id");
	ensureJournalNullableColumn(database, "pair_id");
	ensureJournalNullableColumn(database, "attempt_id");
	ensureJournalNullableColumn(database, "detail");
	database.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS rem_journal_external_decision_attempt
			ON nodix_rem_journal(attempt_id)
			WHERE attempt_id IS NOT NULL AND stage IN ('arbitration', 'coverage');
	`);
	ensureRemChunkFacet(database);
	backfillRemCurrentFacets(database);
}

function ensureAmbiguousRowState(database: RemDatabaseLike): void {
	const row = database
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodix_rem_relation_ledger'")
		.get() as { sql?: string } | undefined;
	if (row?.sql?.includes("'ambiguous'")) return;
	database.exec("PRAGMA foreign_keys = OFF");
	try {
		database.transaction(() => {
			database.exec(`
				CREATE TABLE nodix_rem_relation_ledger_next (
					row_id TEXT PRIMARY KEY,
					content_hash TEXT NOT NULL,
					state TEXT NOT NULL CHECK (state IN ('transition', 'stale-current', 'pure-negation', 'ambiguous')),
					owner TEXT NOT NULL DEFAULT 'none' CHECK (owner IN ('restate', 'verdict', 'none')),
					claim_ts TEXT,
					classified_at TEXT NOT NULL
				);
				INSERT INTO nodix_rem_relation_ledger_next(
					row_id, content_hash, state, owner, claim_ts, classified_at
				) SELECT row_id, content_hash, state, owner, claim_ts, classified_at
				FROM nodix_rem_relation_ledger;
				DROP TABLE nodix_rem_relation_ledger;
				ALTER TABLE nodix_rem_relation_ledger_next RENAME TO nodix_rem_relation_ledger;
			`);
		}).immediate();
	} finally {
		database.exec("PRAGMA foreign_keys = ON");
	}
}

function ensureRemChunkFacet(database: RemDatabaseLike): void {
	if (!tableExists(database, "nodix_memory_chunks")) return;
	const columns = database.prepare("PRAGMA table_info(nodix_memory_chunks)").all() as Array<{
		name: string;
	}>;
	if (!columns.some(({ name }) => name === "facet")) {
		database.exec(
			"ALTER TABLE nodix_memory_chunks ADD COLUMN facet TEXT NOT NULL DEFAULT 'current' CHECK (facet IN ('current', 'history'))",
		);
	}
	database.exec(`
		DROP INDEX IF EXISTS nodix_idx_memory_chunks_memory;
		CREATE UNIQUE INDEX IF NOT EXISTS nodix_idx_memory_chunks_memory_facet
			ON nodix_memory_chunks(memory_id, facet, chunk_index);
	`);
}

function backfillRemCurrentFacets(database: RemDatabaseLike): void {
	if (!tableExists(database, "nodix_memories")) return;
	database.exec(`
		INSERT OR IGNORE INTO nodix_rem_memory_facets(memory_id, facet, text, updated_at_ms)
			SELECT id, 'current', text, timestamp FROM nodix_memories;
	`);
}

function tableExists(database: RemDatabaseLike, tableName: string): boolean {
	return (
		database
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(tableName) !== undefined
	);
}

// `detail` joined the identity columns here because it has the same shape: nullable text a store
// written before it existed simply does not have. It is NOT an identity — see `JournalEntry.detail`
// for what it carries — which is why the name no longer says identity.
function ensureJournalNullableColumn(
	database: RemDatabaseLike,
	column: "row_id" | "pair_id" | "attempt_id" | "detail",
): void {
	const columns = database.prepare("PRAGMA table_info(nodix_rem_journal)").all() as Array<{ name: string }>;
	if (columns.some((candidate) => candidate.name === column)) return;
	database.exec(`ALTER TABLE nodix_rem_journal ADD COLUMN ${column} TEXT`);
}

function ensureHolderBootIdColumn(
	database: RemDatabaseLike,
	tableName: "nodix_rem_row_claims" | "nodix_rem_pair_claims",
): void {
	const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
		name: string;
	}>;
	if (columns.some((column) => column.name === "holder_boot_id")) return;
	database.exec(`ALTER TABLE ${tableName} ADD COLUMN holder_boot_id TEXT`);
}
