/** @file memory-store-rem-api.ts
 * @purpose Applies one recoverable REM text version across both indexed facets.
 * @boundary MemoryStore write mutex, encrypted SQLite transaction, chunks, audit, and recovery.
 */

import type {
	RemMutationResult,
	WriteTextVersionInput,
} from "../engine/rem/index";
import { writeRemTwoFacetTransaction } from "../engine/rem/index.js";
import { createHash } from "node:crypto";
import { createLogger } from "@snoai/utils/logger";
import {
	getSnoStationMemStateDir,
	runWithMemoryAudit,
} from "../engine/operations/runtime-audit-log";
import { MemoryStore, type MemoryStoreInternals } from "./memory-store-base";
import {
	hashInputForEntry,
	type PreparedChunkRow,
	stableHash,
	CHUNKING_VERSION,
} from "./memory-store-shared";

const log = createLogger("sno-station-mem:rem-write");

interface RemMemoryRow {
	id: string;
	text: string;
	category: string;
	project_id: string;
	importance: number;
	timestamp: number;
	metadata: string;
	content_hash: string;
	fact_id: string;
	derived_from: string | null;
	consolidation_epoch_id: string | null;
	confidence_source: string | null;
	lane: "active" | "parked" | "quarantined";
	raw_candidate_json: string | null;
	disposition_reason: string | null;
	dispositioned_at_ms: number | null;
}

Object.assign(MemoryStore.prototype, {
	async applyRemTextVersion(
		this: MemoryStoreInternals,
		input: WriteTextVersionInput,
	): Promise<RemMutationResult> {
		if (input.reason.trim().length === 0) throw new Error("mutation reason is required");
		if (input.idempotencyKey !== undefined && input.idempotencyKey.trim().length === 0) {
			throw new Error("REM idempotency key must be non-empty");
		}
		if (input.replacementText.trim().length === 0) {
			throw new Error("REM replacement text must be non-empty");
		}
		const resumeBackfill = this.cancelScheduledLegacyChunkBackfill();
		try {
			const chunks = await this.prepareChunkInserts(input.rowId, input.replacementText);
			let completedMutation: RemMutationResult | undefined;
			try {
				return await runWithMemoryAudit({
					stateDir: getSnoStationMemStateDir(),
					event: "memory_updated",
					operation: "rem-update",
					startedDetails: { memory_ids: [input.rowId], requested_count: 1 },
					run: async () => {
						completedMutation = await this.writeMutex.runExclusive(() =>
							applyTransaction(this, input, chunks),
						);
						return completedMutation;
					},
					completedDetails: (mutation) => ({
						memory_ids: mutation.applied ? [input.rowId] : [],
						requested_count: 1,
						result_count: mutation.applied ? 1 : 0,
						outcome: mutation.applied ? "rem-update" : mutation.reason,
					}),
				});
			} catch (error) {
				if (completedMutation === undefined) throw error;
				log.error("rem_write_completion_audit_failed", { error, row_id: input.rowId }, {
					event_name: "sno_station_mem.memory-store-rem-api.rem.write.completion.audit.failed",
					file: "packages/sno-station-mem/src/store/memory-store-rem-api.ts",
					function: "applyRemTextVersion",
					site_id: "memory-store-rem-api.applyRemTextVersion.6422a9ebd1",
				});
				return completedMutation;
			}
		} finally {
			if (resumeBackfill) this.scheduleLegacyChunkBackfill();
		}
	},
});

export { deriveRemUpdateStamp } from "./rem-update-stamp-migration";

async function applyTransaction(
	store: MemoryStoreInternals,
	input: WriteTextVersionInput,
	chunks: PreparedChunkRow[],
): Promise<RemMutationResult> {
	const existing = readMemory(store, input.rowId);
	if (!existing) return { applied: false, reason: "missing" };
	const priorMetadata = parseMetadata(existing.metadata);
	if (
		input.idempotencyKey !== undefined &&
		priorMetadata["rem_update_idempotency_key"] === input.idempotencyKey
	) {
		if (existing.text === input.replacementText) {
			return { applied: false, reason: "already_applied" };
		}
		throw new Error("REM idempotency key conflicts with different replacement text");
	}
	if (existing.content_hash !== input.plannedContentHash) {
		return { applied: false, reason: "content_changed" };
	}
	if (existing.text === input.replacementText) {
		return { applied: false, reason: "already_applied" };
	}
	if (input.historyText !== undefined && input.historyText !== existing.text) {
		return { applied: false, reason: "content_changed" };
	}

	const updatedAtMs = Date.parse(input.timestamp);
	if (!Number.isFinite(updatedAtMs)) throw new Error("mutation timestamp is invalid");
	const nextMetadata = JSON.stringify({
		...priorMetadata,
		...(input.supersededItems === undefined
			? {}
			: { superseded_items: mergeSupersededItems(priorMetadata, input.supersededItems) }),
		...(input.sourceVersion === undefined
			? {}
			: { rem_update_source_version: input.sourceVersion }),
		...(input.rewriteConfig === undefined
			? {}
			: { rem_update_rewrite_config: input.rewriteConfig }),
		...(input.idempotencyKey === undefined
			? {}
			: { rem_update_idempotency_key: input.idempotencyKey }),
		rem_update_result_text_sha256: createHash("sha256")
			.update(input.replacementText)
			.digest("hex"),
		rem_updated_at: input.timestamp,
	});
	const nextContentHash = stableHash(hashInputForEntry(input.replacementText, nextMetadata));
	const collision = store.sqlite
		.prepare(
			"SELECT id FROM nodix_memories WHERE project_id = ? AND content_hash = ? AND category = ? AND id != ? LIMIT 1",
		)
		.get(existing.project_id, nextContentHash, existing.category, existing.id) as
		| { id: string }
		| undefined;
	if (collision) throw new Error(`REM text version collides with memory ${collision.id}`);

	const result = await writeRemTwoFacetTransaction({
		database: store.sqlite,
		memoryId: existing.id,
		current: input.replacementText,
		history: input.historyText ?? existing.text,
		currentChunks: chunks.map((chunk) => ({
			chunkId: chunk.chunkId,
			chunkIndex: chunk.chunkIndex,
			chunkText: chunk.draft.chunkText,
			densePayload: chunk.densePayload,
			summary: chunk.summary,
			startOffset: chunk.draft.startOffset,
			endOffset: chunk.draft.endOffset,
			tokenCount: chunk.draft.tokenCount,
			contentType: chunk.draft.contentType,
			chunkingVersion: CHUNKING_VERSION,
			embedderProvider: store.embedder.providerKind,
			embedderModel: store.embedder.model,
			embedderDim: store.embedder.dimensions,
			vectorBytes: chunk.vectorBytes,
		})),
		timestamp: input.timestamp,
		metadata: nextMetadata,
		contentHash: nextContentHash,
		reason: input.reason,
		// The invoking job, not the idempotency key. Those are different facts and this line was
		// writing the second into a column named for the first, which is how a journal row ended up
		// pointing at something that is not a job at all.
		jobId: input.jobId,
		jobType: input.jobType,
		attemptId: input.attemptId,
	});
	try {
		const sourceEventId = store.telemetryEvents.readLatestReceiptEventId(existing.fact_id);
		store.telemetryEvents.writeReceiptEvent({
			eventType: "update",
			factId: existing.fact_id,
			memoryKind: existing.category,
			projectId: existing.project_id,
			sourceEventId,
			contentHash: result.contentHash,
			metadata: {
				changed_keys: ["text", "metadata", "content_hash", "facets", "chunks"],
				content_hash: result.contentHash,
			},
		});
	} catch (error) {
		log.error("rem_write_receipt_failed", { error, row_id: existing.id }, {
			event_name: "sno_station_mem.memory-store-rem-api.rem.write.receipt.failed",
			file: "packages/sno-station-mem/src/store/memory-store-rem-api.ts",
			function: "applyTransaction",
			site_id: "memory-store-rem-api.applyTransaction.47fe85179a",
		});
	}
	return { applied: true, ...result };
}

function mergeSupersededItems(
	metadata: Record<string, unknown>,
	nextItems: readonly string[],
): string[] {
	const existing = metadata["superseded_items"];
	if (existing !== undefined && (!Array.isArray(existing) || existing.some((item) => typeof item !== "string"))) {
		throw new Error("REM superseded_items metadata must be an array of strings");
	}
	return [...new Set([...(existing as string[] | undefined ?? []), ...nextItems])];
}

function readMemory(store: MemoryStoreInternals, rowId: string): RemMemoryRow | undefined {
	return store.sqlite
		.prepare(
			`SELECT id, text, category, project_id, importance, timestamp, metadata, content_hash,
				fact_id, derived_from, consolidation_epoch_id, confidence_source, lane,
				raw_candidate_json, disposition_reason, dispositioned_at_ms
			FROM nodix_memories WHERE id = ?`,
		)
		.get(rowId) as RemMemoryRow | undefined;
}

function parseMetadata(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("memory metadata must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}
