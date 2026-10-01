-- The recovery record's expected_post_hash and the verified-write guard's post-write hash were
-- computed in two packages over two different column sets. Adding the memories.timezone column
-- made them disagree, so every REM text-version write refused AFTER its transaction had already
-- committed. The field list is now pinned in one place and stamped with its version: rows written
-- before this migration carry version 1, whose hash nothing can recompute, and readers branch on
-- the version instead of comparing against a value that can never match.
ALTER TABLE nodix_rem_recovery_history
ADD COLUMN row_hash_version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint

-- Crash recovery decided whether a committed write had landed by comparing the row's content_hash
-- (text AND metadata) against proposed_text_sha256 (text only). A REM update always writes
-- rem_update_* metadata, so those two never matched and a write that had committed was recorded as
-- failed forever. The expected content hash is now stamped on the attempt inside the same
-- transaction that performs the write, so a crash cannot leave them disagreeing.
ALTER TABLE nodix_rem_write_attempts
ADD COLUMN expected_post_content_sha256 TEXT;
