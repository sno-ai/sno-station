CREATE TABLE `nodix_task_lifecycle_commands` (
	`project_id` text NOT NULL,
	`command_id` text NOT NULL,
	`canonical_tuple_json` text,
	`identity_json` text NOT NULL,
	`action` text NOT NULL CHECK (`action` IN ('open_or_refine', 'complete', 'remove')),
	`source_assertion_json` text NOT NULL,
	`effective_at_ms` integer NOT NULL,
	`time_source` text NOT NULL CHECK (`time_source` IN ('event_at', 'session_time', 'first_resolution')),
	`result` text NOT NULL CHECK (`result` IN (
		'created_instance',
		'created_unresolved_instance',
		'refined',
		'evidence_only',
		'completed',
		'removed',
		'terminal_evidence_only',
		'none',
		'uncertain'
	)),
	`active_task_id` text,
	`active_task_revision_id` text,
	`diagnostics_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	PRIMARY KEY (`project_id`, `command_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `nodix_active_task_instances` (
	`project_id` text NOT NULL,
	`active_task_id` text NOT NULL,
	`opening_command_id` text NOT NULL,
	`canonical_tuple_json` text NOT NULL,
	`identity_state` text NOT NULL CHECK (`identity_state` IN ('normal', 'unresolved')),
	`status` text NOT NULL CHECK (`status` IN ('active', 'completed', 'removed')),
	`created_at_ms` integer NOT NULL,
	`terminal_at_ms` integer,
	PRIMARY KEY (`project_id`, `active_task_id`),
	UNIQUE (`project_id`, `opening_command_id`),
	FOREIGN KEY (`project_id`, `opening_command_id`)
		REFERENCES `nodix_task_lifecycle_commands` (`project_id`, `command_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `nodix_active_task_revisions` (
	`project_id` text NOT NULL,
	`active_task_revision_id` text NOT NULL,
	`active_task_id` text NOT NULL,
	`creating_command_id` text NOT NULL,
	`canonical_tuple_json` text NOT NULL,
	`description` text NOT NULL,
	`occurrence_anchors_json` text NOT NULL,
	`revision_details_json` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`is_current` integer NOT NULL CHECK (`is_current` IN (0, 1)),
	PRIMARY KEY (`project_id`, `active_task_revision_id`),
	UNIQUE (`project_id`, `active_task_id`, `creating_command_id`),
	FOREIGN KEY (`project_id`, `active_task_id`)
		REFERENCES `nodix_active_task_instances` (`project_id`, `active_task_id`),
	FOREIGN KEY (`project_id`, `creating_command_id`)
		REFERENCES `nodix_task_lifecycle_commands` (`project_id`, `command_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE UNIQUE INDEX `nodix_idx_active_task_current_revision`
ON `nodix_active_task_revisions` (`project_id`, `active_task_id`)
WHERE `is_current` = 1;
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
CREATE INDEX `nodix_idx_active_task_instances_projection`
ON `nodix_active_task_instances` (`project_id`, `status`, `created_at_ms`, `active_task_id`);
--> statement-breakpoint
CREATE INDEX `nodix_idx_active_task_evidence_instance`
ON `nodix_active_task_evidence` (`project_id`, `active_task_id`);
