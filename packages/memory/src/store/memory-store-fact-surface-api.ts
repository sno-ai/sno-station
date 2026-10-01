/** @file memory-store-fact-surface-api.ts
 * @purpose Applies the one active-lane fact-surface rule and project-scoped suppressions.
 * @boundary Read admission only; full-text parked-card discovery does not call this API.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import { hashMemorySuppressionContent } from "./memory-store-suppression-api";

export const ATOMIC_FACT_SURFACE_LANE = "active";

interface FactSurfaceRow {
	projectId: string;
	text: string;
	lane: string;
	subject: string | null;
	attribute: string | null;
}

Object.assign(MemoryStore.prototype, {
	isMemoryOnFactSurface(this: MemoryStoreInternals, id: string): boolean {
		const row = this.sqlite
			.prepare(
				"SELECT project_id AS projectId, text, lane, subject, attribute FROM nodix_memories WHERE id = ? LIMIT 1",
			)
			.get(id) as FactSurfaceRow | undefined;
		if (!row || row.lane !== ATOMIC_FACT_SURFACE_LANE) return false;
		if (row.subject && row.attribute) {
			const keySuppressed = this.sqlite
				.prepare(
					"SELECT 1 FROM nodix_memory_suppressions WHERE project_id = ? AND subject = ? AND attribute = ? LIMIT 1",
				)
				.get(row.projectId, row.subject, row.attribute);
			if (keySuppressed) return false;
		}
		const contentSuppressed = this.sqlite
			.prepare(
				"SELECT 1 FROM nodix_memory_suppressions WHERE project_id = ? AND content_hash = ? LIMIT 1",
			)
			.get(row.projectId, hashMemorySuppressionContent(row.text));
		return contentSuppressed === undefined;
	},
});
