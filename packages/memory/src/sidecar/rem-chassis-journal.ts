/** @file rem-chassis-journal.ts
 * @purpose Persists reason-bearing REM chassis stage outcomes as append-only JSONL.
 * @boundary Sidecar runner journal only; job-state transitions remain in RemJobStore.
 */

import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type {
	JournalEntry,
	RemOperationType,
	RemJournalWriter,
} from "../engine/rem/index.js";

export class RemChassisJournal implements RemJournalWriter {
	private operationQueue: Promise<void> = Promise.resolve();

	constructor(private readonly journalPath: string) {}

	appendJournal(
		jobId: string,
		jobType: RemOperationType,
		entry: JournalEntry,
	): Promise<void> {
		return this.queueAppend(jobId, jobType, entry);
	}

	appendJournalWithCorrelation(
		jobId: string,
		jobType: RemOperationType,
		correlationId: string,
		entry: JournalEntry,
	): Promise<void> {
		return this.queueAppend(jobId, jobType, entry, correlationId);
	}

	private queueAppend(
		jobId: string,
		jobType: RemOperationType,
		entry: JournalEntry,
		correlationId?: string,
	): Promise<void> {
		const result = this.operationQueue.then(() =>
			this.append(jobId, jobType, entry, correlationId),
		);
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async append(
		jobId: string,
		jobType: RemOperationType,
		entry: JournalEntry,
		correlationId?: string,
	): Promise<void> {
		const parent = path.dirname(this.journalPath);
		await mkdir(parent, { recursive: true });
		const journalAlreadyExisted = existsSync(this.journalPath);
		const handle = await open(this.journalPath, "a");
		try {
			const record = {
				job_id: jobId,
				job_type: jobType,
				...(correlationId === undefined ? {} : { correlation_id: correlationId }),
				stage: entry.stage,
				outcome: entry.outcome,
				pairs_scanned: entry.pairsScanned,
				verdicts: entry.verdicts,
				actions_applied: entry.actionsApplied,
				...(entry.reason === undefined ? {} : { reason: entry.reason }),
				timestamp: new Date().toISOString(),
			};
			await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (!journalAlreadyExisted) await syncDirectory(parent);
	}
}

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
