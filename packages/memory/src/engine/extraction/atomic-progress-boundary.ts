import { z } from "zod";
import type { AtomicExtractionTurn } from "./atomic-extraction-reply";

const classificationSchema = z.object({
	decisions: z.array(z.object({
		turn_index: z.number().int().nonnegative(),
		progress_only: z.boolean(),
	})),
});

export function parseProgressTurns(
	value: unknown,
	turns: readonly AtomicExtractionTurn[],
): ReadonlySet<number> | null {
	const expected = new Set(turns.flatMap((turn, index) => turn.role === "user" ? [index] : []));
	const parsed = classificationSchema.safeParse(value);
	if (!parsed.success) return null;
	const indexes = new Set(parsed.data.decisions.map((decision) => decision.turn_index));
	if (indexes.size !== expected.size || parsed.data.decisions.length !== expected.size ||
		[...indexes].some((index) => !expected.has(index))) return null;
	return new Set(parsed.data.decisions.filter((decision) => decision.progress_only)
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
