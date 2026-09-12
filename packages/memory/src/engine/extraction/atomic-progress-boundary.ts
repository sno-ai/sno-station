import { z } from "zod";
import { createLogger } from "@snoai/utils/logger";
import type { AtomicExtractionTurn } from "./atomic-extraction-reply";

const log = createLogger("sno-station-mem:atomic-progress-boundary");

const classificationSchema = z.object({
	decisions: z.array(z.object({
		turn_index: z.number().int().nonnegative(),
		progress_only: z.boolean(),
	})),
});

export function parseProgressTurns(
	value: unknown,
	turns: readonly AtomicExtractionTurn[],
	{ salvage = false }: { salvage?: boolean } = {},
): ReadonlySet<number> | null {
	const expected = new Set(turns.flatMap((turn, index) => turn.role === "user" ? [index] : []));
	const parsed = classificationSchema.safeParse(value);
	if (!parsed.success) return null;
	const indexes = new Set(parsed.data.decisions.map((decision) => decision.turn_index));
	const invalid = indexes.size !== expected.size || parsed.data.decisions.length !== expected.size ||
		[...indexes].some((index) => !expected.has(index));
	if (invalid && !salvage) return null;
	if (invalid) {
		log.warn("atomic capture salvaged progress decisions", {
			gate: 3,
			ignored_decisions: parsed.data.decisions.filter((decision) => !expected.has(decision.turn_index)).length,
			missing_turns: [...expected].filter((index) => !indexes.has(index)).length,
			duplicate_decisions: parsed.data.decisions.length - indexes.size,
		}, { event_name: "memory.atomic_progress_boundary.diagnostic", file: "packages/sno-station-mem/src/engine/extraction/atomic-progress-boundary.ts", function: "parseProgressTurns", site_id: "extraction.atomic-progress-boundary.salvage_decisions" });
	}
	// A conflicting duplicate must not turn a durable fact into excluded progress.
	const notProgress = new Set(parsed.data.decisions.filter((decision) => !decision.progress_only)
		.map((decision) => decision.turn_index));
	return new Set(parsed.data.decisions.filter((decision) => decision.progress_only &&
		expected.has(decision.turn_index) && !notProgress.has(decision.turn_index))
		.map((decision) => decision.turn_index));
}

export function excludeProgressRecords<T extends {
	sourceSpan?: { turnIndex: number } | null;
	unresolvedSourceSpan?: { turnIndex: number } | null;
}>(records: readonly T[], excluded: ReadonlySet<number>): T[] {
	return records.filter((record) => {
		const index = (record.sourceSpan ?? record.unresolvedSourceSpan)?.turnIndex;
		return index === undefined || !excluded.has(index);
	});
}
