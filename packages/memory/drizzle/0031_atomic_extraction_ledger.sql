CREATE TABLE nodix_atomic_extraction_ledger (
  conversation_id TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'calls_recorded', 'complete', 'pending_reprocess')),
  raw_chunk TEXT NOT NULL,
  routing_snapshot_id TEXT NOT NULL,
  run_parameters_json TEXT NOT NULL CHECK (json_valid(run_parameters_json)),
  reprocess_reason TEXT CHECK (reprocess_reason IN (
    'input-overflow',
    'double-cap-saturation',
    'truncation-exhaustion',
    'parse-exhaustion'
  )),
  reprocess_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (reprocess_attempt_count >= 0),
  failed_reply TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, chunk_hash, pipeline_version)
);
--> statement-breakpoint
CREATE INDEX nodix_idx_atomic_extraction_ledger_state
ON nodix_atomic_extraction_ledger(state, reprocess_attempt_count);
