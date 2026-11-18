import type { MemoryStore } from "./store";
import type { MemoryEntry } from "../engine/shared/types";

/** Unclassified manually saved rows newest first, then active shared rules/person rows and project rules/pitfalls. */
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
		if (metadata.start_label !== undefined && (typeof metadata.start_rank !== "number" || !(metadata.start_rank >= 1))) continue;
		const kind = String(metadata.precision_kind);
		if (row.projectId === "global" && ["rule", "person"].includes(kind)) shared.push(row);
		else if (row.projectId !== "global" && row.projectId === projectId && ["rule", "pitfall"].includes(kind)) project.push(row);
	}
	return [...unclassified.sort((a, b) => b.timestamp - a.timestamp), ...rankedRows([...shared, ...project])];
}

function rankedRows(rows: MemoryEntry[]): MemoryEntry[] {
	const ranked = rows.map(row => ({ row, metadata: JSON.parse(row.metadata) }));
	const rank = (metadata: Record<string, unknown>): number =>
		typeof metadata.start_rank === "number" && metadata.start_rank >= 1 ? metadata.start_rank : Infinity;
	const label = (metadata: Record<string, unknown>): number => {
		if (metadata.start_label === "core") return 0;
		if (metadata.start_label === "topic") return 1;
		return 2;
	};
	return ranked.sort((a, b) => (rank(a.metadata) - rank(b.metadata) || 0)
		|| (Number.isFinite(rank(a.metadata)) ? 0 : label(a.metadata) - label(b.metadata))
		|| b.row.importance - a.row.importance || b.row.timestamp - a.row.timestamp).map(item => item.row);
}
