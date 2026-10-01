import { createHash, randomUUID } from "node:crypto";

import { hashRemMemoryRow, REM_ROW_HASH_VERSION } from "./row-hash.js";
import { assertJobIdentity } from "./types.js";
import type { RemDatabaseLike, RemOperationType } from "./types.js";

interface MemoryRow {
	id: string;
	text: string;
	content_hash: string;
	project_id: string;
	[key: string]: unknown;
}

interface MemoryFacetRow {
	facet: "current" | "history";
	text: string;
	updated_at_ms: number;
}

interface ChunkFacetRow {
	chunk_id: string;
	facet: "current" | "history";
	chunk_index: number;
}

export interface RemCurrentFacetChunk {
	chunkId: string;
	chunkIndex: number;
	chunkText: string;
	densePayload: string;
	summary?: string | undefined;
	startOffset: number;
	endOffset: number;
	tokenCount: number;
	contentType: "conversation" | "prose" | "structured";
	chunkingVersion: string;
	embedderProvider: string;
	embedderModel: string;
	embedderDim: number;
	vectorBytes: Uint8Array;
}

export async function writeRemTwoFacetTransaction(input: {
	database: RemDatabaseLike;
	memoryId: string;
	current: string;
	history: string;
	currentChunks: readonly RemCurrentFacetChunk[];
	timestamp?: string;
	metadata?: string;
	contentHash?: string;
	reason?: string;
	jobId: string;
	jobType: RemOperationType;
	/**
	 * The verified-write attempt this transaction belongs to. Supplied by the mutation executor,
	 * never by a caller, exactly as `jobId` and `jobType` are. The post-write content hash is
	 * stamped onto that attempt row INSIDE this transaction so a crash between commit and the
	 * attempt being closed still leaves the two agreeing; recovery then reads the stamp instead of
	 * comparing a text hash against a content hash, which can never match once REM update metadata
	 * is written.
	 */
	attemptId?: string;
}): Promise<{ contentHash: string; recoveryHandle: string }> {
	const timestamp = input.timestamp ?? new Date().toISOString();
	const updatedAtMs = Date.parse(timestamp);
	if (!Number.isFinite(updatedAtMs)) throw new Error("REM facet timestamp must be valid");
	if (input.current.trim().length === 0 || input.history.trim().length === 0) {
		throw new Error("REM facet text must be non-empty");
	}
	if (input.currentChunks.length === 0) {
		throw new Error("REM current facet requires prepared chunks");
	}
	assertJobIdentity(input.jobId, input.jobType);
	return input.database.transaction(() => {
		const row = input.database.prepare("SELECT * FROM nodix_memories WHERE id = ?").get(
			input.memoryId,
		) as MemoryRow | undefined;
		if (row === undefined) throw new Error("REM facet target row is missing");
		const nextHash = input.contentHash ?? createHash("sha256").update(input.current, "utf8").digest("hex");
		const recoveryHandle = randomUUID();
		const priorFacets = input.database
			.prepare(
				"SELECT facet, text, updated_at_ms FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet",
			)
			.all(input.memoryId) as MemoryFacetRow[];
		const priorChunkFacets = input.database
			.prepare(
				"SELECT chunk_id, facet, chunk_index FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY chunk_id",
			)
			.all(input.memoryId) as ChunkFacetRow[];
		if (input.metadata === undefined) {
			input.database
				.prepare("UPDATE nodix_memories SET text = ?, content_hash = ? WHERE id = ?")
				.run(input.current, nextHash, input.memoryId);
		} else {
			input.database
				.prepare("UPDATE nodix_memories SET text = ?, metadata = ?, content_hash = ? WHERE id = ?")
				.run(input.current, input.metadata, nextHash, input.memoryId);
		}
		if (process.env["SNO_STATION_MEM_REM_TEST_FAILPOINT"] === "after_primary_write") {
			throw new Error("SNO_STATION_MEM_REM_TEST_FAILPOINT:after_primary_write");
		}
		const postRow = input.database.prepare("SELECT * FROM nodix_memories WHERE id = ?").get(
			input.memoryId,
		) as MemoryRow | undefined;
		if (postRow === undefined) throw new Error("REM facet target row disappeared after update");
		const expectedPostHash = hashRemMemoryRow(postRow);
		input.database
			.prepare(
				`INSERT INTO nodix_rem_recovery_history(
					recovery_handle, row_id, operation_kind, prior_row_image, prior_content_hash,
					expected_post_hash, row_hash_version, reason, mutation_ts
				) VALUES (?, ?, 'text-version', ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				recoveryHandle,
				input.memoryId,
				JSON.stringify(row),
				row.content_hash,
				expectedPostHash,
				REM_ROW_HASH_VERSION,
				input.reason ?? "REM two-facet update",
				timestamp,
			);
		if (input.attemptId !== undefined) {
			input.database
				.prepare(
					`UPDATE nodix_rem_write_attempts SET expected_post_content_sha256 = ?
					WHERE attempt_id = ? AND outcome = 'pending'`,
				)
				.run(nextHash, input.attemptId);
		}
		const historyIndex = input.database
			.prepare(
				"SELECT COALESCE(MAX(chunk_index), -1) AS value FROM nodix_memory_chunks WHERE memory_id = ? AND facet = 'history'",
			)
			.get(input.memoryId) as { value: number };
		input.database
			.prepare(
				"UPDATE nodix_memory_chunks SET facet = 'history', chunk_index = chunk_index + ? WHERE memory_id = ? AND facet = 'current'",
			)
			.run(historyIndex.value + 1, input.memoryId);
		const insertChunk = input.database.prepare(
			`INSERT INTO nodix_memory_chunks(
				chunk_id, memory_id, chunk_index, chunk_text, dense_payload, summary,
				entities, tags, source, start_offset, end_offset, token_count, content_type,
				chunking_version, embedder_provider, embedder_model, embedder_dim,
				created_at, updated_at, facet
			) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current')`,
		);
		const insertVector = input.database.prepare(
			"INSERT INTO nodix_memory_chunk_vectors(id, project_id, embedding) VALUES (?, ?, vec_f32(?))",
		);
		for (const chunk of input.currentChunks) {
			insertChunk.run(
				chunk.chunkId,
				input.memoryId,
				chunk.chunkIndex,
				chunk.chunkText,
				chunk.densePayload,
				chunk.summary ?? null,
				chunk.startOffset,
				chunk.endOffset,
				chunk.tokenCount,
				chunk.contentType,
				chunk.chunkingVersion,
				chunk.embedderProvider,
				chunk.embedderModel,
				chunk.embedderDim,
				updatedAtMs,
				updatedAtMs,
			);
			insertVector.run(chunk.chunkId, row.project_id, chunk.vectorBytes);
		}
		input.database.prepare("DELETE FROM nodix_rem_memory_facets WHERE memory_id = ?").run(input.memoryId);
		const insertFacet = input.database.prepare(
			"INSERT INTO nodix_rem_memory_facets(memory_id, facet, text, updated_at_ms) VALUES (?, ?, ?, ?)",
		);
		insertFacet.run(input.memoryId, "current", input.current, updatedAtMs);
		insertFacet.run(input.memoryId, "history", input.history, updatedAtMs);
		const expectedFacets = input.database
			.prepare(
				"SELECT facet, text, updated_at_ms FROM nodix_rem_memory_facets WHERE memory_id = ? ORDER BY facet",
			)
			.all(input.memoryId) as MemoryFacetRow[];
		const expectedChunkFacets = input.database
			.prepare(
				"SELECT chunk_id, facet, chunk_index FROM nodix_memory_chunks WHERE memory_id = ? ORDER BY chunk_id",
			)
			.all(input.memoryId) as ChunkFacetRow[];
		input.database
			.prepare(
				`INSERT INTO nodix_rem_facet_recovery(
					recovery_handle, prior_facets_json, prior_chunk_facets_json,
					expected_facets_json, expected_chunk_facets_json
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				recoveryHandle,
				JSON.stringify(priorFacets),
				JSON.stringify(priorChunkFacets),
				JSON.stringify(expectedFacets),
				JSON.stringify(expectedChunkFacets),
			);
		const queueId = input.jobId;
		input.database
			.prepare(
				`INSERT INTO nodix_rem_journal(
					job_id, job_type, stage, outcome, row_id, pairs_scanned, verdicts, actions_applied
				) VALUES (?, ?, 'two-facet-write', 'done', ?, 0, 0, 1)`,
			)
			.run(queueId, input.jobType, input.memoryId);
		// The two `pending` grooming rows that used to be written here named work nothing
		// ever performed: this transaction already writes the new chunks, their vectors and
		// the full-text rows. A queue no reader drains makes every journal look like it has
		// outstanding work forever, which is worse than no row at all.
		return { contentHash: nextHash, recoveryHandle };
	}).immediate() as { contentHash: string; recoveryHandle: string };
}
