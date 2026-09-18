/** @file memory-store-chunk-search.ts
 * @purpose Runs semantic and keyword search directly over chunk rows.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import {
	type ChunkSearchResult,
	type ChunkSearchRow,
	clamp01,
	clampInt,
	DEFAULT_MIN_SCORE,
	JSON_ID_BATCH_SIZE,
	f32ToBytes,
	log,
	MAX_CHUNK_FETCH_LIMIT,
	type SearchOptions,
	StorageError,
	sanitizeFtsQuery,
} from "./memory-store-shared";

type SemanticVecRow = { id: string; distance: number };
type SemanticMetaRow = Omit<ChunkSearchRow, "distance">;

const SEMANTIC_CANDIDATE_MIN_BUDGET = 64;
const SEMANTIC_CANDIDATE_MAX_BUDGET = 1024;
const SEMANTIC_CANDIDATE_GROWTH_FACTOR = 2;

function readVecRowCount(sqlite: MemoryStoreInternals["sqlite"]): number {
	const row = sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunk_vectors").get() as
		| { count: number }
		| undefined;
	return row?.count ?? 0;
}

/**
 * project_id is a vec0 PARTITION KEY (Phase D): filtering it in the KNN MATCH
 * query itself, rather than post-filtering after a global-corpus scan, lets
 * sqlite-vec skip irrelevant partitions entirely — probe-verified on the
 * installed sqlite-vec 0.1.9 (2026-07-13). No project_id filter falls back to
 * the prior unscoped scan.
 */
function readSemanticVecRows(
	sqlite: MemoryStoreInternals["sqlite"],
	vecBytes: Uint8Array,
	candidateBudget: number,
	projectIdFilter: readonly string[] | undefined,
): SemanticVecRow[] {
	if (projectIdFilter && projectIdFilter.length > 0) {
		return sqlite
			.prepare(
				"SELECT id, distance FROM nodix_memory_chunk_vectors WHERE embedding MATCH vec_f32(?) AND project_id IN (SELECT value FROM json_each(?)) AND k = ?",
			)
			.all(vecBytes, JSON.stringify(projectIdFilter), candidateBudget) as SemanticVecRow[];
	}
	return sqlite
		.prepare("SELECT id, distance FROM nodix_memory_chunk_vectors WHERE embedding MATCH vec_f32(?) AND k = ?")
		.all(vecBytes, candidateBudget) as SemanticVecRow[];
}

function readSemanticMetaRows(
	sqlite: MemoryStoreInternals["sqlite"],
	vecRows: SemanticVecRow[],
	opts: SearchOptions,
): SemanticMetaRow[] {
	const rows: SemanticMetaRow[] = [];
	for (let i = 0; i < vecRows.length; i += JSON_ID_BATCH_SIZE) {
		const batch = vecRows.slice(i, i + JSON_ID_BATCH_SIZE);
		// json_each keeps the SQL string identical across batch sizes and filter
		// cardinalities, so the per-connection statement cache can reuse the plan.
		let sql =
			"SELECT c.chunk_id, c.memory_id, c.chunk_index, c.chunk_text, c.dense_payload, m.project_id AS projectId, m.category FROM nodix_memory_chunks c JOIN nodix_memories m ON m.id = c.memory_id WHERE m.lane = 'active' AND c.chunk_id IN (SELECT value FROM json_each(?))";
		const params: (string | number)[] = [JSON.stringify(batch.map((r) => r.id))];

		const conditions: string[] = [];
		if (opts.projectIdFilter && opts.projectIdFilter.length > 0) {
			conditions.push("m.project_id IN (SELECT value FROM json_each(?))");
			params.push(JSON.stringify(opts.projectIdFilter));
		}
		if (opts.category) {
			conditions.push("m.category = ?");
			params.push(opts.category);
		}
		if (opts.includeRefused === false) {
			conditions.push("m.disposition_reason IS NULL");
		}
		if (opts.facetPolicy === "current-only") {
			conditions.push("c.facet = 'current'");
		}
		if (opts.excludeSuperseded) {
			conditions.push(
				"(NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.superseded_by') IS NULL)",
			);
		}
		if (opts.excludeInvalidatedBefore !== undefined) {
			// json_valid short-circuits before json_extract (same idiom as
			// memory-store-read-api.ts / memory-store-lookup-api.ts), so a legacy
			// row with malformed metadata is treated as not-invalidated instead of
			// throwing and aborting the whole batch.
			conditions.push(
				"(NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.invalidated_at') IS NULL OR json_extract(m.metadata, '$.invalidated_at') > ?)",
			);
			params.push(opts.excludeInvalidatedBefore);
		}
		if (conditions.length > 0) {
			sql += ` AND ${conditions.join(" AND ")}`;
		}

		rows.push(...(sqlite.prepare(sql).all(...params) as SemanticMetaRow[]));
	}
	return rows;
}

function buildChunkSearchResults(
	vecRows: SemanticVecRow[],
	metaRows: SemanticMetaRow[],
	limit: number,
	minScore: number,
): ChunkSearchResult[] {
	const distanceById = new Map<string, number>();
	for (const row of vecRows) {
		distanceById.set(row.id, Number(row.distance));
	}

	const merged: { meta: SemanticMetaRow; distance: number }[] = [];
	for (const meta of metaRows) {
		const distance = distanceById.get(meta.chunk_id) ?? 2;
		merged.push({ meta, distance });
	}
	merged.sort((a, b) => a.distance - b.distance);

	const results: ChunkSearchResult[] = [];
	for (const { meta, distance } of merged) {
		if (results.length >= limit) break;
		const score = 1 / (1 + distance);
		if (score < minScore) continue;
		results.push({
			chunkId: meta.chunk_id,
			parentMemoryId: meta.memory_id,
			chunkIndex: meta.chunk_index,
			chunkText: meta.chunk_text,
			densePayload: meta.dense_payload,
			score,
			distance,
			rank: results.length + 1,
		});
	}
	return results;
}

Object.assign(MemoryStore.prototype, {
	async searchChunksSemantic(
		this: MemoryStoreInternals,
		vector: Float32Array,
		opts: SearchOptions = {},
	): Promise<ChunkSearchResult[]> {
		if (!this.db.vectorSearchAvailable) {
			log.error("storage.vector.search.unavailable", { dbPath: this.dbPath }, {
				event_name: "storage.vector.search.unavailable", file: "packages/sno-station-mem/src/store/memory-store-chunk-search.ts",
				function: "searchChunksSemantic", site_id: "storage.vector.search.unavailable",
			});
			return [];
		}
		this.validateVector(vector);
		const limit = clampInt(opts.limit ?? 5, 1, MAX_CHUNK_FETCH_LIMIT);
		const minScore = clamp01(opts.minScore ?? DEFAULT_MIN_SCORE, DEFAULT_MIN_SCORE);

		// Empty projectIdFilter means "caller is authorized for ZERO projectIds" — return
		// empty rather than fail open into a global query (host review H1, 2026-04-26).
		if (opts.projectIdFilter !== undefined && opts.projectIdFilter.length === 0) {
			return [];
		}
		this.startLegacyChunkBackfill();

		// sqlite-vec's vec0 virtual table has a known interaction bug with
		// SQLCipher + multi-connection setups: the KNN MATCH works correctly
		// as a standalone query but silently returns 0 rows when used inside
		// a JOIN (even via CTE). The workaround is a two-step approach:
		// 1. Run the KNN MATCH as an isolated query to get candidate IDs + distances
		// 2. Fetch chunk/memory metadata with a regular SQL query using those IDs
		// Overfetch for post-KNN metadata filtering, but bound the KNN k so a
		// chunk-scale limit (up to MAX_CHUNK_FETCH_LIMIT) cannot request an
		// 8x-larger candidate set; the growth loop below still widens on demand.
		let candidateBudget = Math.min(
			Math.max(limit * 8, SEMANTIC_CANDIDATE_MIN_BUDGET),
			Math.max(limit, SEMANTIC_CANDIDATE_MAX_BUDGET),
		);
		const shouldRetryAfterFiltering = true;

		try {
			const vecBytes = f32ToBytes(vector);
			let vectorRowCount: number | undefined;
			while (true) {
				const vecRows = readSemanticVecRows(
					this.sqlite,
					vecBytes,
					candidateBudget,
					opts.projectIdFilter,
				);
				if (vecRows.length === 0) return [];
				const metaRows = readSemanticMetaRows(this.sqlite, vecRows, opts);
				const results = buildChunkSearchResults(vecRows, metaRows, limit, minScore);

				if (
					results.length >= limit ||
					!shouldRetryAfterFiltering ||
					vecRows.length < candidateBudget
				) {
					log.debug("chunk semantic search", {
						limit,
						projectIdFilter: opts.projectIdFilter,
						vecCandidates: vecRows.length,
						candidateBudget,
						metaMatches: metaRows.length,
						resultCount: results.length,
					}, {
						event_name: "sno_station_mem.memory-store-chunk-search.chunk.semantic.search",
						file: "packages/sno-station-mem/src/store/memory-store-chunk-search.ts",
						function: "searchChunksSemantic",
						site_id: "memory-store-chunk-search.searchChunksSemantic.7d889feb61",
					});
					return results;
				}

				vectorRowCount ??= readVecRowCount(this.sqlite);
				if (candidateBudget >= vectorRowCount) return results;
				candidateBudget = Math.min(
					candidateBudget * SEMANTIC_CANDIDATE_GROWTH_FACTOR,
					vectorRowCount,
				);
			}
		} catch (error) {
			log.error("chunk semantic search failed", {
				error,
				limit,
				projectIdFilter: opts.projectIdFilter,
				category: opts.category,
			}, {
				event_name: "sno_station_mem.memory-store-chunk-search.chunk.semantic.search.failed",
				file: "packages/sno-station-mem/src/store/memory-store-chunk-search.ts",
				function: "searchChunksSemantic",
				site_id: "memory-store-chunk-search.searchChunksSemantic.fa074292e0",
			});
			throw new StorageError("Semantic search failed", error instanceof Error ? error : undefined);
		}
	},

	async searchChunksKeyword(
		this: MemoryStoreInternals,
		query: string,
		opts: SearchOptions = {},
	): Promise<ChunkSearchResult[]> {
		if (!this.hasFtsSupport) return [];
		const safeQuery = sanitizeFtsQuery(query);
		if (!safeQuery) return [];
		const limit = clampInt(opts.limit ?? 5, 1, MAX_CHUNK_FETCH_LIMIT);

		// Empty projectIdFilter means "caller is authorized for ZERO projectIds" — return
		// empty rather than fail open into a global query (host review H1, 2026-04-26).
		if (opts.projectIdFilter !== undefined && opts.projectIdFilter.length === 0) {
			return [];
		}
		this.startLegacyChunkBackfill();

		let sql =
			"SELECT c.chunk_id, c.memory_id, c.chunk_index, c.chunk_text, c.dense_payload, m.project_id AS projectId, m.category, bm25(nodix_memory_chunks_fts) AS rank FROM nodix_memory_chunks_fts JOIN nodix_memory_chunks c ON c.rowid = nodix_memory_chunks_fts.rowid JOIN nodix_memories m ON m.id = c.memory_id WHERE m.lane = 'active' AND nodix_memory_chunks_fts MATCH ?";
		const params: (string | number)[] = [safeQuery];

		if (opts.projectIdFilter && opts.projectIdFilter.length > 0) {
			sql += ` AND m.project_id IN (${opts.projectIdFilter.map(() => "?").join(",")})`;
			params.push(...opts.projectIdFilter);
		}
		if (opts.excludeMemoryIds && opts.excludeMemoryIds.length > 0) {
			sql += " AND m.id NOT IN (SELECT value FROM json_each(?))";
			params.push(JSON.stringify(opts.excludeMemoryIds));
		}
		if (opts.category) {
			sql += " AND m.category = ?";
			params.push(opts.category);
		}
		if (opts.includeRefused === false) {
			sql += " AND m.disposition_reason IS NULL";
		}
		if (opts.facetPolicy === "current-only") {
			sql += " AND c.facet = 'current'";
		}
		if (opts.excludeSuperseded) {
			sql += " AND (NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.superseded_by') IS NULL)";
		}
		if (opts.excludeInvalidatedBefore !== undefined) {
			// Same json_valid guard as the semantic-search branch above: a legacy
			// row with malformed metadata must not abort the whole keyword query.
			sql +=
				" AND (NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.invalidated_at') IS NULL OR json_extract(m.metadata, '$.invalidated_at') > ?)";
			params.push(opts.excludeInvalidatedBefore);
		}
		sql += " ORDER BY rank ASC LIMIT ?";
		params.push(limit);

		// BM25 scores use a different range than cosine similarity (score = goodness/(1+goodness),
		// see below), so only apply minScore when the caller explicitly provides it.
		const minScore = opts.minScore !== undefined ? clamp01(opts.minScore, 0) : 0;

		try {
			const rows = this.sqlite.prepare(sql).all(...params) as ChunkSearchRow[];
			const results: ChunkSearchResult[] = [];
			rows.forEach((row, index) => {
				const bm25Rank = Number(row.rank ?? 0);
				// SQLite FTS5's bm25() is more-negative-for-better-match (smaller = more
				// relevant, hence `ORDER BY rank ASC` above). Convert to a "higher = better"
				// score bounded to [0, 1): goodness is the non-negative match strength
				// (0 when bm25Rank >= 0, i.e. no real match), mapped through x/(1+x) so it
				// *increases* with match strength. `1/(1+x)` here would invert the ranking
				// (weak matches would score higher than strong ones).
				// A sigmoid ported from an upstream reference's `bm25Search` was tried and
				// reverted the same day (host-reviewer, high confidence, verified against
				// real FTS5 output): common/high-frequency terms routinely produce
				// `bm25Rank == 0` (goodness == 0) in normal queries, not just as a
				// theoretical edge case, and that sigmoid's non-positive-goodness fallback
				// (0.5, ported from upstream's own convention) gave every such
				// non-discriminative match a free 0.5 score — silently promoting noise to
				// mid-confidence evidence in the fusion formula. x/(1+x) has no such fallback
				// branch: goodness == 0 naturally scores 0.
				const goodness = Math.max(0, -bm25Rank);
				// goodness == 0 rows carry zero match evidence; keeping them feeds
				// phantom multi-hit/adjacency bonuses in chunk aggregation.
				if (goodness === 0) return;
				const score = goodness / (1 + goodness);
				if (score < minScore) return;
				results.push({
					chunkId: row.chunk_id,
					parentMemoryId: row.memory_id,
					chunkIndex: row.chunk_index,
					chunkText: row.chunk_text,
					densePayload: row.dense_payload,
					score,
					bm25Rank,
					rank: index + 1,
				});
			});
			log.debug("chunk keyword search", {
				query_length: safeQuery?.length ?? "unavailable",
				limit,
				minScore,
				resultCount: results.length,
			}, {
				event_name: "sno_station_mem.memory-store-chunk-search.chunk.keyword.search",
				file: "packages/sno-station-mem/src/store/memory-store-chunk-search.ts",
				function: "searchChunksKeyword",
				site_id: "memory-store-chunk-search.searchChunksKeyword.26628a27c1",
			});
			return results;
		} catch (error) {
			log.error("chunk keyword search failed", {
				error,
				query_length: safeQuery?.length ?? "unavailable",
				limit,
				projectIdFilter: opts.projectIdFilter,
				category: opts.category,
			}, {
				event_name: "sno_station_mem.memory-store-chunk-search.chunk.keyword.search.failed",
				file: "packages/sno-station-mem/src/store/memory-store-chunk-search.ts",
				function: "searchChunksKeyword",
				site_id: "memory-store-chunk-search.searchChunksKeyword.36ca2cc1d7",
			});
			throw new StorageError("Keyword search failed", error instanceof Error ? error : undefined);
		}
	},
});
