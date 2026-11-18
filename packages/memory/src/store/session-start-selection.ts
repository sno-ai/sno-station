import type { MemoryStore } from "./store";
import type { MemoryEntry } from "../engine/shared/types";

/** Ranked classified rows, then unclassified manual rows newest first, then remaining eligible classified rows. */
export function selectSessionStartRows(store: MemoryStore, projectId: string): MemoryEntry[] {
	const rows = [...new Set(["global", projectId])].flatMap(project => store.readActivePrecisionRows(project));
	const shared: MemoryEntry[] = [];
	const project: MemoryEntry[] = [];
	const unclassified: MemoryEntry[] = [];
	for (const row of rows) {
		const metadata: Record<string, unknown> = JSON.parse(row.metadata);
		if (metadata.asserted_by !== undefined || metadata.start_label === "drop") continue;
		if (metadata.precision_kind === undefined) {
			if (metadata.source === "manual") unclassified.push(row);
			continue;
		}
		if (metadata.start_label !== undefined && !hasPositiveRank(metadata.start_rank)) continue;
		const kind = String(metadata.precision_kind);
		if (row.projectId === "global" && ["rule", "person"].includes(kind)) shared.push(row);
		else if (row.projectId !== "global" && row.projectId === projectId && ["rule", "pitfall"].includes(kind)) project.push(row);
	}
	const classified = rankedRows([...shared, ...project]);
	const firstUnranked = classified.findIndex(row => !hasPositiveRank(JSON.parse(row.metadata).start_rank));
	const rankedCount = firstUnranked === -1 ? classified.length : firstUnranked;
	return [
		...classified.slice(0, rankedCount),
		...unclassified.sort((a, b) => b.timestamp - a.timestamp),
		...classified.slice(rankedCount),
	];
}

function hasPositiveRank(rank: unknown): rank is number {
	return typeof rank === "number" && rank >= 1;
}

function rankedRows(rows: MemoryEntry[]): MemoryEntry[] {
	const ranked = rows.map(row => ({ row, metadata: JSON.parse(row.metadata) }));
	const rank = (metadata: Record<string, unknown>): number =>
		hasPositiveRank(metadata.start_rank) ? metadata.start_rank : Infinity;
	const label = (metadata: Record<string, unknown>): number => {
		if (metadata.start_label === "core") return 0;
		if (metadata.start_label === "topic") return 1;
		return 2;
	};
	return ranked.sort((a, b) => (rank(a.metadata) - rank(b.metadata) || 0)
		|| (Number.isFinite(rank(a.metadata)) ? 0 : label(a.metadata) - label(b.metadata))
		|| b.row.importance - a.row.importance || b.row.timestamp - a.row.timestamp).map(item => item.row);
}
