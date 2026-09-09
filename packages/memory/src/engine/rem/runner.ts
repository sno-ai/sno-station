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
		if (input.config.stages[stage.name] !== true) {
			results[stage.name] = "disabled";
			await input.repository.appendJournal(
				input.jobId,
				input.jobType,
				journal(stage.name, "disabled"),
			);
			continue;
		}
		try {
			const observed = await stage.run();
			results[stage.name] = "done";
			await input.repository.appendJournal(input.jobId, input.jobType, {
				...journal(stage.name, "done"),
				...observed,
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			input.onStageError?.({ stage: stage.name, error });
			results[stage.name] = "failed";
			await input.repository.appendJournal(input.jobId, input.jobType, {
				...journal(stage.name, "failed"),
				reason,
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
