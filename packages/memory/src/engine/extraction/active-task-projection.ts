/** @file active-task-projection.ts
 * @purpose Builds the canonical bounded active-task projection.
 * @boundary Pure projection selection and rendering only.
 */

import { countTokens } from "@snoai/chunking";
import { getActiveSectionRegistry } from "./b-profile-section-dictionary-provider";
import registryResource from "../../../config/b-profile-section-registry.json" with { type: "json" };

/**
 * The bundled default. Boot restores a cached dictionary over it
 * (`restoreCachedSectionDictionary`), so anything that must match what this
 * module actually emits has to read {@link activeTaskShape} instead — this
 * constant is the shipped fallback, not the live bound.
 */
export const ACTIVE_TASK_PROJECTION_MAX_ITEMS: number =
	registryResource.active_task_shape.projection_max_items;

/**
 * The live task-shape bounds. Read per call, from the same activated registry
 * the section gate, matcher, and re-key already use, so a restored dictionary
 * cannot leave this module rendering to a stale bound while the rest of
 * extraction honours a newer one.
 */
export function activeTaskShape(): { maxItems: number; titleMaxTokens: number } {
	const shape = getActiveSectionRegistry().active_task_shape;
	return { maxItems: shape.projection_max_items, titleMaxTokens: shape.projection_title_max_tokens };
}

/**
 * Longest prefix of `text` costing at most `maxTokens`. Bounding the briefing
 * line by token cost rather than character count keeps the budget honest across
 * scripts: `countTokens` charges CJK roughly 2.5x what it charges Latin, so a
 * character bound would silently buy far more prompt for one script than the
 * other.
 *
 * Binary search is safe because `countTokens` never decreases as the substring
 * is extended, and searching over code points rather than UTF-16 units means a
 * cut can never split a surrogate pair.
 *
 * The result is right-trimmed, and that is load-bearing rather than cosmetic: a
 * prefix ending in whitespace renders a projection line with a trailing space,
 * the metadata codec trims `l2_content`, and the write validator's exact-text
 * check then fails and throws away the entire lifecycle write. Trimming can only
 * lower the token count, so the budget still holds.
 */
export function boundActiveTaskTitle(text: string, maxTokens: number): string {
	if (countTokens(text) <= maxTokens) return text;
	const codePoints = Array.from(text);
	let low = 0;
	let high = codePoints.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (countTokens(codePoints.slice(0, mid).join("")) <= maxTokens) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return codePoints.slice(0, low).join("").trimEnd();
}

export interface ActiveTaskProjectionSource {
	id: string;
	description: string;
	status: "active" | "completed" | "removed";
	createdAt: number;
}

export function buildActiveTaskProjection(
	tasks: readonly ActiveTaskProjectionSource[],
): { taskIds: string[]; titles: string[]; text: string } {
	const { maxItems, titleMaxTokens } = activeTaskShape();
	const selected = tasks
		.filter((task) => task.status === "active")
		.toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
		.slice(0, maxItems);
	const taskIds = selected.map((task) => task.id);
	const titles = selected.map((task) => {
		const normalizedDescription = task.description.replace(/\s+/gu, " ").trim();
		return boundActiveTaskTitle(normalizedDescription, titleMaxTokens);
	});
	return {
		taskIds,
		titles,
		text:
			titles.length === 0
				? "Active tasks: none"
				: `Active tasks:\n${titles.map((title) => `- ${title}`).join("\n")}`,
	};
}
