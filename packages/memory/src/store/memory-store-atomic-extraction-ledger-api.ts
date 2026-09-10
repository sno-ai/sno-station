/** @file memory-store-atomic-extraction-ledger-api.ts
 * @purpose Persists atomic extraction chunk state and bounded reprocess repairs.
 * @boundary Serial chunk lifecycle and transaction completion only; no model calls or extraction.
 */

import {
	type AtomicExtractionLedgerEntry,
	type AtomicExtractionLedgerKey,
	type AtomicExtractionLedgerState,
	type AtomicExtractionRepairStrategy,
	type AtomicExtractionReprocessBounds,
	type AtomicExtractionReprocessReason,
	type AtomicExtractionRunParameters,
	type BeginAtomicExtractionChunkInput,
	type BeginAtomicExtractionChunkResult,
	MemoryStore,
	type MemoryStoreInternals,
	type ReopenAtomicExtractionChunkResult,
} from "./memory-store-base";
import { log, StorageError } from "./memory-store-shared";
import { privateLogReference } from "@snoai/utils/logger";

interface AtomicExtractionLedgerDatabaseRow {
	conversationId: string;
	chunkHash: string;
	pipelineVersion: string;
	state: AtomicExtractionLedgerState;
	rawChunk: string;
	routingSnapshotId: string;
	runParametersJson: string;
	reprocessReason: AtomicExtractionReprocessReason | null;
	reprocessAttemptCount: number;
	failedReply: string | null;
	createdAt: number;
	updatedAt: number;
}

const SELECT_LEDGER_ROW = `
	SELECT
		conversation_id AS conversationId,
		chunk_hash AS chunkHash,
		pipeline_version AS pipelineVersion,
		state,
		raw_chunk AS rawChunk,
		routing_snapshot_id AS routingSnapshotId,
		run_parameters_json AS runParametersJson,
		reprocess_reason AS reprocessReason,
		reprocess_attempt_count AS reprocessAttemptCount,
		failed_reply AS failedReply,
		created_at AS createdAt,
		updated_at AS updatedAt
	FROM nodix_atomic_extraction_ledger
	WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?
`;

function keyParameters(key: AtomicExtractionLedgerKey): [string, string, string] {
	return [key.conversationId, key.chunkHash, key.pipelineVersion];
}

function assertNonEmpty(value: string, name: string): void {
	if (!value.trim()) throw new StorageError(`${name} must not be empty`);
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new StorageError(`${name} must be a positive safe integer`);
	}
}

function assertTimestamp(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new StorageError("nowMs must be a non-negative safe integer");
	}
}

function validateKey(key: AtomicExtractionLedgerKey): void {
	assertNonEmpty(key.conversationId, "conversationId");
	assertNonEmpty(key.chunkHash, "chunkHash");
	assertNonEmpty(key.pipelineVersion, "pipelineVersion");
}

function validateRunParameters(parameters: AtomicExtractionRunParameters): void {
	assertPositiveInteger(parameters.maxInputTokens, "maxInputTokens");
	assertPositiveInteger(parameters.outputTokenBudget, "outputTokenBudget");
	assertPositiveInteger(parameters.subchunkCount, "subchunkCount");
}

function parseRunParameters(json: string): AtomicExtractionRunParameters {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new StorageError("Atomic extraction ledger contains invalid run parameters JSON");
	}
	if (typeof value !== "object" || value === null) {
		throw new StorageError("Atomic extraction ledger contains invalid run parameters");
	}
	const parameters: AtomicExtractionRunParameters = {
		maxInputTokens: Reflect.get(value, "maxInputTokens") as number,
		outputTokenBudget: Reflect.get(value, "outputTokenBudget") as number,
		subchunkCount: Reflect.get(value, "subchunkCount") as number,
	};
	validateRunParameters(parameters);
	return parameters;
}

function toEntry(row: AtomicExtractionLedgerDatabaseRow): AtomicExtractionLedgerEntry {
	return {
		conversationId: row.conversationId,
		chunkHash: row.chunkHash,
		pipelineVersion: row.pipelineVersion,
		state: row.state,
		rawChunk: row.rawChunk,
		routingSnapshotId: row.routingSnapshotId,
		runParameters: parseRunParameters(row.runParametersJson),
		reprocessReason: row.reprocessReason,
		reprocessAttemptCount: row.reprocessAttemptCount,
		failedReply: row.failedReply,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function readEntry(
	store: MemoryStoreInternals,
	key: AtomicExtractionLedgerKey,
): AtomicExtractionLedgerEntry {
	const row = store.sqlite.prepare(SELECT_LEDGER_ROW).get(...keyParameters(key)) as
		| AtomicExtractionLedgerDatabaseRow
		| undefined;
	if (!row) throw new StorageError("Atomic extraction ledger row does not exist");
	return toEntry(row);
}

function doubledSubchunkCount(value: number): number {
	assertPositiveInteger(value, "subchunkCount");
	const doubled = value * 2;
	if (!Number.isSafeInteger(doubled)) {
		throw new StorageError("subchunkCount cannot be increased safely");
	}
	return doubled;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "then") === "function"
	);
}

export function repairAtomicExtractionParameters(
	reason: AtomicExtractionReprocessReason,
	parameters: AtomicExtractionRunParameters,
	bounds: AtomicExtractionReprocessBounds,
): { strategy: AtomicExtractionRepairStrategy; parameters: AtomicExtractionRunParameters } {
	validateRunParameters(parameters);
	assertPositiveInteger(bounds.maxOutputTokenBudget, "maxOutputTokenBudget");
	if (parameters.outputTokenBudget > bounds.maxOutputTokenBudget) {
		throw new StorageError("outputTokenBudget exceeds its reprocess bound");
	}

	if (reason === "input-overflow") {
		if (
			bounds.requiredInputTokens !== undefined &&
			bounds.requiredInputTokens > parameters.maxInputTokens
		) {
			return {
				strategy: "raise-input-budget",
				parameters: {
					...parameters,
					maxInputTokens: bounds.requiredInputTokens,
				},
			};
		}
		if (parameters.maxInputTokens > 1) {
			return {
				strategy: "rechunk-smaller",
				parameters: {
					...parameters,
					maxInputTokens: Math.max(1, Math.floor(parameters.maxInputTokens / 2)),
				},
			};
		}
		return {
			strategy: "subchunk-smaller",
			parameters: { ...parameters, subchunkCount: doubledSubchunkCount(parameters.subchunkCount) },
		};
	}

	if (reason === "truncation-exhaustion") {
		if (parameters.outputTokenBudget < bounds.maxOutputTokenBudget) {
			return {
				strategy: "double-output-budget",
				parameters: {
					...parameters,
					outputTokenBudget: Math.min(
						bounds.maxOutputTokenBudget,
						parameters.outputTokenBudget * 2,
					),
				},
			};
		}
		return {
			strategy: "subchunk-smaller",
			parameters: { ...parameters, subchunkCount: doubledSubchunkCount(parameters.subchunkCount) },
		};
	}

	return { strategy: "rerun-as-is", parameters: { ...parameters } };
}

Object.assign(MemoryStore.prototype, {
	beginAtomicExtractionChunk(
		this: MemoryStoreInternals,
		input: BeginAtomicExtractionChunkInput,
	): BeginAtomicExtractionChunkResult {
		validateKey(input);
		assertNonEmpty(input.rawChunk, "rawChunk");
		assertNonEmpty(input.routingSnapshotId, "routingSnapshotId");
		validateRunParameters(input.runParameters);
		assertTimestamp(input.nowMs);
		this.sqlite
			.prepare(`
				INSERT OR IGNORE INTO nodix_atomic_extraction_ledger(
					conversation_id, chunk_hash, pipeline_version, state, raw_chunk,
					routing_snapshot_id, run_parameters_json, created_at, updated_at
				) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)
			`)
			.run(
				input.conversationId,
				input.chunkHash,
				input.pipelineVersion,
				input.rawChunk,
				input.routingSnapshotId,
				JSON.stringify(input.runParameters),
				input.nowMs,
				input.nowMs,
			);
		const entry = readEntry(this, input);
		if (entry.rawChunk !== input.rawChunk || entry.routingSnapshotId !== input.routingSnapshotId) {
			throw new StorageError("Atomic extraction ledger key collides with different chunk input");
		}
		if (entry.state === "complete") return { action: "skip", entry };
		if (entry.state === "pending_reprocess") return { action: "pending", entry };
		return { action: "run", entry };
	},

	recordAtomicExtractionCalls(
		this: MemoryStoreInternals,
		key: AtomicExtractionLedgerKey,
		nowMs: number,
	): void {
		validateKey(key);
		assertTimestamp(nowMs);
		const entry = readEntry(this, key);
		if (entry.state !== "open" && entry.state !== "calls_recorded") {
			throw new StorageError(`Cannot record calls from atomic extraction state '${entry.state}'`);
		}
		this.sqlite
			.prepare(`
				UPDATE nodix_atomic_extraction_ledger
				SET state = 'calls_recorded', failed_reply = NULL, updated_at = ?
				WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?
			`)
			.run(nowMs, ...keyParameters(key));
	},

	markAtomicExtractionPending(
		this: MemoryStoreInternals,
		key: AtomicExtractionLedgerKey,
		reason: AtomicExtractionReprocessReason,
		failedReply: string | null,
		nowMs: number,
		runParameters?: AtomicExtractionRunParameters,
	): void {
		validateKey(key);
		assertTimestamp(nowMs);
		if (runParameters !== undefined) validateRunParameters(runParameters);
		const entry = readEntry(this, key);
		if (entry.state !== "calls_recorded") {
			throw new StorageError(`Cannot pend atomic extraction from state '${entry.state}'`);
		}
		this.sqlite
			.prepare(`
				UPDATE nodix_atomic_extraction_ledger
				SET state = 'pending_reprocess', reprocess_reason = ?, failed_reply = ?,
					run_parameters_json = COALESCE(?, run_parameters_json), updated_at = ?
				WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?
			`)
			.run(
				reason,
				failedReply,
				runParameters === undefined ? null : JSON.stringify(runParameters),
				nowMs,
				...keyParameters(key),
			);
	},

	reopenAtomicExtractionChunk(
		this: MemoryStoreInternals,
		key: AtomicExtractionLedgerKey,
		attemptCap: number,
		bounds: AtomicExtractionReprocessBounds,
		nowMs: number,
	): ReopenAtomicExtractionChunkResult {
		validateKey(key);
		assertPositiveInteger(attemptCap, "attemptCap");
		assertTimestamp(nowMs);
		const entry = readEntry(this, key);
		if (entry.state !== "pending_reprocess" || entry.reprocessReason === null) {
			throw new StorageError(`Cannot reopen atomic extraction from state '${entry.state}'`);
		}
		if (entry.reprocessAttemptCount >= attemptCap) {
			log.error("atomic extraction chunk stuck at reprocess attempt cap", {
				product_session_reference: privateLogReference(key.conversationId),
				chunk_hash: key.chunkHash,
				version: key.pipelineVersion,
				reason_code: entry.reprocessReason,
				reprocessAttemptCount: entry.reprocessAttemptCount,
				attemptCap,
			}, {
				event_name: "sno_station_mem.memory-store-atomic-extraction-ledger-api.atomic.extraction.chunk.stuck.at.reprocess.attempt.cap",
				file: "packages/sno-station-mem/src/store/memory-store-atomic-extraction-ledger-api.ts",
				function: "reopenAtomicExtractionChunk",
				site_id: "memory-store-atomic-extraction-ledger-api.reopenAtomicExtractionChunk.e05258e34b",
			});
			return { status: "stuck", entry };
		}
		const repair = repairAtomicExtractionParameters(
			entry.reprocessReason,
			entry.runParameters,
			bounds,
		);
		this.sqlite
			.prepare(`
				UPDATE nodix_atomic_extraction_ledger
				SET state = 'open', run_parameters_json = ?,
					reprocess_attempt_count = reprocess_attempt_count + 1, updated_at = ?
				WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?
			`)
			.run(JSON.stringify(repair.parameters), nowMs, ...keyParameters(key));
		return { status: "reopened", strategy: repair.strategy, entry: readEntry(this, key) };
	},

	completeAtomicExtractionChunk(
		this: MemoryStoreInternals,
		key: AtomicExtractionLedgerKey,
		nowMs: number,
		write: Parameters<MemoryStore["completeAtomicExtractionChunk"]>[2],
	): AtomicExtractionLedgerEntry {
		validateKey(key);
		assertTimestamp(nowMs);
		const transaction = this.sqlite.transaction(() => {
			const entry = readEntry(this, key);
			if (entry.state !== "calls_recorded") {
				throw new StorageError(`Cannot complete atomic extraction from state '${entry.state}'`);
			}
			const writeResult: unknown = write(this.sqlite);
			if (isPromiseLike(writeResult)) {
				throw new StorageError("Atomic extraction completion callback must be synchronous");
			}
			this.sqlite
				.prepare(`
					UPDATE nodix_atomic_extraction_ledger
					SET state = 'complete', reprocess_reason = NULL, failed_reply = NULL, updated_at = ?
					WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?
				`)
				.run(nowMs, ...keyParameters(key));
			return readEntry(this, key);
		});
		return transaction.immediate() as AtomicExtractionLedgerEntry;
	},
});
