import type { RemDatabaseLike } from "./types.js";

export interface JournalEntry {
	stage: string;
	outcome: "done" | "failed" | "disabled" | "pending" | "refused" | "no-action"
		| "replaced" | "merged" | "corrected" | "removed" | "fine" | "undecided";
	pairsScanned: number;
	verdicts: number;
	actionsApplied: number;
	reason?: string;
	/** Structured decision detail, including the project or shared scope. */
	detail?: string;
	rowId?: string;
	pairId?: string;
}

export interface RemRepository {
	appendJournal(jobId: string, jobType: string, entry: JournalEntry): void;
	listJournal(jobId: string, jobType?: string): JournalEntry[];
}

export function createRemRepository(database: RemDatabaseLike): RemRepository {
	return {
		appendJournal: (jobId, jobType, entry) => appendJournal(database, jobId, jobType, entry),
		listJournal: (jobId, jobType) => listJournal(database, jobId, jobType),
	};
}

function appendJournal(
	database: RemDatabaseLike,
	jobId: string,
	jobType: string,
	entry: JournalEntry,
): void {
	database
		.prepare(
			`INSERT INTO nodix_rem_journal(
				job_id, job_type, stage, outcome, pairs_scanned, verdicts, actions_applied, reason,
				detail, row_id, pair_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			jobId,
			jobType,
			entry.stage,
			entry.outcome,
			entry.pairsScanned,
			entry.verdicts,
			entry.actionsApplied,
			entry.reason ?? null,
			entry.detail ?? null,
			entry.rowId ?? null,
			entry.pairId ?? null,
		);
}

function listJournal(
	database: RemDatabaseLike,
	jobId: string,
	jobType?: string,
): JournalEntry[] {
	const operationFilter = jobType === undefined ? "" : " AND job_type = ?";
	const parameters = jobType === undefined ? [jobId] : [jobId, jobType];
	const rows = database
		.prepare(
			`SELECT stage, outcome, pairs_scanned, verdicts, actions_applied, reason, detail,
				row_id, pair_id
			FROM nodix_rem_journal WHERE job_id = ?${operationFilter} ORDER BY sequence`,
		)
		.all(...parameters) as Array<{
		stage: string;
		outcome: JournalEntry["outcome"];
		pairs_scanned: number;
		verdicts: number;
		actions_applied: number;
		reason: string | null;
		detail: string | null;
		row_id: string | null;
		pair_id: string | null;
	}>;
	return rows.map((row) => ({
		stage: row.stage,
		outcome: row.outcome,
		pairsScanned: row.pairs_scanned,
		verdicts: row.verdicts,
		actionsApplied: row.actions_applied,
		...(row.reason === null ? {} : { reason: row.reason }),
		...(row.detail === null ? {} : { detail: row.detail }),
		...(row.row_id === null ? {} : { rowId: row.row_id }),
		...(row.pair_id === null ? {} : { pairId: row.pair_id }),
	}));
}
