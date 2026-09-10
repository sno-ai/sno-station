/** Real SQLCipher replacement race fixture. No mocks or substitute storage. */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import type {
	SqliteDatabaseLike,
	SqliteTransactionLike,
} from "../../../../packages/sno-station-mem/src/store/sqlite-runtime.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import {
	MemoryTelemetryUsageOutbox,
	type MemoryTelemetryUsageInput,
} from "../../../../packages/sno-station-mem/src/engine/telemetry/memory-telemetry-outbox.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

interface CountRow {
	count: number;
}

interface OutboxClaimRow {
	status: string;
	next_attempt_ms: number | null;
}

const FACT_ID = "runtime-replacement-race-fact";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("runtime replacement during an outbox flush", () => {
	let cleanup: (() => void) | undefined;
	let oldStore: MemoryStore | undefined;
	let replacementStore: MemoryStore | undefined;

	afterEach(() => {
		try {
			oldStore?.closeSync();
		} catch {
			// Preserve the assertion failure while cleaning the isolated database.
		}
		try {
			replacementStore?.closeSync();
		} catch {
			// Preserve the assertion failure while cleaning the isolated database.
		}
		cleanup?.();
		cleanup = undefined;
		oldStore = undefined;
		replacementStore = undefined;
	});

	it("recovers exactly once when close interrupts before the batch commit", () => {
		const { dbPath, store } = createRuntimeStore();
		let claimAtClose: OutboxClaimRow | undefined;
		let closeCompleted = false;
		const outbox = new MemoryTelemetryUsageOutbox({
			sqlite: interruptBeforeBatchCommit(store.sqlite, () => {
				claimAtClose = store.sqlite
					.prepare("SELECT status, next_attempt_ms FROM nodix_memory_usage_outbox")
					.get() as OutboxClaimRow;
				store.closeSync();
				closeCompleted = true;
				oldStore = undefined;
			}),
			dbPath,
			agentId: "race-agent",
		});
		outbox.acceptUsage(usageInput());
		expect(() => outbox.flushPending()).toThrow(/database connection is not open/i);
		expect(closeCompleted).toBe(true);
		expect(claimAtClose?.status).toBe("flushing");
		expect(claimAtClose?.next_attempt_ms).toBeGreaterThan(Date.now());

		replacementStore = new MemoryStore({ dbPath, embedder });
		expect(countEvents(replacementStore, FACT_ID)).toBe(0);
		expect(countOutboxRows(replacementStore)).toBe(1);
		const persistedClaim = replacementStore.sqlite
			.prepare("SELECT status, next_attempt_ms FROM nodix_memory_usage_outbox")
			.get() as OutboxClaimRow;
		expect(persistedClaim).toEqual(claimAtClose);
		expect(replacementStore.sqlite.prepare("PRAGMA integrity_check").get()).toEqual({
			integrity_check: "ok",
		});

		// The old claim becomes eligible after its durable lease expires.
		replacementStore.sqlite
			.prepare("UPDATE nodix_memory_usage_outbox SET next_attempt_ms = 0 WHERE status = 'flushing'")
			.run();
		const replacementOutbox = createOutbox(replacementStore, dbPath);
		expect(replacementOutbox.drainPending(5_000)).toEqual({
			selected: 1,
			inserted: 1,
			deleted: 1,
			failed: 0,
		});
		expect(countEvents(replacementStore, FACT_ID)).toBe(1);
		expect(countOutboxRows(replacementStore)).toBe(0);
	});

	it("does not duplicate when close happens after the batch commit", () => {
		const { dbPath, store } = createRuntimeStore();
		let closeCompleted = false;
		const outbox = new MemoryTelemetryUsageOutbox({
			sqlite: interruptAfterBatchCommit(store.sqlite, () => {
				store.closeSync();
				closeCompleted = true;
				oldStore = undefined;
			}),
			dbPath,
			agentId: "race-agent",
		});
		outbox.acceptUsage(usageInput());
		expect(outbox.flushPending()).toEqual({ selected: 1, inserted: 1, deleted: 1, failed: 0 });
		expect(closeCompleted).toBe(true);

		replacementStore = new MemoryStore({ dbPath, embedder });
		const replacementOutbox = createOutbox(replacementStore, dbPath);
		expect(replacementOutbox.drainPending(5_000)).toEqual({
			selected: 0,
			inserted: 0,
			deleted: 0,
			failed: 0,
		});
		expect(countEvents(replacementStore, FACT_ID)).toBe(1);
		expect(countOutboxRows(replacementStore)).toBe(0);
	});

	function createRuntimeStore(): { dbPath: string; store: MemoryStore } {
		const fixture = createTestDb();
		cleanup = fixture.cleanup;
		fixture.sqlite.close();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		oldStore = store;
		return { dbPath: fixture.dbPath, store };
	}
});

function createOutbox(store: MemoryStore, dbPath: string): MemoryTelemetryUsageOutbox {
	return new MemoryTelemetryUsageOutbox({ sqlite: store.sqlite, dbPath, agentId: "race-agent" });
}

function usageInput(): MemoryTelemetryUsageInput {
	return {
		eventType: "recall",
		factId: FACT_ID,
		memoryKind: "episodic",
		projectId: "runtime-replacement-race",
		agentId: "race-agent",
		sessionUuid: "race-session",
		turnId: "race-turn",
		retrievalRank: 1,
		retrievalScore: 0.9,
		metadata: { retrieval_rank: 1, retrieval_score: 0.9 },
	};
}

function interruptBeforeBatchCommit(
	sqlite: SqliteDatabaseLike,
	interrupt: () => void,
): SqliteDatabaseLike {
	let transactionCount = 0;
	return {
		...sqlite,
		prepare: (sql) => sqlite.prepare(sql),
		exec: (sql) => sqlite.exec(sql),
		close: () => sqlite.close(),
		transaction(fn): SqliteTransactionLike {
			transactionCount += 1;
			if (transactionCount !== 2) return sqlite.transaction(fn);
			return sqlite.transaction((...args: never[]) => {
				interrupt();
				return fn(...args);
			});
		},
		loadExtension: (path) => sqlite.loadExtension(path),
		markFailed: (reason) => sqlite.markFailed(reason),
		isFailed: () => sqlite.isFailed(),
	};
}

function interruptAfterBatchCommit(
	sqlite: SqliteDatabaseLike,
	interrupt: () => void,
): SqliteDatabaseLike {
	let transactionCount = 0;
	return {
		...sqlite,
		prepare: (sql) => sqlite.prepare(sql),
		exec: (sql) => sqlite.exec(sql),
		close: () => sqlite.close(),
		transaction(fn): SqliteTransactionLike {
			transactionCount += 1;
			const transaction = sqlite.transaction(fn);
			if (transactionCount !== 2) return transaction;
			const afterCommit = (invoke: (...args: unknown[]) => unknown) => {
				return (...args: unknown[]) => {
					const result = invoke(...args);
					interrupt();
					return result;
				};
			};
			const wrapped = afterCommit((...args) => transaction(...args)) as SqliteTransactionLike;
			wrapped.default = afterCommit((...args) => transaction.default(...args));
			wrapped.deferred = afterCommit((...args) => transaction.deferred(...args));
			wrapped.immediate = afterCommit((...args) => transaction.immediate(...args));
			wrapped.exclusive = afterCommit((...args) => transaction.exclusive(...args));
			return wrapped;
		},
		loadExtension: (path) => sqlite.loadExtension(path),
		markFailed: (reason) => sqlite.markFailed(reason),
		isFailed: () => sqlite.isFailed(),
	};
}

function countEvents(store: MemoryStore, factId: string): number {
	return (
		store.sqlite
			.prepare("SELECT COUNT(*) AS count FROM nodix_memory_events WHERE fact_id = ?")
			.get(factId) as CountRow
	).count;
}

function countOutboxRows(store: MemoryStore): number {
	return (
		store.sqlite.prepare("SELECT COUNT(*) AS count FROM nodix_memory_usage_outbox").get() as CountRow
	).count;
}
