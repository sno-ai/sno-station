/** @file atomic-extraction-ledger.test.ts
 * @purpose Proves atomic extraction chunk recovery and commit behavior on real encrypted SQLite.
 * @boundary MemoryStore ledger API, its state machine, repair choices, and transaction callback.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionReprocessBounds,
	type AtomicExtractionReprocessReason,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import type { SqliteDatabaseLike } from "../../../../packages/memory/src/store/sqlite-runtime";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";
import { privateLogReference } from "@snoai/utils/logger";


const BASE_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 1_000,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};
const REPROCESS_BOUNDS: AtomicExtractionReprocessBounds = {
	maxOutputTokenBudget: 4_000,
	maxRecordCap: 16,
};

interface LedgerRow {
	state: "open" | "calls_recorded" | "complete" | "pending_reprocess";
	raw_chunk: string;
	run_parameters_json: string;
	reprocess_reason: AtomicExtractionReprocessReason | null;
	reprocess_attempt_count: number;
	failed_reply: string | null;
}

function ledgerKey(suffix: string): AtomicExtractionLedgerKey {
	return {
		conversationId: `conversation-${suffix}`,
		chunkHash: `chunk-${suffix}`,
		pipelineVersion: "atomic-v1",
	};
}

function beginInput(
	key: AtomicExtractionLedgerKey,
	overrides: Partial<{
		rawChunk: string;
		routingSnapshotId: string;
		runParameters: AtomicExtractionRunParameters;
		nowMs: number;
	}> = {},
) {
	return {
		...key,
		rawChunk: overrides.rawChunk ?? `raw text for ${key.chunkHash}`,
		routingSnapshotId: overrides.routingSnapshotId ?? "routing-snapshot-v1",
		runParameters: overrides.runParameters ?? BASE_PARAMETERS,
		nowMs: overrides.nowMs ?? 1,
	};
}

function readLedger(database: SqliteDatabaseLike, key: AtomicExtractionLedgerKey): LedgerRow {
	const row = database
		.prepare(`
			SELECT state, raw_chunk, run_parameters_json, reprocess_reason,
				reprocess_attempt_count, failed_reply
			FROM nodix_atomic_extraction_ledger
			WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?
		`)
		.get(key.conversationId, key.chunkHash, key.pipelineVersion) as LedgerRow | undefined;
	if (!row) throw new Error(`missing ledger row for ${key.chunkHash}`);
	return row;
}

function captureStderr<T>(run: () => T): { result: T; output: string } {
	const originalWrite = process.stderr.write;
	let output = "";
	process.stderr.write = ((chunk: Uint8Array | string, ...args: unknown[]) => {
		output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return Reflect.apply(originalWrite, process.stderr, [chunk, ...args]) as boolean;
	}) as typeof process.stderr.write;
	try {
		return { result: run(), output };
	} finally {
		process.stderr.write = originalWrite;
	}
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic extraction ledger", () => {
	let fixture: TestDb;
	let store: MemoryStore;

	beforeEach(() => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	it("uses the complete three-part key and rejects a different input at the same key", () => {
		const base = ledgerKey("key");
		const keys = [
			base,
			{ ...base, conversationId: "conversation-other" },
			{ ...base, chunkHash: "chunk-other" },
			{ ...base, pipelineVersion: "atomic-v2" },
		];
		for (const key of keys) {
			expect(store.beginAtomicExtractionChunk(beginInput(key))).toMatchObject({
				action: "run",
				entry: { state: "open", ...key },
			});
		}
		expect(
			fixture.runtime.db
				.prepare("SELECT COUNT(*) AS count FROM nodix_atomic_extraction_ledger")
				.get(),
		).toEqual({ count: 4 });
		expect(() =>
			store.beginAtomicExtractionChunk(beginInput(base, { rawChunk: "different raw chunk" })),
		).toThrow(/key collides with different chunk input/u);
	});

	it("enforces the four states across restart, pending sweep, and complete replay", async () => {
		const key = ledgerKey("states");
		const initial = store.beginAtomicExtractionChunk(beginInput(key));
		expect(initial).toMatchObject({ action: "run", entry: { state: "open" } });
		expect(() =>
			store.markAtomicExtractionPending(key, "parse-exhaustion", "bad reply", 2),
		).toThrow(/Cannot pend atomic extraction from state 'open'/u);
		expect(() => store.completeAtomicExtractionChunk(key, 2, () => undefined)).toThrow(
			/Cannot complete atomic extraction from state 'open'/u,
		);
		expect(() => store.reopenAtomicExtractionChunk(key, 2, REPROCESS_BOUNDS, 2)).toThrow(
			/Cannot reopen atomic extraction from state 'open'/u,
		);

		store.recordAtomicExtractionCalls(key, 3);
		expect(readLedger(fixture.runtime.db, key).state).toBe("calls_recorded");
		await store.close();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		expect(store.beginAtomicExtractionChunk(beginInput(key, { nowMs: 4 }))).toMatchObject({
			action: "run",
			entry: { state: "calls_recorded", rawChunk: `raw text for ${key.chunkHash}` },
		});
		expect(() => store.reopenAtomicExtractionChunk(key, 2, REPROCESS_BOUNDS, 4)).toThrow(
			/Cannot reopen atomic extraction from state 'calls_recorded'/u,
		);

		const failedReply = "prefix { malformed reply tail";
		store.markAtomicExtractionPending(key, "parse-exhaustion", failedReply, 5);
		expect(store.beginAtomicExtractionChunk(beginInput(key, { nowMs: 6 }))).toMatchObject({
			action: "pending",
			entry: {
				state: "pending_reprocess",
				rawChunk: `raw text for ${key.chunkHash}`,
				failedReply,
			},
		});
		expect(() => store.recordAtomicExtractionCalls(key, 6)).toThrow(
			/Cannot record calls from atomic extraction state 'pending_reprocess'/u,
		);
		expect(() => store.completeAtomicExtractionChunk(key, 6, () => undefined)).toThrow(
			/Cannot complete atomic extraction from state 'pending_reprocess'/u,
		);
		expect(() =>
			store.markAtomicExtractionPending(key, "parse-exhaustion", failedReply, 6),
		).toThrow(/Cannot pend atomic extraction from state 'pending_reprocess'/u);

		const reopened = store.reopenAtomicExtractionChunk(key, 2, REPROCESS_BOUNDS, 7);
		expect(reopened).toMatchObject({
			status: "reopened",
			strategy: "rerun-as-is",
			entry: { state: "open", reprocessAttemptCount: 1, failedReply },
		});
		expect(store.beginAtomicExtractionChunk(beginInput(key, { nowMs: 8 }))).toMatchObject({
			action: "run",
			entry: { state: "open" },
		});

		store.recordAtomicExtractionCalls(key, 9);
		const complete = store.completeAtomicExtractionChunk(key, 10, () => undefined);
		expect(complete.state).toBe("complete");
		expect(store.beginAtomicExtractionChunk(beginInput(key, { nowMs: 11 }))).toMatchObject({
			action: "skip",
			entry: { state: "complete" },
		});
		expect(() => store.recordAtomicExtractionCalls(key, 12)).toThrow(
			/Cannot record calls from atomic extraction state 'complete'/u,
		);
		expect(() =>
			store.markAtomicExtractionPending(key, "parse-exhaustion", failedReply, 12),
		).toThrow(/Cannot pend atomic extraction from state 'complete'/u);
		expect(() => store.reopenAtomicExtractionChunk(key, 2, REPROCESS_BOUNDS, 12)).toThrow(
			/Cannot reopen atomic extraction from state 'complete'/u,
		);
		expect(() => store.completeAtomicExtractionChunk(key, 12, () => undefined)).toThrow(
			/Cannot complete atomic extraction from state 'complete'/u,
		);
	});

	it("changes the failed parameter for each reason and logs a capped chunk as stuck", () => {
		const pend = (
			key: AtomicExtractionLedgerKey,
			reason: AtomicExtractionReprocessReason,
			parameters: AtomicExtractionRunParameters = BASE_PARAMETERS,
			failedReply = `failed reply for ${reason}`,
		): void => {
			store.beginAtomicExtractionChunk(beginInput(key, { runParameters: parameters }));
			store.recordAtomicExtractionCalls(key, 2);
			store.markAtomicExtractionPending(key, reason, failedReply, 3);
		};

		const inputKey = ledgerKey("input-overflow");
		pend(inputKey, "input-overflow");
		const inputRepair = store.reopenAtomicExtractionChunk(
			inputKey,
			3,
			REPROCESS_BOUNDS,
			4,
		);
		expect(inputRepair).toMatchObject({
			status: "reopened",
			strategy: "rechunk-smaller",
			entry: {
				rawChunk: `raw text for ${inputKey.chunkHash}`,
				failedReply: "failed reply for input-overflow",
				runParameters: { maxInputTokens: 500 },
			},
		});

		const truncationKey = ledgerKey("truncation");
		pend(truncationKey, "truncation-exhaustion");
		const budgetDoubled = store.reopenAtomicExtractionChunk(
			truncationKey,
			3,
			REPROCESS_BOUNDS,
			4,
		);
		expect(budgetDoubled).toMatchObject({
			status: "reopened",
			strategy: "double-output-budget",
			entry: { runParameters: { outputTokenBudget: 4_000 } },
		});
		store.recordAtomicExtractionCalls(truncationKey, 5);
		store.markAtomicExtractionPending(truncationKey, "truncation-exhaustion", "still cut", 6);
		const truncationSubchunk = store.reopenAtomicExtractionChunk(
			truncationKey,
			3,
			REPROCESS_BOUNDS,
			7,
		);
		expect(truncationSubchunk).toMatchObject({
			status: "reopened",
			strategy: "subchunk-smaller",
			entry: { runParameters: { outputTokenBudget: 4_000, subchunkCount: 2 } },
		});

		const parseKey = ledgerKey("parse");
		pend(parseKey, "parse-exhaustion");
		const parseRetry = store.reopenAtomicExtractionChunk(parseKey, 3, REPROCESS_BOUNDS, 4);
		expect(parseRetry).toMatchObject({
			status: "reopened",
			strategy: "rerun-as-is",
			entry: { runParameters: BASE_PARAMETERS },
		});

		const cappedKey = ledgerKey("attempt-cap");
		pend(cappedKey, "parse-exhaustion");
		expect(() =>
			Reflect.apply(store.reopenAtomicExtractionChunk, store, [cappedKey]),
		).toThrow(/attemptCap must be a positive safe integer/u);
		const firstRetry = store.reopenAtomicExtractionChunk(
			cappedKey,
			1,
			REPROCESS_BOUNDS,
			4,
		);
		expect(firstRetry).toMatchObject({ status: "reopened", entry: { reprocessAttemptCount: 1 } });
		store.recordAtomicExtractionCalls(cappedKey, 5);
		store.markAtomicExtractionPending(cappedKey, "parse-exhaustion", "last failed reply", 6);
		const captured = captureStderr(() =>
			store.reopenAtomicExtractionChunk(cappedKey, 1, REPROCESS_BOUNDS, 7),
		);
		expect(captured.result).toMatchObject({
			status: "stuck",
			entry: {
				state: "pending_reprocess",
				reprocessAttemptCount: 1,
				failedReply: "last failed reply",
			},
		});
		expect(captured.output).toContain("atomic extraction chunk stuck at reprocess attempt cap");
		// Logs name the conversation by its private reference only, never by the raw id.
		expect(captured.output).toContain(String(privateLogReference(cappedKey.conversationId).value));
		expect(captured.output).not.toContain(cappedKey.conversationId);
		expect(captured.output).toContain('"attemptCap":1');
	});

	it("rolls callback writes back with failure and marks complete only after a successful write", () => {
		const key = ledgerKey("transaction");
		store.beginAtomicExtractionChunk(beginInput(key));
		store.recordAtomicExtractionCalls(key, 2);
		const insertCard = (database: SqliteDatabaseLike): void => {
			database
				.prepare(`
					INSERT INTO nodix_memories(
						id, text, category, project_id, timestamp, timezone, metadata,
						content_hash, fact_id, lane
					) VALUES (
						'transaction-card', 'Atomic callback card.', 'episodic',
						'ledger-transaction', 1, 'UTC', '{}',
						'transaction-card-hash', 'transaction-card-fact', 'active'
					)
				`)
				.run();
		};

		expect(() =>
			store.completeAtomicExtractionChunk(key, 3, (database) => {
				expect(readLedger(database, key).state).toBe("calls_recorded");
				insertCard(database);
				throw new Error("injected callback crash");
			}),
		).toThrow(/injected callback crash/u);
		expect(readLedger(fixture.runtime.db, key).state).toBe("calls_recorded");
		expect(
			fixture.runtime.db
				.prepare(
					"SELECT COUNT(*) AS count FROM nodix_memories WHERE id = 'transaction-card'",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(store.beginAtomicExtractionChunk(beginInput(key, { nowMs: 4 }))).toMatchObject({
			action: "run",
			entry: { state: "calls_recorded" },
		});

		const complete = store.completeAtomicExtractionChunk(key, 5, (database) => {
			expect(readLedger(database, key).state).toBe("calls_recorded");
			insertCard(database);
		});
		expect(complete.state).toBe("complete");
		expect(
			fixture.runtime.db
				.prepare(
					"SELECT COUNT(*) AS count FROM nodix_memories WHERE id = 'transaction-card'",
				)
				.get(),
		).toEqual({ count: 1 });
	});

	it("restarts the whole chunk while the shipped store identity keeps one card", async () => {
		const key = ledgerKey("idempotent-restart");
		const card = {
			text: "The user keeps the ledger restart test deterministic.",
			category: "episodic" as const,
			projectId: "ledger-idempotent-restart",
			metadata: JSON.stringify({ idempotency_key: "ledger-restart-v1" }),
		};
		store.beginAtomicExtractionChunk(beginInput(key));
		store.recordAtomicExtractionCalls(key, 2);
		const first = await store.store(card);

		await store.close();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		expect(store.beginAtomicExtractionChunk(beginInput(key, { nowMs: 3 }))).toMatchObject({
			action: "run",
			entry: { state: "calls_recorded" },
		});
		const rerun = await store.store(card);
		expect(rerun.id).toBe(first.id);
		store.recordAtomicExtractionCalls(key, 4);
		store.completeAtomicExtractionChunk(key, 5, () => undefined);
		expect(store.beginAtomicExtractionChunk(beginInput(key, { nowMs: 6 }))).toMatchObject({
			action: "skip",
			entry: { state: "complete" },
		});
		expect(await store.list({ projectId: card.projectId })).toHaveLength(1);
	});
});
