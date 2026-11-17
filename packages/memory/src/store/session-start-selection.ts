import type { MemoryStore } from "./store";
import type { MemoryEntry } from "../engine/shared/types";

/** Active shared rules/person rows and project rules/pitfalls. */
export function selectSessionStartRows(store: MemoryStore, projectId: string): MemoryEntry[] {
	const rows = [...new Set(["global", projectId])].flatMap(project => store.readActivePrecisionRows(project));
	const shared: MemoryEntry[] = [];
	const project: MemoryEntry[] = [];
	for (const row of rows) {
		const metadata: Record<string, unknown> = JSON.parse(row.metadata);
		const kind = String(metadata.precision_kind);
		if (metadata.asserted_by !== undefined || metadata.start_label === "drop") continue;
		if (metadata.start_label !== undefined && (typeof metadata.start_rank !== "number" || !(metadata.start_rank >= 1))) continue;
		if (row.projectId === "global" && ["rule", "person"].includes(kind)) shared.push(row);
		else if (row.projectId !== "global" && row.projectId === projectId && ["rule", "pitfall"].includes(kind)) project.push(row);
	}
	return rankedRows([...shared, ...project]);
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
