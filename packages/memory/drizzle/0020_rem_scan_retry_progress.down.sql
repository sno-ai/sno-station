-- Schema rollback: removes the retry columns so the paired forward migration can run again.
DROP INDEX `rem_scan_pairs_progress`;
--> statement-breakpoint
DROP TABLE `nodix_rem_scan_invocations`;
--> statement-breakpoint
ALTER TABLE `nodix_rem_scan_pairs` DROP COLUMN `inherited_from_generation_id`;
--> statement-breakpoint
ALTER TABLE `nodix_rem_scan_pairs` DROP COLUMN `refusal_reason`;
--> statement-breakpoint
ALTER TABLE `nodix_rem_scan_pairs` DROP COLUMN `progress_state`;
--> statement-breakpoint
ALTER TABLE `nodix_rem_scan_pairs` DROP COLUMN `attempt_count`;
--> statement-breakpoint
ALTER TABLE `nodix_rem_scan_pairs` DROP COLUMN `budget_invocation_id`;
