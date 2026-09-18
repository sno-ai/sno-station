/** @file memory-store-lookup-api.ts
 * @purpose Reads memories by content hash or identifier.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import type { MemoryCategory, MemoryEntry, MemoryRow } from "./memory-store-shared";

Object.assign(MemoryStore.prototype, {
	readExistingByHash(
		this: MemoryStoreInternals,
		projectId: string,
		hash: string,
		category: MemoryCategory,
	): MemoryRow | undefined {
		// PRD §4.2 — dedup is keyed on (projectId, content_hash, category) so the same
		// text under different categories (e.g. decision vs lesson, user-model vs
		// agent-model) coexists as distinct rows. content_hash itself stays
		// text-only to preserve `findByContentHash` semantics.
		const row = this.sqlite
			.prepare(
				"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE project_id = ? AND content_hash = ? AND category = ? LIMIT 1",
			)
			.get(projectId, hash, category) as MemoryRow | undefined;
		return row;
	},

	findByContentHash(
		this: MemoryStoreInternals,
		hash: string,
		projectId?: string,
	): MemoryEntry | undefined {
		let sql =
			"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE content_hash = ?";
		const params: string[] = [hash];
		// Keep identity and boundary checks ahead of any privileged operation.
		if (projectId) {
			// This persistence step establishes state that later reads and cleanup paths depend on.
			sql += " AND project_id = ?";
			// Append only after validation has accepted this value for the current branch.
			params.push(projectId);
		}
		sql += " LIMIT 1";
		// Prepare SQL separately from bound values to keep query shape auditable.
		const row = this.sqlite.prepare(sql).get(...params) as MemoryRow | undefined;
		// Handle the absent-value case explicitly before the happy path depends on it.
		if (!row) return undefined;
		return this.toEntry(row);
	},

	findByExtractionIdempotencyKey(
		this: MemoryStoreInternals,
		projectId: string,
		key: string,
	): MemoryEntry | undefined {
		// Active rows only. Every caller reads a hit as "this candidate is already
		// persisted, skip the write". A non-active row is a preserved failure, not a
		// completed write, so answering with one makes the retry skip the write that
		// could finally succeed — the quarantine becomes permanent for exactly the
		// case it exists to survive, which is worse than the drop it replaced.
		const row = this.sqlite
			.prepare(
				"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE lane = 'active' AND project_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.idempotency_key') = ? LIMIT 1",
			)
			.get(projectId, key) as MemoryRow | undefined;
		if (!row) return undefined;
		return this.toEntry(row);
	},

	getById(this: MemoryStoreInternals, id: string): MemoryEntry | undefined {
		// Compute the normalized row once so later persistence checks use one value.
		const row = this.sqlite
			.prepare(
				"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE id = ? LIMIT 1",
			)
			.get(id) as MemoryRow | undefined;
		// Handle the absent-value case explicitly before the happy path depends on it.
		if (!row) return undefined;
		return this.toEntry(row);
	},

	getByFactKey(
		this: MemoryStoreInternals,
		projectId: string,
		factKey: string,
	): MemoryEntry | undefined {
		const rows = this.sqlite
			.prepare(
				"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE lane = 'active' AND project_id = ? AND json_valid(metadata) AND json_extract(metadata, '$.fact_key') = ? AND json_extract(metadata, '$.invalidated_at') IS NULL ORDER BY timestamp DESC, id DESC",
			)
			.all(projectId, factKey) as MemoryRow[];
		const row = rows.find((candidate) => this.isMemoryOnFactSurface(candidate.id));
		if (!row) return undefined;
		return this.toEntry(row);
	},

	getAtomicBySubjectAttribute(
		this: MemoryStoreInternals,
		projectId: string,
		subject: string,
		attribute: string,
	): MemoryEntry | undefined {
		const rows = this.sqlite
			.prepare(
				"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE lane = 'active' AND project_id = ? AND subject = ? AND attribute = ? ORDER BY timestamp DESC, id DESC",
			)
			.all(projectId, subject, attribute) as MemoryRow[];
		const row = rows.find((candidate) => this.isMemoryOnFactSurface(candidate.id));
		return row ? this.toEntry(row) : undefined;
	},
});
