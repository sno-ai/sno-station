/** @file memory-store-read-api.ts
 * @purpose Reads chunks, memory lists, and aggregate store statistics.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import {
	deriveDefaultLayer,
	normalizeSource,
	normalizeState,
} from "../engine/extraction/memory-metadata-normalizers";
import type { MemoryMetadata } from "../engine/shared/types";
import {
	MemoryStore,
	type MemoryStoreInternals,
	type ProfileRecoveryEntry,
} from "./memory-store-base";
import {
	clampInt,
	DEFAULT_LIST_LIMIT,
	JSON_ID_BATCH_SIZE,
	log,
	type ListOptions,
	MAX_LIST_LIMIT,
	type MemoryEntry,
	type MemoryRow,
	type StatsResult,
} from "./memory-store-shared";

Object.assign(MemoryStore.prototype, {
	readProfileRecoveryEntries(
		this: MemoryStoreInternals,
		rowId: string,
	): ProfileRecoveryEntry[] {
		const row = this.sqlite
			.prepare(
				"SELECT project_id AS projectId, fact_id AS factId FROM nodix_memories WHERE id = ? AND category = 'profile' LIMIT 1",
			)
			.get(rowId) as { projectId: string; factId: string | null } | undefined;
		if (!row) return [];
		return this.sqlite
			.prepare(
				"SELECT mutation_attempt_id AS mutationAttemptId, removed_row_id AS removedRowId, removed_value AS removedValue, section_name AS sectionName, removed_at_ms AS removedAtMs FROM nodix_profile_recovery_entries WHERE project_id = ? AND profile_fact_id = ? ORDER BY removed_at_ms DESC, mutation_attempt_id DESC, removed_row_id DESC",
			)
			.all(row.projectId, row.factId ?? rowId) as ProfileRecoveryEntry[];
	},

	getChunksByParent(
		this: MemoryStoreInternals,
		memoryIds: string[],
		facetPolicy?: "current-only" | "include-history",
	): Map<string, Array<{ chunkIndex: number; chunkText: string; facet: "current" | "history" }>> {
		const out = new Map<string, Array<{ chunkIndex: number; chunkText: string; facet: "current" | "history" }>>();
		if (memoryIds.length === 0) return out;
		const unique = Array.from(new Set(memoryIds));
		for (let i = 0; i < unique.length; i += JSON_ID_BATCH_SIZE) {
			const batch = unique.slice(i, i + JSON_ID_BATCH_SIZE);
			const facetCondition = facetPolicy === "current-only" ? " AND facet = 'current'" : "";
			const rows = this.sqlite
				.prepare(
					`SELECT memory_id, chunk_index, chunk_text, facet FROM nodix_memory_chunks WHERE memory_id IN (SELECT value FROM json_each(?))${facetCondition} ORDER BY memory_id, facet, chunk_index`,
				)
				.all(JSON.stringify(batch)) as Array<{
				memory_id: string;
				chunk_index: number;
				chunk_text: string;
				facet: "current" | "history";
			}>;
			for (const row of rows) {
				let arr = out.get(row.memory_id);
				if (!arr) {
					arr = [];
					out.set(row.memory_id, arr);
				}
				arr.push({ chunkIndex: row.chunk_index, chunkText: row.chunk_text, facet: row.facet });
			}
		}
		return out;
	},

	async list(this: MemoryStoreInternals, opts: ListOptions = {}): Promise<MemoryEntry[]> {
		const limit = clampInt(opts.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
		const offset = clampInt(opts.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
		let sql =
			"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories";
		const params: (string | number)[] = [];
		const conditions: string[] = [];
		conditions.push("lane = ?");
		params.push(opts.lane ?? "active");
		// Empty projectIdFilter means "caller is authorized for ZERO projectIds" — return
		// empty rather than fail open into a global query (host review H1, 2026-04-26).
		// Only short-circuit when no explicit single projectId was provided (single-projectId
		// takes precedence when both are set, matching the existing if/else-if order).
		if (
			opts.projectId === undefined &&
			opts.projectIdFilter !== undefined &&
			opts.projectIdFilter.length === 0
		) {
			return [];
		}
		// Keep identity and boundary checks ahead of any privileged operation.
		if (opts.projectId) {
			// Append only after validation has accepted this value for the current branch.
			conditions.push("project_id = ?");
			// Append only after validation has accepted this value for the current branch.
			params.push(opts.projectId);
		} else if (opts.projectIdFilter && opts.projectIdFilter.length > 0) {
			conditions.push(`project_id IN (${opts.projectIdFilter.map(() => "?").join(",")})`);
			// Append only after validation has accepted this value for the current branch.
			params.push(...opts.projectIdFilter);
		}
		if (opts.category) {
			conditions.push("category = ?");
			params.push(opts.category);
		}
		if (typeof opts.importanceMin === "number") {
			conditions.push("importance >= ?");
			params.push(opts.importanceMin);
		}
		if (conditions.length > 0) {
			sql += ` WHERE ${conditions.join(" AND ")}`;
		}
		sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
		params.push(limit, offset);

		// Prepare SQL separately from bound values to keep query shape auditable.
		const rows = this.sqlite.prepare(sql).all(...params) as MemoryRow[];
		return rows.map((row) => this.toEntry(row));
	},

	async listReflectionItems(
		this: MemoryStoreInternals,
		opts: { projectIdFilter?: string[]; limit?: number; unresolvedOnly?: boolean },
	): Promise<MemoryEntry[]> {
		const limit = clampInt(opts.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
		// Empty projectIdFilter means the caller is authorized for zero projectIds.
		if (opts.projectIdFilter !== undefined && opts.projectIdFilter.length === 0) return [];
		// Type-filter in SQL so reflection rows are never crowded out of a bounded
		// scan by ordinary memories. `json_valid` short-circuits before
		// `json_extract`, so a row with malformed metadata is skipped, not thrown
		// on (json1 is bundled with better-sqlite3). When `unresolvedOnly`, the
		// limit applies to unresolved rows only so resolved rows cannot crowd them
		// out of the bounded scan.
		let sql =
			"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE lane = 'active' AND json_valid(metadata) AND json_extract(metadata, '$.type') = 'memory-reflection-item'";
		const params: (string | number)[] = [];
		if (opts.unresolvedOnly) {
			sql += " AND json_extract(metadata, '$.resolvedAt') IS NULL";
		}
		if (opts.projectIdFilter && opts.projectIdFilter.length > 0) {
			sql += ` AND project_id IN (${opts.projectIdFilter.map(() => "?").join(",")})`;
			params.push(...opts.projectIdFilter);
		}
		sql += " ORDER BY timestamp DESC LIMIT ?";
		params.push(limit);
		const rows = this.sqlite.prepare(sql).all(...params) as MemoryRow[];
		return rows.map((row) => this.toEntry(row));
	},

	async getMemoryMetadata(
		this: MemoryStoreInternals,
		memoryId: string,
	): Promise<MemoryMetadata | undefined> {
		const row = this.sqlite
			.prepare("SELECT category, metadata FROM nodix_memories WHERE id = ? LIMIT 1")
			.get(memoryId) as { category: MemoryEntry["category"]; metadata: string | null } | undefined;
		if (!row) return undefined;
		if (row.metadata === null || row.metadata === "") return {};
		try {
			const parsed = JSON.parse(row.metadata) as unknown;
			if (typeof parsed !== "object" || parsed === null) return undefined;
			const metadata = parsed as MemoryMetadata & Record<string, unknown>;
			if (metadata.memory_layer === undefined) {
				const fallbackSource =
					metadata.type === "session-summary"
						? "session-summary"
						: metadata.type === "memory-reflection" ||
							  metadata.type === "memory-reflection-item" ||
							  metadata.type === "memory-reflection-event" ||
							  metadata.type === "memory-reflection-mapped"
							? "reflection"
							: "legacy";
				const source = normalizeSource(metadata.source ?? fallbackSource);
				const state = normalizeState(
					metadata.state ?? (source === "session-summary" ? "archived" : "confirmed"),
				);
				metadata.memory_layer = deriveDefaultLayer(source, row.category, state);
			}
			return metadata;
		} catch (e) {
			log.warn("malformed metadata JSON", {
				memory_id: memoryId,
				error: e,
			}, {
				event_name: "sno_station_mem.memory-store-read-api.malformed.metadata.json",
				file: "packages/sno-station-mem/src/store/memory-store-read-api.ts",
				function: "getMemoryMetadata",
				site_id: "memory-store-read-api.getMemoryMetadata.35e63c5534",
			});
			return undefined;
		}
	},

	async stats(this: MemoryStoreInternals, projectId?: string): Promise<StatsResult> {
		// Compute the normalized sql once so later persistence checks use one value.
		let sql = "SELECT project_id AS projectId, category, COUNT(*) AS count FROM nodix_memories";
		const params: string[] = [];
		// Keep identity and boundary checks ahead of any privileged operation.
		if (projectId) {
			// This persistence step establishes state that later reads and cleanup paths depend on.
			sql += " WHERE project_id = ?";
			// Append only after validation has accepted this value for the current branch.
			params.push(projectId);
		}
		// This persistence step establishes state that later reads and cleanup paths depend on.
		sql += " GROUP BY project_id, category";
		// Prepare SQL separately from bound values to keep query shape auditable.
		const rows = this.sqlite.prepare(sql).all(...params) as {
			projectId: string;
			category: string;
			count: number;
		}[];

		// Compute the normalized projectId breakdown once so later persistence checks use one value.
		const projectBreakdown: Record<string, number> = {};
		const categoryBreakdown: Record<string, number> = {};
		let total = 0;

		for (const row of rows) {
			// This persistence step establishes state that later reads and cleanup paths depend on.
			projectBreakdown[row.projectId] = (projectBreakdown[row.projectId] ?? 0) + row.count;
			categoryBreakdown[row.category] = (categoryBreakdown[row.category] ?? 0) + row.count;
			total += row.count;
		}

		// Return the normalized storage payload expected by callers.
		return { total, projectBreakdown, categoryBreakdown };
	},
});
