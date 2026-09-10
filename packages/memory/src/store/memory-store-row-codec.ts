/** @file memory-store-row-codec.ts
 * @purpose Converts rows, metadata, vectors, and chunk persistence payloads.
 * @boundary Prototype-mounted MemoryStore methods; no constructor state ownership.
 */

import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import {
	buildChunkId,
	buildDensePayload,
	CHUNKING_VERSION,
	chunk,
	JSON_ID_BATCH_SIZE,
	f32ToBytes,
	headExtract,
	type MemoryCategory,
	type MemoryEntry,
	type MemoryRow,
	type PreparedChunkRow,
	StorageError,
	shouldDropSummary,
} from "./memory-store-shared";
import { RETRIEVAL_STORAGE_CHUNK_PROFILE } from "../../config/index";

Object.assign(MemoryStore.prototype, {
	toEntry(this: MemoryStoreInternals, row: MemoryRow): MemoryEntry {
		const lane =
			row.lane === "parked" || row.lane === "quarantined" ? row.lane : "active";
		return {
			id: row.id,
			// Every SELECT that feeds this codec must name fact_id. A query that omits it
			// yields undefined here and nothing downstream can tell that apart from a row
			// that genuinely has none — recall telemetry then drops the event silently,
			// which is how the Observe recall stream went empty.
			factId: row.fact_id ?? undefined,
			text: row.text,
			category: row.category as MemoryCategory,
			projectId: row.projectId,
			importance: row.importance,
			timestamp: row.timestamp,
			timezone: row.timezone,
			metadata: row.metadata ?? "{}",
			contentHash: row.content_hash,
			lane,
			...(row.raw_candidate_json ? { rawCandidateJson: row.raw_candidate_json } : {}),
			...(row.disposition_reason ? { dispositionReason: row.disposition_reason } : {}),
			...(row.dispositioned_at_ms === null || row.dispositioned_at_ms === undefined
				? {}
				: { dispositionedAt: row.dispositioned_at_ms }),
		};
	},

	parseMetadataObject(
		this: MemoryStoreInternals,
		metadata: string | null,
	): Record<string, unknown> {
		try {
			const parsed = JSON.parse(metadata ?? "{}") as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Malformed metadata is treated as empty at this persistence boundary.
		}
		return {};
	},

	validateVector(this: MemoryStoreInternals, vector: Float32Array): void {
		// Guard vector.length here so the remaining persistence path works with normalized inputs.
		if (vector.length !== this.vectorDim) {
			// Surface this invalid storage state as an explicit typed failure.
			throw new StorageError(
				`Vector dimension mismatch: expected ${this.vectorDim}, got ${vector.length}`,
			);
		}
		// Iterate deterministically so storage output order remains stable.
		for (const value of vector) {
			// Guard number.is finite here so the remaining persistence path works with normalized inputs.
			if (!Number.isFinite(value)) {
				// Surface this invalid storage state as an explicit typed failure.
				throw new StorageError("Vector contains non-finite values (NaN or Infinity)");
			}
		}
	},

	async prepareChunkInserts(
		this: MemoryStoreInternals,
		memoryId: string,
		text: string,
	): Promise<PreparedChunkRow[]> {
		// Retrieval storage chunks use sno-station-mem's LoCoMo-tuned geometry
		// (256/384/448/32, RETRIEVAL_STORAGE_CHUNK_PROFILE) — small, fact-dense
		// chunks that survive top-20 auto-recall injection. contentType stays prose
		// to preserve boundary behavior.
		const drafts = chunk(
			text,
			{ ...RETRIEVAL_STORAGE_CHUNK_PROFILE, contentType: "prose" },
			memoryId,
		);
		if (drafts.length === 0) return [];
		const firstDraft = drafts[0];
		if (!firstDraft) return [];
		const candidateSummary = headExtract(text, firstDraft.contentType);

		const rows = drafts.map((draft, index) => {
			const summaryForChunk =
				candidateSummary && !shouldDropSummary(candidateSummary, draft.chunkText)
					? candidateSummary
					: undefined;
			const { densePayload, summary } = buildDensePayload({
				chunkText: draft.chunkText,
				summary: summaryForChunk,
			});
			const chunkId = buildChunkId({
				parentMemoryId: memoryId,
				chunkIndex: index,
				startOffset: draft.startOffset,
				endOffset: draft.endOffset,
				chunkText: draft.chunkText,
				chunkingVersion: CHUNKING_VERSION,
			});
			return { chunkId, draft, densePayload, summary };
		});

		const vectors = await this.embedder.embedChunks(rows.map((r) => r.densePayload));
		if (vectors.length !== rows.length) {
			throw new StorageError(
				`embedChunks returned ${vectors.length} vectors for ${rows.length} chunks`,
			);
		}
		for (const v of vectors) this.validateVector(v);

		const now = Date.now();
		return rows.map((row, i) => {
			const vector = vectors[i];
			if (!vector) {
				throw new StorageError(`Missing chunk vector at index ${i} for memory ${memoryId}`);
			}
			return {
				chunkId: row.chunkId,
				memoryId,
				chunkIndex: i,
				draft: row.draft,
				densePayload: row.densePayload,
				summary: row.summary,
				vectorBytes: f32ToBytes(vector),
				createdAt: now,
				updatedAt: now,
			};
		});
	},

	writeChunkRowsSync(this: MemoryStoreInternals, rows: PreparedChunkRow[], projectId: string): void {
		if (rows.length === 0) return;
		const insertChunk = this.sqlite.prepare(
			"INSERT INTO nodix_memory_chunks (chunk_id, memory_id, chunk_index, chunk_text, dense_payload, summary, entities, tags, source, start_offset, end_offset, token_count, content_type, chunking_version, embedder_provider, embedder_model, embedder_dim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		// project_id is a vec0 PARTITION KEY (Phase D): every chunk of one
		// memory shares the same project, so one value covers the whole batch.
		const insertVec = this.sqlite.prepare(
			"INSERT INTO nodix_memory_chunk_vectors(id, project_id, embedding) VALUES (?, ?, vec_f32(?))",
		);
		for (const row of rows) {
			insertChunk.run(
				row.chunkId,
				row.memoryId,
				row.chunkIndex,
				row.draft.chunkText,
				row.densePayload,
				row.summary ?? null,
				null,
				null,
				null,
				row.draft.startOffset,
				row.draft.endOffset,
				row.draft.tokenCount,
				row.draft.contentType,
				CHUNKING_VERSION,
				this.embedder.providerKind,
				this.embedder.model,
				this.embedder.dimensions,
				row.createdAt,
				row.updatedAt,
			);
			insertVec.run(row.chunkId, projectId, row.vectorBytes);
		}
	},

	deleteChunksByMemoryIdsSync(this: MemoryStoreInternals, memoryIds: string[]): void {
		if (memoryIds.length === 0) return;
		for (let i = 0; i < memoryIds.length; i += JSON_ID_BATCH_SIZE) {
			const batch = memoryIds.slice(i, i + JSON_ID_BATCH_SIZE);
			const batchJson = JSON.stringify(batch);
			const chunkIds = (
				this.sqlite
					.prepare(
						"SELECT chunk_id FROM nodix_memory_chunks WHERE memory_id IN (SELECT value FROM json_each(?))",
					)
					.all(batchJson) as { chunk_id: string }[]
			).map((r) => r.chunk_id);
			if (chunkIds.length === 0) continue;
			for (let j = 0; j < chunkIds.length; j += JSON_ID_BATCH_SIZE) {
				const cBatch = chunkIds.slice(j, j + JSON_ID_BATCH_SIZE);
				// json_each pushdown against vec0 is probe-verified (point deletes).
				this.sqlite
					.prepare("DELETE FROM nodix_memory_chunk_vectors WHERE id IN (SELECT value FROM json_each(?))")
					.run(JSON.stringify(cBatch));
			}
			this.sqlite
				.prepare("DELETE FROM nodix_memory_chunks WHERE memory_id IN (SELECT value FROM json_each(?))")
				.run(batchJson);
		}
	},

	readChunklessMemoryRows(this: MemoryStoreInternals, limit: number): MemoryRow[] {
		return this.sqlite
			.prepare(
				"SELECT id, text, category, project_id AS projectId, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories m WHERE lane = 'active' AND length(trim(m.text)) > 0 AND NOT EXISTS (SELECT 1 FROM nodix_memory_chunks c WHERE c.memory_id = m.id) ORDER BY timestamp ASC, id ASC LIMIT ?",
			)
			.all(limit) as MemoryRow[];
	},

	memoryExists(this: MemoryStoreInternals, memoryId: string): boolean {
		const row = this.sqlite
			.prepare("SELECT 1 FROM nodix_memories WHERE id = ? LIMIT 1")
			.get(memoryId);
		return row !== null && row !== undefined;
	},

	memoryHasChunks(this: MemoryStoreInternals, memoryId: string): boolean {
		const row = this.sqlite
			.prepare("SELECT 1 FROM nodix_memory_chunks WHERE memory_id = ? LIMIT 1")
			.get(memoryId);
		return row !== null && row !== undefined;
	},
});
