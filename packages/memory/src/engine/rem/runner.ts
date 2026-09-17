import { createLogger } from "@snoai/utils/logger";
import type { JournalEntry } from "./repository.js";
import type { RemConfig, RemOperationType } from "./types.js";

export interface RemJournalWriter {
	appendJournal(
		jobId: string,
		jobType: RemOperationType,
		entry: JournalEntry,
	): void | Promise<void>;
}

export interface RemStage {
	name: string;
	run(): Promise<Partial<JournalEntry>> | Partial<JournalEntry>;
}

export async function runRemStages(input: {
	repository: RemJournalWriter;
	jobId: string;
	jobType: RemOperationType;
	config: RemConfig;
	stages: readonly RemStage[];
	onStageError?: (event: { stage: string; error: unknown }) => void;
}): Promise<Record<string, "done" | "failed" | "disabled">> {
	const results: Record<string, "done" | "failed" | "disabled"> = {};
	for (const stage of input.stages) {
		let entry: JournalEntry;
		try {
			const observed = await stage.run();
			results[stage.name] = "done";
			entry = { ...journal(stage.name, "done"), ...observed };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			input.onStageError?.({ stage: stage.name, error });
			results[stage.name] = "failed";
			entry = { ...journal(stage.name, "failed"), reason };
		}
		try { await input.repository.appendJournal(input.jobId, input.jobType, entry); }
		catch (error) {
			createLogger("sno-station-mem:rem-runner").error("rem.stage.journal.failed", { error, stage: stage.name }, {
				event_name: "rem.stage.journal.failed", file: "packages/sno-station-mem/src/engine/rem/runner.ts",
				function: "runRemStages", site_id: "rem.stage.journal.failed",
			});
		}
	}
	return results;
}

function journal(stage: string, outcome: JournalEntry["outcome"]): JournalEntry {
	return {
		stage,
		outcome,
		pairsScanned: 0,
		verdicts: 0,
		actionsApplied: 0,
	};
}
