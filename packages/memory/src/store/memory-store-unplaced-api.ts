/** @file memory-store-unplaced-api.ts
 * @purpose Persists and reads write attempts the extraction path could not place.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 *   Rows in `nodix_unplaced_memory_candidates` are NOT memories — no retrieval path
 *   reads them, and nothing promotes one into a memory today.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import type {
	MemoryCategory,
	RecordUnplacedCandidateInput,
	RecordUnplacedCandidateResult,
	UnplacedCandidate,
	UnplacedCandidateQuery,
} from "./memory-store-shared";
import { StorageError } from "../engine/shared/errors";

Object.assign(MemoryStore.prototype, {
	recordUnplacedCandidate(
		this: MemoryStoreInternals,
		_input: RecordUnplacedCandidateInput,
	): RecordUnplacedCandidateResult {
		throw new StorageError("recordUnplacedCandidate() is frozen; route sound facts to episodic");
	},

	listUnplacedCandidates(
		this: MemoryStoreInternals,
		query: UnplacedCandidateQuery = {},
	): UnplacedCandidate[] {
		const clauses: string[] = [];
		const params: Array<string | number> = [];
		if (query.projectId !== undefined) {
			clauses.push("project_id = ?");
			params.push(query.projectId);
		}
		if (query.dispositionReason !== undefined) {
			clauses.push("disposition_reason = ?");
			params.push(query.dispositionReason);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		params.push(query.limit ?? 100);
		const rows = this.sqlite
			.prepare(
				`SELECT id, project_id AS projectId, category, text, raw_candidate_json AS rawCandidateJson, disposition_reason AS dispositionReason, dispositioned_at_ms AS dispositionedAtMs, session_key AS sessionKey FROM nodix_unplaced_memory_candidates${where} ORDER BY dispositioned_at_ms DESC, id DESC LIMIT ?`,
			)
			.all(...params) as Array<Omit<UnplacedCandidate, "category"> & { category: string }>;
		return rows.map((row) => ({ ...row, category: row.category as MemoryCategory }));
	},
});
