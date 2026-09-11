/** @file memory-store-search-api.ts
 * @purpose Aggregates chunk matches into memory-level search results.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import {
	aggregateChunksToMemories,
	type ChunkCandidate,
	clamp01,
	clampInt,
	JSON_ID_BATCH_SIZE,
	expandSnippetWindow,
	extractMetadataHeader,
	log,
	MAX_AGGREGATION_ROWS,
	MAX_CHUNK_FETCH_LIMIT,
	MAX_LIST_LIMIT,
	sanitizeFtsConjunctiveQuery,
	StorageError,
	type MemoryRow,
	type MemorySearchResult,
	type SearchOptions,
	SNIPPET_NEIGHBOR_AFTER,
	SNIPPET_NEIGHBOR_BEFORE,
} from "./memory-store-shared";

type AggregationRow = MemoryRow & { scopeRowCount: number };

function isAggregationRowArray(value: unknown): value is AggregationRow[] {
	return Array.isArray(value);
}

Object.assign(MemoryStore.prototype, {
	hasIncompleteTaskCarrierPopulation(
		this: MemoryStoreInternals,
		opts: SearchOptions,
	): boolean {
		if (!opts.taskCarrierPopulation) return false;
		let sql = "SELECT 1 FROM nodix_active_task_instances i WHERE 1 = 1";
		const params: string[] = [];
		if (opts.projectIdFilter && opts.projectIdFilter.length > 0) {
			sql += ` AND i.project_id IN (${opts.projectIdFilter.map(() => "?").join(",")})`;
			params.push(...opts.projectIdFilter);
		}
		if (opts.taskCarrierPopulation === "active") sql += " AND i.status = 'active'";
		else if (opts.taskCarrierPopulation === "terminal") {
			sql += " AND i.status IN ('completed', 'removed')";
		}
		sql += ` AND NOT EXISTS (
			SELECT 1 FROM nodix_memories m
			WHERE m.project_id = i.project_id
				AND m.lane = 'active'
				AND m.category = 'profile'
				AND json_valid(m.metadata)
				AND json_extract(m.metadata, '$.active_task_kind') = 'task'
				AND json_extract(m.metadata, '$.active_task_id') = i.active_task_id
				AND json_extract(m.metadata, '$.invalidated_at') IS NULL`;
		if (opts.taskCarrierPopulation === "active") {
			sql += " AND json_extract(m.metadata, '$.active_task_status') = 'active'";
		} else if (opts.taskCarrierPopulation === "terminal") {
			sql += " AND json_extract(m.metadata, '$.active_task_status') IN ('completed', 'removed')";
		}
		sql += ") LIMIT 1";
		return this.sqlite.prepare(sql).get(...params) !== undefined;
	},

	async searchAggregationEvidence(
		this: MemoryStoreInternals,
		opts: SearchOptions = {},
	): Promise<MemorySearchResult[]> {
		if (opts.projectIdFilter !== undefined && opts.projectIdFilter.length === 0) return [];
		if (opts.aggregation && !this.hasFtsSupport) {
			throw new StorageError("Structured aggregation requires FTS support");
		}
		const aggregationQuery = opts.aggregation
			? sanitizeFtsConjunctiveQuery(opts.aggregation.terms)
			: undefined;
		if (opts.aggregation && !aggregationQuery) {
			throw new StorageError("Structured aggregation requires searchable terms");
		}
		const reducesToOne =
			opts.aggregation?.operation === "count" ||
			opts.aggregation?.operation === "first" ||
			opts.aggregation?.operation === "last";
		const pageLimit = reducesToOne
			? 1
			: clampInt(opts.limit ?? MAX_AGGREGATION_ROWS, 1, MAX_AGGREGATION_ROWS);
		const taskCarrierPopulationIncomplete = this.hasIncompleteTaskCarrierPopulation(opts);
		let sql =
			"WITH filtered AS (SELECT m.id, m.text, m.category, m.project_id AS projectId, m.importance, m.timestamp, m.timezone, m.metadata, m.content_hash, m.fact_id, m.lane, m.raw_candidate_json, m.disposition_reason, m.dispositioned_at_ms FROM nodix_memories m WHERE m.lane = 'active'";
		const params: Array<string | number> = [];
		if (opts.projectIdFilter && opts.projectIdFilter.length > 0) {
			sql += ` AND m.project_id IN (${opts.projectIdFilter.map(() => "?").join(",")})`;
			params.push(...opts.projectIdFilter);
		}
		if (opts.category) {
			sql += " AND m.category = ?";
			params.push(opts.category);
		}
		if (opts.includeRefused === false) {
			sql += " AND m.disposition_reason IS NULL";
		}
		if (opts.taskCarrierPopulation) {
			sql +=
				" AND json_valid(m.metadata) AND json_extract(m.metadata, '$.active_task_kind') = 'task'";
			if (opts.taskCarrierPopulation === "active") {
				sql += " AND json_extract(m.metadata, '$.active_task_status') = 'active'";
			} else if (opts.taskCarrierPopulation === "terminal") {
				sql +=
					" AND json_extract(m.metadata, '$.active_task_status') IN ('completed', 'removed')";
			}
		}
		if (opts.excludeInvalidatedBefore !== undefined) {
			sql += " AND (NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.invalidated_at') IS NULL OR json_extract(m.metadata, '$.invalidated_at') > ?)";
			params.push(opts.excludeInvalidatedBefore);
		}
		// A closed row is not part of the population. This has to sit in the CTE the count, the
		// ordering and the `LIMIT 1` all read: removing closed rows afterwards leaves the reported
		// `scopeRowCount` counting them, and lets a `count`/`first`/`last` that happened to select a
		// closed row report an empty result over a population that is not empty. `include-history` is
		// the caller asking for every generation of a row's text, so it keeps them.
		if (opts.facetPolicy !== "include-history") {
			sql +=
				" AND (NOT json_valid(m.metadata) OR json_extract(m.metadata, '$.superseded_by') IS NULL)";
		}
		let chunkFacetFilter =
			" AND (c.facet = 'current' OR NOT EXISTS (SELECT 1 FROM nodix_memory_chunks current_chunk WHERE current_chunk.memory_id = c.memory_id AND current_chunk.facet = 'current'))";
		if (opts.facetPolicy === "include-history") chunkFacetFilter = "";
		else if (opts.facetPolicy === "current-only") chunkFacetFilter = " AND c.facet = 'current'";
		if (aggregationQuery) {
			sql += ` AND EXISTS (SELECT 1 FROM nodix_memory_chunks_fts JOIN nodix_memory_chunks c ON c.rowid = nodix_memory_chunks_fts.rowid WHERE c.memory_id = m.id AND nodix_memory_chunks_fts MATCH ?${chunkFacetFilter}))`;
			params.push(aggregationQuery);
		} else {
			sql += ` AND EXISTS (SELECT 1 FROM nodix_memory_chunks c WHERE c.memory_id = m.id${chunkFacetFilter}))`;
		}
		const selectionOrder = opts.aggregation?.operation === "first"
			? "timestamp ASC, id ASC"
			: "timestamp DESC, id DESC";
		const readPage = (): AggregationRow[] => {
			let pageSql = `${sql}, limited AS (SELECT * FROM filtered`;
			const pageParams = [...params];
			pageSql += ` ORDER BY ${selectionOrder} LIMIT ?)`;
			pageParams.push(pageLimit);
			pageSql += ", population AS (SELECT COUNT(*) AS scopeRowCount FROM filtered)";
			pageSql += " SELECT limited.*, population.scopeRowCount FROM limited CROSS JOIN population";
			pageSql += ` ORDER BY limited.${selectionOrder}`;
			return this.sqlite.prepare(pageSql).all(...pageParams) as AggregationRow[];
		};
		const transactionResult = this.sqlite.transaction((): AggregationRow[] => readPage())();
		if (!isAggregationRowArray(transactionResult)) {
			throw new StorageError("Aggregation transaction returned an invalid row collection");
		}
		const rows = transactionResult;
		rows.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
		const aggregationIncomplete =
			taskCarrierPopulationIncomplete ||
			(!reducesToOne && (rows[0]?.scopeRowCount ?? 0) > rows.length);
		const byEvent = new Map<string, MemorySearchResult>();
		for (const row of rows) {
			const eventIdentity = row.id;
			if (byEvent.has(eventIdentity)) continue;
			byEvent.set(eventIdentity, {
				entry: this.toEntry(row),
				score: 1,
				rank: byEvent.size + 1,
				bestChunkScore: 1,
				eventIdentity,
				scopeRowCount: row.scopeRowCount,
				...(aggregationIncomplete && { aggregationIncomplete: true }),
			});
		}
		const results = [...byEvent.values()];
		const chunksByParent = this.getChunksByParent(
			results.map((result) => result.entry.id),
			opts.facetPolicy,
		);
		for (const result of results) {
			const chunks = chunksByParent.get(result.entry.id);
			if (chunks && chunks.length > 0) {
				const visibleChunks =
					opts.facetPolicy !== "include-history" && chunks.some((chunk) => chunk.facet === "current")
						? chunks.filter((chunk) => chunk.facet === "current")
						: chunks;
				result.snippet = visibleChunks
					.map((chunk) => `[${chunk.facet}] ${chunk.chunkText}`)
					.join("\n");
			}
		}
		return results;
	},

	fetchMemoriesInOrder(
		this: MemoryStoreInternals,
		memoryIds: string[],
		opts: SearchOptions = {},
	): MemoryRow[] {
		if (memoryIds.length === 0) return [];
		const unique = Array.from(new Set(memoryIds));
		const byId = new Map<string, MemoryRow>();
		for (let i = 0; i < unique.length; i += JSON_ID_BATCH_SIZE) {
			const batch = unique.slice(i, i + JSON_ID_BATCH_SIZE);
			const refusalFilter =
				opts.includeRefused === false ? " AND disposition_reason IS NULL" : "";
			const rows = this.sqlite
				.prepare(
					`SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE lane = 'active'${refusalFilter} AND id IN (SELECT value FROM json_each(?))`,
				)
				.all(JSON.stringify(batch)) as MemoryRow[];
			for (const row of rows) byId.set(row.id, row);
		}
		const ordered: MemoryRow[] = [];
		for (const id of memoryIds) {
			const row = byId.get(id);
			if (row) ordered.push(row);
		}
		return ordered;
	},

	async searchSemantic(
		this: MemoryStoreInternals,
		vector: Float32Array,
		opts: SearchOptions = {},
	): Promise<MemorySearchResult[]> {
		const limit = clampInt(opts.limit ?? 5, 1, MAX_LIST_LIMIT);
		// Chunk-fetch budget is independent of MAX_LIST_LIMIT so a single high-recall
		// parent (many matching chunks) cannot collapse aggregate parent diversity.
		// Task-#9 will replace this with MAX_CHUNKS_PER_PARENT SQL window cap.
		const chunkLimit = Math.min(Math.max(limit * 8, 64), MAX_CHUNK_FETCH_LIMIT);
		const chunks = await this.searchChunksSemantic(vector, {
			...opts,
			limit: chunkLimit,
		});
		if (chunks.length === 0) return [];
		const candidates: ChunkCandidate[] = chunks.map((c) => ({
			chunkId: c.chunkId,
			parentMemoryId: c.parentMemoryId,
			chunkIndex: c.chunkIndex,
			rerankedScore: clamp01(c.score, 0),
		}));
		const aggregates = aggregateChunksToMemories(candidates);
		const memoryRows = this.fetchMemoriesInOrder(
			aggregates.map((a) => a.parentMemoryId),
			opts,
		);
		const rowById = new Map(memoryRows.map((r) => [r.id, r]));
		const results: MemorySearchResult[] = [];
		for (const agg of aggregates) {
			const row = rowById.get(agg.parentMemoryId);
			if (!row) continue;
			// `bestChunkScore = 1 / (1 + distance)` → invert for a representative
			// parent distance. Aggregates can exceed 1 once bonuses apply, so
			// `distance` is computed off the (bonus-free) bestChunkScore.
			const bestScore = agg.bestChunkScore;
			const distance = bestScore > 0 ? 1 / bestScore - 1 : 2;
			results.push({
				entry: this.toEntry(row),
				score: agg.memoryScore,
				distance,
				rank: results.length + 1,
				chunkId: agg.bestChunkId,
				chunkIndex: agg.bestChunkIndex,
				bestChunkScore: agg.bestChunkScore,
			});
			if (results.length >= limit) break;
		}
		this.attachSnippets(results, opts.facetPolicy);
		log.debug("semantic search (memory-level wrapper)", {
			limit,
			chunkLimit,
			projectIdFilter: opts.projectIdFilter,
			chunkCount: chunks.length,
			memoryCount: results.length,
		}, {
			event_name: "sno_station_mem.memory-store-search-api.semantic.search.memory.level.wrapper",
			file: "packages/sno-station-mem/src/store/memory-store-search-api.ts",
			function: "searchSemantic",
			site_id: "memory-store-search-api.searchSemantic.a8cee42447",
		});
		return results;
	},

	async searchKeyword(
		this: MemoryStoreInternals,
		query: string,
		opts: SearchOptions = {},
	): Promise<MemorySearchResult[]> {
		const limit = clampInt(opts.limit ?? 5, 1, MAX_LIST_LIMIT);
		const chunkLimit = Math.min(Math.max(limit * 8, 64), MAX_CHUNK_FETCH_LIMIT);
		const chunks = await this.searchChunksKeyword(query, {
			...opts,
			limit: chunkLimit,
		});
		if (chunks.length === 0) return [];
		const candidates: ChunkCandidate[] = chunks.map((c) => ({
			chunkId: c.chunkId,
			parentMemoryId: c.parentMemoryId,
			chunkIndex: c.chunkIndex,
			rerankedScore: clamp01(c.score, 0),
		}));
		const aggregates = aggregateChunksToMemories(candidates);
		const memoryRows = this.fetchMemoriesInOrder(
			aggregates.map((a) => a.parentMemoryId),
			opts,
		);
		const rowById = new Map(memoryRows.map((r) => [r.id, r]));
		const results: MemorySearchResult[] = [];
		for (const agg of aggregates) {
			const row = rowById.get(agg.parentMemoryId);
			if (!row) continue;
			results.push({
				entry: this.toEntry(row),
				score: agg.memoryScore,
				rank: results.length + 1,
				chunkId: agg.bestChunkId,
				chunkIndex: agg.bestChunkIndex,
				bestChunkScore: agg.bestChunkScore,
			});
			if (results.length >= limit) break;
		}
		this.attachSnippets(results, opts.facetPolicy);
		log.debug("keyword search (memory-level wrapper)", {
			limit,
			chunkLimit,
			projectIdFilter: opts.projectIdFilter,
			chunkCount: chunks.length,
			memoryCount: results.length,
		}, {
			event_name: "sno_station_mem.memory-store-search-api.keyword.search.memory.level.wrapper",
			file: "packages/sno-station-mem/src/store/memory-store-search-api.ts",
			function: "searchKeyword",
			site_id: "memory-store-search-api.searchKeyword.f4293a3f14",
		});
		return results;
	},

	attachSnippets(
		this: MemoryStoreInternals,
		results: MemorySearchResult[],
		facetPolicy?: "current-only" | "include-history",
	): void {
		const memoryIds = results.filter((r) => r.chunkIndex !== undefined).map((r) => r.entry.id);
		if (memoryIds.length === 0) return;
		const chunksByParent = this.getChunksByParent(memoryIds, facetPolicy);
		for (const result of results) {
			if (result.chunkIndex === undefined) continue;
			const allChunks = chunksByParent.get(result.entry.id);
			if (!allChunks || allChunks.length === 0) continue;
			// A row rewritten in place keeps both generations of its own text: the old chunk is
			// demoted to `history` and the new one is `current`, and BOTH sit at the same
			// chunk_index. The window filter below keys on chunkIndex alone, so without this the
			// two texts are joined and the row answers with the value REM just retired glued to
			// its live one. Within one row the current generation wins.
			//
			// This is not a visibility rule over rows. A superseded row still reaches the caller
			// and scoring still ranks it (integration/rem-facet-retrieval.test.ts, 2026-08-19).
			// A row with nothing but history keeps its history — it is a fully retired row, and
			// filtering it here would return it with no text at all, which is the hiding the
			// owner rejected. `include-history` is an explicit opt-in and is served unchanged.
			//
			// Filtering here rather than after the window is deliberate: `totalChunks` sizes the
			// window, so both must describe the same chunk set.
			const chunks =
				facetPolicy !== "include-history" && allChunks.some((c) => c.facet === "current")
					? allChunks.filter((c) => c.facet === "current")
					: allChunks;
			const totalChunks = Math.max(...chunks.map((c) => c.chunkIndex)) + 1;
			let window: { chunkIndices: number[] };
			try {
				window = expandSnippetWindow(result.chunkIndex, totalChunks, {
					neighborBefore: SNIPPET_NEIGHBOR_BEFORE,
					neighborAfter: SNIPPET_NEIGHBOR_AFTER,
				});
			} catch (err) {
				log.warn("snippet expand window failed; falling back to entry text", {
					memory_id: result.entry.id,
					chunkIndex: result.chunkIndex,
					totalChunks,
					error: err,
				}, {
					event_name: "sno_station_mem.memory-store-search-api.snippet.expand.window.failed.falling.back.to.entry.text",
					file: "packages/sno-station-mem/src/store/memory-store-search-api.ts",
					function: "attachSnippets",
					site_id: "memory-store-search-api.attachSnippets.896a3e960a",
				});
				continue;
			}
			const indexSet = new Set(window.chunkIndices);
			const sorted = chunks
				.filter((c) => indexSet.has(c.chunkIndex))
				.sort((a, b) => a.chunkIndex - b.chunkIndex);
			if (sorted.length === 0) continue;
			// A window that mixes facets must say which part is current: without the label a
			// reader cannot tell a live fact from one this row already retired. A window that
			// is entirely current stays unlabelled, so ordinary recall reads as before.
			const mixedFacets = sorted.some((c) => c.facet === "history");
			const parts = sorted.map((c) => (mixedFacets ? `[${c.facet}] ${c.chunkText}` : c.chunkText));
			// PRD §8.1: when the snippet window does not include chunk[0], prepend
			// the parent's metadata header (markdown title + key:value frontmatter
			// such as `session_date_time`) so the LLM can resolve relative
			// references like "this month" / "last week" in non-first chunks.
			if (sorted[0] && sorted[0].chunkIndex > 0) {
				const chunk0 = chunks.find((c) => c.chunkIndex === 0);
				if (chunk0) {
					const header = extractMetadataHeader(chunk0.chunkText);
					if (header) parts.unshift(header);
				}
			}
			result.snippet = parts.join("\n\n");
		}
	},
});
