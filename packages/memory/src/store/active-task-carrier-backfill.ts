/** @file active-task-carrier-backfill.ts
 * @purpose Creates the missing per-task carrier row for stores written without one.
 * @boundary Additive only: reads lifecycle state, inserts memory and chunk rows, deletes nothing.
 */

import { createLogger, privateLogReference } from "@snoai/utils/logger";
import { buildActiveTaskCarrierRow } from "./active-task-carrier-row";
import type { MemoryStore, MemoryStoreInternals } from "./memory-store-base";
import { StorageError } from "./memory-store-shared";
import { hostTimezone, recordTokenCounter } from "./memory-store-write-validation";

const log = createLogger("active-task-carrier-backfill");

interface CarrierlessTaskRow {
	projectId: string;
	activeTaskId: string;
	openingCommandId: string | null;
	createdAtMs: number | null;
	status: string | null;
	terminalAtMs: number | null;
	openingDescription: string | null;
	currentDescription: string | null;
	identityState: string | null;
}

export interface ActiveTaskCarrierBackfillReport {
	/** project id -> carriers created. Projects needing nothing are absent. */
	createdByProject: Record<string, number>;
	created: number;
	/**
	 * project id -> instances held back because the migration could not bind them to a command.
	 * A carrier id is a function of that command, so these cannot get one until the binding is
	 * resolved. Counted here, and logged, so holding them back can never read as "already done".
	 */
	unresolvedByProject: Record<string, number>;
	unresolved: number;
}

/**
 * Every task instance with no live carrier row.
 *
 * Scoped by `active_task_id` rather than by a global count: a store part-way
 * through a previous run has some carriers and not others, and this has to
 * complete such a run rather than start it over or skip it.
 */
function readCarrierlessTasks(store: MemoryStoreInternals): CarrierlessTaskRow[] {
	return store.sqlite
		.prepare(
			`SELECT
				i.project_id AS projectId,
				i.active_task_id AS activeTaskId,
				i.opening_command_id AS openingCommandId,
				i.created_at_ms AS createdAtMs,
				i.status AS status,
				i.terminal_at_ms AS terminalAtMs,
				i.identity_state AS identityState,
				(SELECT r0.description
					FROM nodix_active_task_revisions r0
					WHERE r0.project_id = i.project_id AND r0.active_task_id = i.active_task_id
					ORDER BY r0.created_at_ms, r0.active_task_revision_id
					LIMIT 1) AS openingDescription,
				-- is_current DESC first, then newest: a terminal transition clears
				-- is_current on every revision of the task, so a completed or removed
				-- task has no current revision and would otherwise read as incomplete
				-- and abort the whole run.
				(SELECT r1.description
					FROM nodix_active_task_revisions r1
					WHERE r1.project_id = i.project_id AND r1.active_task_id = i.active_task_id
					ORDER BY r1.is_current DESC, r1.created_at_ms DESC, r1.active_task_revision_id DESC
					LIMIT 1) AS currentDescription
			FROM nodix_active_task_instances i
			WHERE NOT EXISTS (
				SELECT 1 FROM nodix_memories m
				WHERE m.project_id = i.project_id
					AND m.lane = 'active'
					AND m.category = 'profile'
					AND json_valid(m.metadata)
					AND json_extract(m.metadata, '$.active_task_kind') = 'task'
					AND json_extract(m.metadata, '$.active_task_id') = i.active_task_id
					AND json_extract(m.metadata, '$.invalidated_at') IS NULL
			)
			ORDER BY i.project_id, i.created_at_ms, i.active_task_id`,
		)
		.all() as CarrierlessTaskRow[];
}

function assertComplete(rows: readonly CarrierlessTaskRow[]): void {
	const incomplete = rows.filter(
		(row) =>
			!row.openingCommandId ||
			typeof row.createdAtMs !== "number" ||
			!Number.isFinite(row.createdAtMs) ||
			(row.status !== "active" && row.status !== "completed" && row.status !== "removed") ||
			typeof row.openingDescription !== "string" ||
			row.openingDescription.trim().length === 0 ||
			typeof row.currentDescription !== "string" ||
			row.currentDescription.trim().length === 0,
	);
	if (incomplete.length === 0) return;
	// Abort rather than skip. A skipped task looks identical to a task that was
	// never there, and the report below would then read as "already done".
	throw new StorageError(
		`active-task carrier backfill aborted: ${incomplete.length} instance(s) lack the fields a carrier requires; ids: ${incomplete
			.slice(0, 5)
			.map((row) => `${row.projectId}/${row.activeTaskId}`)
			.join(", ")}`,
	);
}

/**
 * Give every task instance a durable carrier row.
 *
 * Stores written between the hard cut that removed the legacy task-mutation
 * route and the restored writer hold projections and no carriers, so their task
 * text is reachable only up to the projection's per-item bound. The live writer
 * only fixes tasks touched after it shipped; this fixes the ones already there.
 *
 * Additive, and idempotent through the row id: the id is a pure function of
 * `(projectId, activeTaskId, openingCommandId)`, so a second run rebuilds the
 * same ids for rows that now exist and inserts nothing. Nothing is deleted,
 * re-keyed, or rewritten — not a projection, not a revision, not an instance.
 */
export async function backfillActiveTaskCarriers(
	target: MemoryStore,
): Promise<ActiveTaskCarrierBackfillReport> {
	// Same widening the other storage modules use to reach the internal handle;
	// the prototype methods below are mounted on MemoryStore but not on its
	// public type.
	const store = target as unknown as MemoryStoreInternals;
	const all = readCarrierlessTasks(store);
	// A migrated instance the legacy census could not bind to a command has no opening command
	// by design, and the carrier id is a function of that command. It is a known state, not a
	// damaged row, so it is held back and counted rather than failing every other project's
	// backfill with it.
	const unresolvedByProject: Record<string, number> = {};
	const pending: CarrierlessTaskRow[] = [];
	for (const row of all) {
		if (row.identityState === "unresolved" && !row.openingCommandId) {
			unresolvedByProject[row.projectId] = (unresolvedByProject[row.projectId] ?? 0) + 1;
			continue;
		}
		pending.push(row);
	}
	const unresolved = Object.values(unresolvedByProject).reduce((sum, count) => sum + count, 0);
	// Return early only when there was nothing at all. A run that held EVERY carrierless
	// instance back has nothing to create either, and returning here would leave no trace of it:
	// the boot entry point below is detached, so nobody reads this report and the log at the end
	// is the only thing anyone sees.
	if (pending.length === 0 && unresolved === 0) {
		return { createdByProject: {}, created: 0, unresolvedByProject, unresolved };
	}
	assertComplete(pending);

	const prepared = await Promise.all(
		pending.map(async (row) => {
			const status = row.status as "active" | "completed" | "removed";
			const createdAtMs = row.createdAtMs as number;
			const carrier = buildActiveTaskCarrierRow(
				{
					projectId: row.projectId,
					activeTaskId: row.activeTaskId,
					commandId: row.openingCommandId as string,
					openingCommandId: row.openingCommandId as string,
					description: row.currentDescription as string,
					openingDescription: row.openingDescription as string,
					createdAtMs,
					status,
					transitionedAtMs:
						status === "active" ? createdAtMs : (row.terminalAtMs ?? createdAtMs),
					timestampMs: createdAtMs,
				},
				"active-task-carrier-backfill",
				await recordTokenCounter(store.embedder),
			);
			return {
				projectId: row.projectId,
				timestampMs: createdAtMs,
				carrier,
				chunkRows: await store.prepareChunkInserts(carrier.id, carrier.text),
			};
		}),
	);

	const createdByProject: Record<string, number> = {};
	await store.writeMutex.runExclusive(() => {
		store.sqlite
			.transaction(() => {
				const insert = store.sqlite.prepare(
					`INSERT OR IGNORE INTO nodix_memories(
						id, text, category, project_id, importance, timestamp, timezone, metadata,
						content_hash, fact_id, maturity, source, extractor_version
					) VALUES (?, ?, 'profile', ?, 0.7, ?, ?, ?, ?, ?,
						'extracted', 'edge', 'active-task-carrier-backfill')`,
				);
				for (const item of prepared) {
					// Re-checked inside the transaction rather than trusting the read
					// that produced `pending`: another writer may have created this
					// carrier since. `INSERT OR IGNORE` keeps that race harmless; this
					// check keeps the count honest about what this run actually did.
					if (store.memoryExists(item.carrier.id)) continue;
					insert.run(
						item.carrier.id,
						item.carrier.text,
						item.projectId,
						item.timestampMs,
						hostTimezone(),
						item.carrier.metadata,
						item.carrier.contentHash,
						item.carrier.id,
					);
					store.writeChunkRowsSync(item.chunkRows, item.projectId);
					createdByProject[item.projectId] = (createdByProject[item.projectId] ?? 0) + 1;
				}
			})
			.immediate();
	});

	const created = Object.values(createdByProject).reduce((sum, count) => sum + count, 0);
	// Warn level, and per project: a run that backfilled nothing has to be
	// visible rather than indistinguishable from a run that never happened.
	log.warn("active-task carrier backfill complete", {
		pending: pending.length,
		created,
		unresolved,
		created_by_scope: Object.entries(createdByProject).map(([scope, count]) => ({
			scope_reference: privateLogReference(scope), created_count: count,
		})),
	}, {
		event_name: "sno_station_mem.active-task-carrier-backfill.active.task.carrier.backfill.complete",
		file: "packages/sno-station-mem/src/store/active-task-carrier-backfill.ts",
		function: "backfillActiveTaskCarriers",
		site_id: "active-task-carrier-backfill.backfillActiveTaskCarriers.facdae917f",
	});
	return { createdByProject, created, unresolvedByProject, unresolved };
}

/**
 * Boot entry point. Detached like the section re-key beside it: a store that
 * comes up before the backfill finishes still serves the projection, and losing
 * a race with the live writer is safe because the carrier id is a function of
 * the task and the insert ignores a row that already exists.
 */
export function scheduleActiveTaskCarrierBackfill(target: MemoryStore): void {
	void backfillActiveTaskCarriers(target).catch((error: unknown) => {
		log.error("detached active-task carrier backfill failed", {
			error,
		}, {
			event_name: "sno_station_mem.active-task-carrier-backfill.detached.active.task.carrier.backfill.failed",
			file: "packages/sno-station-mem/src/store/active-task-carrier-backfill.ts",
			function: "<anonymous callback>",
			site_id: "active-task-carrier-backfill.<anonymous callback>.0bf95b1f61",
		});
	});
}
