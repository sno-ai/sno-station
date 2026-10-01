ALTER TABLE `nodix_active_task_evidence` RENAME TO `nodix_active_task_evidence_v15`;
--> statement-breakpoint
ALTER TABLE `nodix_active_task_transitions` RENAME TO `nodix_active_task_transitions_v15`;
--> statement-breakpoint
ALTER TABLE `nodix_active_task_revisions` RENAME TO `nodix_active_task_revisions_v15`;
--> statement-breakpoint
ALTER TABLE `nodix_active_task_instances` RENAME TO `nodix_active_task_instances_v15`;
--> statement-breakpoint
CREATE TABLE `nodix_active_task_instances` (
	`project_id` text NOT NULL,
	`active_task_id` text NOT NULL,
	`opening_command_id` text,
	`canonical_tuple_json` text NOT NULL,
	`identity_state` text NOT NULL CHECK (`identity_state` IN ('normal', 'unresolved')),
	`status` text NOT NULL CHECK (`status` IN ('active', 'completed', 'removed')),
	`created_at_ms` integer NOT NULL,
	`terminal_at_ms` integer,
	`legacy_row_locators_json` text,
	`preserved_lifecycle_events_json` text,
	`provenance_json` text,
	`binding_evidence_json` text,
	PRIMARY KEY (`project_id`, `active_task_id`),
	UNIQUE (`project_id`, `opening_command_id`),
	FOREIGN KEY (`project_id`, `opening_command_id`)
		REFERENCES `nodix_task_lifecycle_commands` (`project_id`, `command_id`)
) WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO `nodix_active_task_instances`(
	`project_id`, `active_task_id`, `opening_command_id`, `canonical_tuple_json`,
	`identity_state`, `status`, `created_at_ms`, `terminal_at_ms`
)
SELECT
	`project_id`, `active_task_id`, `opening_command_id`, `canonical_tuple_json`,
	`identity_state`, `status`, `created_at_ms`, `terminal_at_ms`
FROM `nodix_active_task_instances_v15`;
--> statement-breakpoint
CREATE TABLE `nodix_active_task_revisions` (
	`project_id` text NOT NULL,
	`active_task_revision_id` text NOT NULL,
	`active_task_id` text NOT NULL,
	`creating_command_id` text,
	`canonical_tuple_json` text NOT NULL,
	`description` text NOT NULL,
	`occurrence_anchors_json` text NOT NULL,
	`revision_details_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`is_current` integer NOT NULL CHECK (`is_current` IN (0, 1)),
	`legacy_row_locator` text,
	PRIMARY KEY (`project_id`, `active_task_revision_id`),
	UNIQUE (`project_id`, `active_task_id`, `creating_command_id`),
	FOREIGN KEY (`project_id`, `active_task_id`)
		REFERENCES `nodix_active_task_instances` (`project_id`, `active_task_id`),
	FOREIGN KEY (`project_id`, `creating_command_id`)
		REFERENCES `nodix_task_lifecycle_commands` (`project_id`, `command_id`)
) WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO `nodix_active_task_revisions`(
	`project_id`, `active_task_revision_id`, `active_task_id`, `creating_command_id`,
	`canonical_tuple_json`, `description`, `occurrence_anchors_json`,
	`revision_details_json`, `created_at_ms`, `is_current`
)
SELECT
	`project_id`, `active_task_revision_id`, `active_task_id`, `creating_command_id`,
	`canonical_tuple_json`, `description`, `occurrence_anchors_json`,
	`revision_details_json`, `created_at_ms`, `is_current`
FROM `nodix_active_task_revisions_v15`;
--> statement-breakpoint
CREATE TABLE `nodix_active_task_transitions` (
	`project_id` text NOT NULL,
	`command_id` text NOT NULL,
	`active_task_id` text NOT NULL,
	`transition_kind` text NOT NULL CHECK (`transition_kind` IN ('open', 'refine', 'complete', 'remove')),
	`from_status` text CHECK (`from_status` IS NULL OR `from_status` IN ('active', 'completed', 'removed')),
	`to_status` text NOT NULL CHECK (`to_status` IN ('active', 'completed', 'removed')),
	`effective_at_ms` integer NOT NULL,
	PRIMARY KEY (`project_id`, `command_id`),
	FOREIGN KEY (`project_id`, `command_id`)
		REFERENCES `nodix_task_lifecycle_commands` (`project_id`, `command_id`),
	FOREIGN KEY (`project_id`, `active_task_id`)
		REFERENCES `nodix_active_task_instances` (`project_id`, `active_task_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `nodix_active_task_evidence` (
	`project_id` text NOT NULL,
	`command_id` text NOT NULL,
	`active_task_id` text,
	`evidence_memory_id` text,
	`source_assertion_json` text NOT NULL,
	`outcome` text NOT NULL,
	`diagnostics_json` text NOT NULL,
	`linked_at_ms` integer NOT NULL,
	PRIMARY KEY (`project_id`, `command_id`),
	FOREIGN KEY (`project_id`, `command_id`)
		REFERENCES `nodix_task_lifecycle_commands` (`project_id`, `command_id`),
	FOREIGN KEY (`project_id`, `active_task_id`)
		REFERENCES `nodix_active_task_instances` (`project_id`, `active_task_id`)
) WITHOUT ROWID;
--> statement-breakpoint
INSERT INTO `nodix_active_task_transitions`
SELECT * FROM `nodix_active_task_transitions_v15`;
--> statement-breakpoint
INSERT INTO `nodix_active_task_evidence`
SELECT * FROM `nodix_active_task_evidence_v15`;
--> statement-breakpoint
DROP TABLE `nodix_active_task_transitions_v15`;
--> statement-breakpoint
DROP TABLE `nodix_active_task_evidence_v15`;
--> statement-breakpoint
DROP TABLE `nodix_active_task_revisions_v15`;
--> statement-breakpoint
DROP TABLE `nodix_active_task_instances_v15`;
--> statement-breakpoint
CREATE UNIQUE INDEX `nodix_idx_active_task_current_revision`
ON `nodix_active_task_revisions` (`project_id`, `active_task_id`)
WHERE `is_current` = 1;
--> statement-breakpoint
CREATE TABLE `nodix_active_task_migration_evidence` (
	`project_id` text NOT NULL,
	`legacy_row_locator` text NOT NULL,
	`active_task_id` text NOT NULL,
	`command_id` text,
	`source_row_json` text NOT NULL,
	`revision_role` text NOT NULL CHECK (`revision_role` IN ('current', 'terminal_non_current', 'evidence_only')),
	`preserved_unbound` integer NOT NULL CHECK (`preserved_unbound` IN (0, 1)),
	PRIMARY KEY (`project_id`, `legacy_row_locator`),
	FOREIGN KEY (`project_id`, `active_task_id`)
		REFERENCES `nodix_active_task_instances` (`project_id`, `active_task_id`),
	FOREIGN KEY (`project_id`, `command_id`)
		REFERENCES `nodix_task_lifecycle_commands` (`project_id`, `command_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `nodix_active_task_migration_manifests` (
	`manifest_id` text NOT NULL PRIMARY KEY,
	`manifest_hash` text NOT NULL,
	`input_store_hash` text NOT NULL,
	`state_hash` text NOT NULL,
	`applied_at_ms` integer NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `nodix_idx_active_task_instances_projection`
ON `nodix_active_task_instances` (`project_id`, `status`, `created_at_ms`, `active_task_id`);
--> statement-breakpoint
CREATE INDEX `nodix_idx_active_task_evidence_instance`
ON `nodix_active_task_evidence` (`project_id`, `active_task_id`);
