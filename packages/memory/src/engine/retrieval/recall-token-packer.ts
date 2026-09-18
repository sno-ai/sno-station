/** @file recall-token-packer.ts
 * @purpose Packs recall rows into a character-estimated token budget without changing rank order.
 * @boundary Pure row selection and budget accounting; no retrieval or rendering.
 */

import {
	DEFAULT_RECALL_TOKEN_BUDGET,
	MIN_RECALL_TOKEN_BUDGET,
} from "../../../config/index";

export { DEFAULT_RECALL_TOKEN_BUDGET, MIN_RECALL_TOKEN_BUDGET } from "../../../config/index";

export interface PackedRecallRows<T> {
	rows: T[];
	budget_used: number;
	dropped_count: number;
}

export function estimateRecallRowTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

export function packRecallRows<T>(
	rows: readonly T[],
	rowText: (row: T) => string,
	tokenBudget: number = DEFAULT_RECALL_TOKEN_BUDGET,
	groupKey?: (row: T) => string | undefined,
): PackedRecallRows<T> {
	if (!Number.isFinite(tokenBudget) || tokenBudget < MIN_RECALL_TOKEN_BUDGET) {
		throw new RangeError(
			`Recall token budget must be at least ${MIN_RECALL_TOKEN_BUDGET}.`,
		);
	}

	const packed: T[] = [];
	let budgetUsed = 0;
	let droppedCount = 0;
	// Group members arrive newest-first and contiguous. Once a group's newest member does not fit,
	// the whole group is suppressed, so a group is served with its current member or not at all —
	// never as an older sibling alone. A row with no group key is packed independently, as before.
	const droppedGroups = new Set<string>();
	for (const row of rows) {
		const key = groupKey?.(row);
		if (key !== undefined && droppedGroups.has(key)) {
			droppedCount += 1;
			continue;
		}
		const rowTokens = estimateRecallRowTokens(rowText(row).length);
		if (rowTokens > tokenBudget - budgetUsed) {
			droppedCount += 1;
			if (key !== undefined) droppedGroups.add(key);
			continue;
		}
		packed.push(row);
		budgetUsed += rowTokens;
	}

	return { rows: packed, budget_used: budgetUsed, dropped_count: droppedCount };
}
