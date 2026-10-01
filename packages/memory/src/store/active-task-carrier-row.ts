/** @file active-task-carrier-row.ts
 * @purpose Builds the durable per-task carrier row shared by the live writer and the backfill.
 * @boundary Pure row construction and validation; performs no I/O and touches no tables.
 */

import {
	activeTaskShape,
	boundActiveTaskTitle,
} from "../engine/extraction/active-task-projection";
import { buildIndexedText } from "../engine/extraction/extraction-text-sanitizer";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../engine/extraction/memory-metadata-codec";
import { hashLengthPrefixedTuple } from "../engine/extraction/task-lifecycle-assertion";
import { hashInputForEntry, stableHash } from "./memory-store-shared";
import { validateStoreWriteMetadata } from "./memory-store-write-validation";

export interface ActiveTaskCarrierFacts {
	projectId: string;
	activeTaskId: string;
	/** The command this row is written by; the row id is derived from it. */
	commandId: string;
	/** The full, untruncated current description. Never bounded here. */
	description: string;
	createdAtMs: number;
	openingCommandId: string;
	openingDescription: string;
	status: "active" | "completed" | "removed";
	transitionedAtMs: number;
	/** Row timestamp. The live writer uses the assertion's effective time. */
	timestampMs: number;
}

export interface ActiveTaskCarrierRow {
	id: string;
	activeTaskId: string;
	text: string;
	metadata: string;
	contentHash: string;
}

function normalizeForDisplay(description: string): string {
	return description.replace(/\s+/gu, " ").trim();
}

/**
 * One construction site for the carrier, used by both the live lifecycle writer
 * and the backfill. Two sites would drift, and a backfill that wrote a subtly
 * different shape from the writer would be invisible until a validator changed
 * under it.
 *
 * The row id is a pure function of `(projectId, activeTaskId, commandId)`, so
 * replaying a command — or re-running the backfill, which passes the instance's
 * opening command — produces the same id and therefore no second row.
 */
export function buildActiveTaskCarrierRow(
	facts: ActiveTaskCarrierFacts,
	operation: string,
	countRecordTokens: (text: string) => number,
): ActiveTaskCarrierRow {
	const text = buildIndexedText(facts.description, facts.description);
	const id = `atc_${hashLengthPrefixedTuple([
		"active-task-carrier-v1",
		facts.projectId,
		facts.activeTaskId,
		facts.commandId,
	])}`;
	const lifecycle: {
		from: null | "active";
		to: "active" | "completed" | "removed";
		at: number;
		source_id: string;
	}[] = [
		// Each event names the command that caused it, so the opening entry keeps
		// pointing at the opening command even on a carrier written by a later one.
		{ from: null, to: "active", at: facts.createdAtMs, source_id: facts.openingCommandId },
	];
	if (facts.status !== "active") {
		lifecycle.push({
			from: "active",
			to: facts.status,
			at: facts.transitionedAtMs,
			source_id: facts.commandId,
		});
	}
	const metadata = stringifyInsightMetadata(
		buildInsightMetadata(
			{ text, category: "profile", timestamp: facts.timestampMs },
			{
				l0_abstract: boundActiveTaskTitle(
					normalizeForDisplay(facts.description),
					activeTaskShape().titleMaxTokens,
				),
				l1_overview: facts.description,
				l2_content: facts.description,
				tier: "core",
				access_count: 0,
				confidence: 0.85,
				last_accessed_at: facts.timestampMs,
				asserted_at: facts.timestampMs,
				valid_from: facts.createdAtMs,
				state: "confirmed",
				source: "ambient-learning",
				injected_count: 0,
				bad_recall_count: 0,
				suppressed_until_turn: 0,
				section_name: "active_tasks",
				// No fact_key here: the codec derives it from section_name plus
				// active_task_kind and active_task_id (`deriveFactKey`), on both the
				// build and the parse path, so passing one would be ignored and a
				// mismatch is not representable.
				active_task_kind: "task",
				active_task_id: facts.activeTaskId,
				active_task_origin: {
					kind: "runtime",
					source_id: facts.openingCommandId,
					normalized_description: normalizeForDisplay(facts.openingDescription),
				},
				active_task_status: facts.status,
				active_task_created_at: facts.createdAtMs,
				active_task_transitioned_at: facts.transitionedAtMs,
				active_task_lifecycle: lifecycle,
				idempotency_key: `task_lifecycle_carrier_${facts.commandId}_${facts.activeTaskId}`,
				// The superseded carrier stays in the table, so a transition that leaves the text
				// unchanged would collide with the row it replaces on (project, hash, category).
				// This row's identity is the write, and it says so instead of borrowing the
				// retry key to mean it.
				content_identity_key: `task_lifecycle_carrier_${facts.commandId}_${facts.activeTaskId}`,
			},
		),
	);
	const validated = validateStoreWriteMetadata(
		{
			text,
			category: "profile",
			metadata,
			timestamp: facts.timestampMs,
			trusted: true,
			enforceWriteAuthority: true,
			lane: "active",
		},
		operation,
		countRecordTokens,
	);
	return {
		id,
		activeTaskId: facts.activeTaskId,
		text,
		metadata: validated.metadata,
		contentHash: stableHash(hashInputForEntry(text, validated.metadata)),
	};
}
