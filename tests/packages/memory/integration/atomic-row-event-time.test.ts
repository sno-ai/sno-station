/** @file atomic-row-event-time.test.ts
 * @purpose Proves a stored atomic row is dated by when the remembered thing happened, never by the write clock.
 * @boundary The real write projection and real encrypted SQLite through MemoryStore; no model calls.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAtomicWriteCards } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";
import type { AtomicKeyedRecord } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-profile-keying";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/sno-station-mem/src/store/store";
import type { SqliteDatabaseLike } from "../../../../packages/sno-station-mem/src/store/sqlite-runtime";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const PROJECT_ID = "atomic-event-time-project";
const EXTRACTOR_VERSION = "atomic-event-time-test";
const TIMEZONE = "UTC";
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

/**
 * The conversation happened on 2026-06-04; the write happens on 2026-09-04, three months later.
 *
 * That gap is the whole test. The defect this file exists for bound the row's `timestamp` from
 * the write clock, and a fixture whose write clock sits on the event date cannot tell the two
 * apart — that masking really happened while the defect was being investigated, and it made a
 * live replay look correct.
 */
const SESSION_MS = Date.UTC(2026, 5, 4, 9, 0);
const WRITE_MS = Date.UTC(2026, 8, 4, 5, 40);
/** A user stating a birth year before 1970. Its epoch is negative, and that must be storable. */
const BIRTH_MS = Date.UTC(1965, 2, 17, 0, 0);

function ledgerKey(suffix: string): AtomicExtractionLedgerKey {
	return {
		conversationId: `conversation-${suffix}`,
		chunkHash: `chunk-${suffix}`,
		pipelineVersion: EXTRACTOR_VERSION,
	};
}

function record(overrides: Partial<AtomicKeyedRecord> = {}): AtomicKeyedRecord {
	return {
		kind: "occurrence",
		category: "episodic",
		claimText: "The user walked 8,004 steps on 2026-06-04.",
		subject: "user",
		subjectKind: "user",
		attribute: null,
		value: "8,004 steps",
		temporalPhrase: "on 2026-06-04",
		resolvedTime: { year: 2026, month: 6, day: 4 },
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote: "I walked 8,004 steps today.", startOffset: 0, endOffset: 27 },
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
		...overrides,
	} as AtomicKeyedRecord;
}

function cardsFor(records: readonly AtomicKeyedRecord[]) {
	return buildAtomicWriteCards({
		records,
		idempotencyKeys: records.map((_, index) => `event-time-key-${index}`),
		sessionTimestampMs: SESSION_MS,
		sourceTurnOffset: 0,
		timezone: TIMEZONE,
	});
}

interface TimeRow {
	text: string;
	timestamp: number;
	valid_from: number | null;
}

function readTimeRows(database: SqliteDatabaseLike): TimeRow[] {
	return database
		.prepare(
			"SELECT text, timestamp, valid_from FROM nodix_memories WHERE project_id = ? ORDER BY text",
		)
		.all(PROJECT_ID) as TimeRow[];
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic row event time", () => {
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

	it("dates a card by its resolved event time, and by the session when there is none", () => {
		const [resolved, unresolved] = cardsFor([
			record(),
			record({
				claimText: "User finished planning the academic conference attendance.",
				value: "finished planning conference attendance",
				temporalPhrase: null,
				resolvedTime: null,
			}),
		]);
		if (!resolved || !unresolved) throw new Error("projection returned no cards");

		expect(resolved.timestamp).toBe(Date.UTC(2026, 5, 4));
		expect(resolved.timestamp).toBe(resolved.validFrom);
		// No resolvable time, so the row falls back to when the conversation happened. This is the
		// shape a live replay produced: an active row with a null valid_from.
		expect(unresolved.validFrom).toBeNull();
		expect(unresolved.timestamp).toBe(SESSION_MS);
	});

	it("stores the event time on the row, not the write clock three months later", async () => {
		const key = ledgerKey("event-time");
		expect(
			store.beginAtomicExtractionChunk({
				...key,
				rawChunk: "user: I walked 8,004 steps today.",
				routingSnapshotId: "routing-event-time",
				runParameters: RUN_PARAMETERS,
				nowMs: WRITE_MS,
			}),
		).toMatchObject({ action: "run" });
		store.recordAtomicExtractionCalls(key, WRITE_MS + 1);

		const result = await store.storeAtomicExtractionChunk({
			ledgerKey: key,
			projectId: PROJECT_ID,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: WRITE_MS + 2,
			cards: cardsFor([record()]),
		});

		expect(result).toMatchObject({ createdCount: 1 });
		const rows = readTimeRows(fixture.runtime.db);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.timestamp).toBe(Date.UTC(2026, 5, 4));
		expect(rows[0]?.timestamp).not.toBe(WRITE_MS + 2);
	});

	it("keeps a pre-1970 event and every other memory in the same chunk", async () => {
		const key = ledgerKey("pre-1970");
		expect(
			store.beginAtomicExtractionChunk({
				...key,
				rawChunk: "user: I was born in March 1965. I walked 8,004 steps today.",
				routingSnapshotId: "routing-pre-1970",
				runParameters: RUN_PARAMETERS,
				nowMs: WRITE_MS,
			}),
		).toMatchObject({ action: "run" });
		store.recordAtomicExtractionCalls(key, WRITE_MS + 1);

		const result = await store.storeAtomicExtractionChunk({
			ledgerKey: key,
			projectId: PROJECT_ID,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: WRITE_MS + 2,
			cards: cardsFor([
				record({
					claimText: "The user was born in March 1965.",
					value: "born March 1965",
					temporalPhrase: "in March 1965",
					resolvedTime: { year: 1965, month: 3, day: 17 },
				}),
				record(),
			]),
		});

		// A non-negative timestamp rule used to throw here and take the steps row down with the
		// birth row, so both rows are asserted, not just the pre-1970 one.
		expect(result).toMatchObject({ createdCount: 2 });
		const rows = readTimeRows(fixture.runtime.db);
		expect(rows.map(({ text, timestamp }) => ({ text, timestamp }))).toEqual([
			{ text: "The user walked 8,004 steps on 2026-06-04.", timestamp: Date.UTC(2026, 5, 4) },
			{ text: "The user was born in March 1965.", timestamp: BIRTH_MS },
		]);
		expect(BIRTH_MS).toBeLessThan(0);
	});
});
