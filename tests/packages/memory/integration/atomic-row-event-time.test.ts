import { calculateCalendarTime } from "../../../../packages/memory/src/engine/extraction/calendar-instruction";
/** @file atomic-row-event-time.test.ts
 * @purpose Proves event time, session time, and write time remain distinct in durable atomic rows.
 * @boundary The real write projection and real encrypted SQLite through MemoryStore; no model calls.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAtomicWriteCards } from "../../../../packages/memory/src/engine/extraction/atomic-write-projection";
import type { AtomicKeyedRecord } from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import type { SqliteDatabaseLike } from "../../../../packages/memory/src/store/sqlite-runtime";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-event-time-project";
const EXTRACTOR_VERSION = "atomic-event-time-test";
const TIMEZONE = "UTC";
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

/** The event precedes the session; persistence happens three months after that session. */
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
		resolvedTime: calculateCalendarTime({ kind: "absolute", year: 2026, month: 6, day: 4, precision: "day" }),
		time: { kind: "absolute", year: 2026, month: 6, day: 4, precision: "day" }, endedTime: { kind: "none" },
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

	it("keeps the session timestamp separate from the resolved event interval", () => {
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

		expect(resolved.timestamp).toBe(SESSION_MS);
		expect(resolved.validFrom).toBe(Date.UTC(2026, 5, 4));
		expect(resolved.timestamp).not.toBe(resolved.validFrom);
		// No resolvable time, so the row falls back to when the conversation happened. This is the
		// shape a live replay produced: an active row with a null valid_from.
		expect(unresolved.validFrom).toBeNull();
		expect(unresolved.timestamp).toBe(SESSION_MS);
	});

	it("stores the session clock and event interval without using the later write clock", async () => {
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
		expect(rows[0]?.timestamp).toBe(SESSION_MS);
		expect(rows[0]?.valid_from).toBe(Date.UTC(2026, 5, 4));
		const stored = store.getById(result.cardIds[0] ?? "");
		expect(JSON.parse(stored?.metadata ?? "{}").source_order.session_moment).toBe(SESSION_MS);
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
					resolvedTime: calculateCalendarTime({ kind: "absolute", year: 1965, month: 3, day: 17, precision: "day" }),
				}),
				record(),
			]),
		});

		// A non-negative timestamp rule used to throw here and take the steps row down with the
		// birth row, so both rows are asserted, not just the pre-1970 one.
		expect(result).toMatchObject({ createdCount: 2 });
		const rows = readTimeRows(fixture.runtime.db);
		expect(rows.map(({ text, timestamp, valid_from }) => ({ text, timestamp, valid_from }))).toEqual([
			{ text: "The user walked 8,004 steps on 2026-06-04.", timestamp: SESSION_MS, valid_from: Date.UTC(2026, 5, 4) },
			{ text: "The user was born in March 1965.", timestamp: SESSION_MS, valid_from: BIRTH_MS },
		]);
		expect(BIRTH_MS).toBeLessThan(0);
	});
});

it("keeps statement timezone separate from event timezone in the durable atomic row", async () => {
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	try {
		const time = { kind: "absolute", year: 2026, month: 6, day: 4, hour: 15, minute: 0, precision: "minute", timezone: "America/Los_Angeles" } as const;
		const cards = buildAtomicWriteCards({ records: [record({ time, resolvedTime: calculateCalendarTime(time) })], idempotencyKeys: ["timezone-separation"], sourceTurnOffset: 0, sessionTimestampMs: SESSION_MS, timezone: "Asia/Tokyo" });
		const key = ledgerKey("timezone-separation");
		store.beginAtomicExtractionChunk({ ...key, rawChunk: "The event was at 15:00 PDT.", routingSnapshotId: "timezone-separation", runParameters: RUN_PARAMETERS, nowMs: WRITE_MS });
		store.recordAtomicExtractionCalls(key, WRITE_MS + 1);
		const result = await store.storeAtomicExtractionChunk({ ledgerKey: key, projectId: PROJECT_ID, extractorVersion: EXTRACTOR_VERSION, nowMs: WRITE_MS + 2, cards });
		const row = store.getById(result.cardIds[0] ?? "");
		expect(row).toMatchObject({ timestamp: SESSION_MS, timezone: "Asia/Tokyo" });
		expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({ temporal_timezone: "America/Los_Angeles", event_at: "2026-06-04T22:00:00.000Z" });
		expect(fixture.sqlite.prepare("SELECT timestamp, timezone FROM nodix_memories WHERE id = ?").get(row?.id)).toEqual({ timestamp: SESSION_MS, timezone: "Asia/Tokyo" });
	} finally { await store.close(); fixture.cleanup(); }
});

it("makes an undated standing fact visible from its statement while an unknown event stays undated", async () => {
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	try {
		const standing = record({ kind: "standing", category: "profile", claimText: "The user prefers tea.", attribute: "preference.food", time: { kind: "none" }, resolvedTime: null });
		const event = record({ claimText: "The user moved to Kyoto at an unknown time.", time: { kind: "unresolved" }, resolvedTime: null });
		const key = ledgerKey("undated-visibility");
		store.beginAtomicExtractionChunk({ ...key, rawChunk: "I prefer tea. I moved to Kyoto.", routingSnapshotId: "undated-visibility", runParameters: RUN_PARAMETERS, nowMs: WRITE_MS });
		store.recordAtomicExtractionCalls(key, WRITE_MS + 1);
		const result = await store.storeAtomicExtractionChunk({ ledgerKey: key, projectId: PROJECT_ID, extractorVersion: EXTRACTOR_VERSION, nowMs: WRITE_MS + 2, cards: cardsFor([standing, event]) });
		const [standingId, eventId] = result.cardIds;
		expect(store.listAtomicValidAt(PROJECT_ID, SESSION_MS).map((row) => row.id)).toEqual([standingId]);
		expect(store.listAtomicValidAt(PROJECT_ID, SESSION_MS - 1)).toEqual([]);
		expect(fixture.sqlite.prepare("SELECT valid_from, valid_until FROM nodix_memories WHERE id = ?").get(standingId)).toEqual({ valid_from: SESSION_MS, valid_until: null });
		expect(fixture.sqlite.prepare("SELECT valid_from, valid_until FROM nodix_memories WHERE id = ?").get(eventId)).toEqual({ valid_from: null, valid_until: null });
	} finally { await store.close(); fixture.cleanup(); }
});

it("keeps same-session standing claims in source order when the later claim names today", async () => {
	const { readAtomicArrivalRetirementCandidateSet } = await import("../../../../packages/memory/src/store/memory-store-atomic-extraction-write-api");
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	try {
		async function writeClaim(turn: number, city: string, time: Parameters<typeof calculateCalendarTime>[0]) {
			const resolvedTime = calculateCalendarTime(time, new Date(SESSION_MS).toISOString(), "UTC");
			const input = record({ kind: "standing", category: "profile", claimText: `The user lives in ${city}.`, attribute: "identity.location", value: city, time, resolvedTime });
			const cards = buildAtomicWriteCards({ records: [input], idempotencyKeys: [`standing-order-${turn}`], sourceTurnOffset: turn, sessionTimestampMs: SESSION_MS, timezone: "UTC" });
			const key = { ...ledgerKey(`standing-order-${turn}`), conversationId: "same-session-standing-order" };
			store.beginAtomicExtractionChunk({ ...key, rawChunk: input.claimText, routingSnapshotId: "standing-order", runParameters: RUN_PARAMETERS, nowMs: WRITE_MS + turn * 3 });
			store.recordAtomicExtractionCalls(key, WRITE_MS + turn * 3 + 1);
			const written = await store.storeAtomicExtractionChunk({ ledgerKey: key, projectId: PROJECT_ID, extractorVersion: EXTRACTOR_VERSION, nowMs: WRITE_MS + turn * 3 + 2, cards });
			const id = written.cardIds[0];
			if (!id) throw new Error("standing claim was not stored");
			return id;
		}
		const olderId = await writeClaim(0, "Kyoto", { kind: "none" });
		const newerId = await writeClaim(1, "Osaka", { kind: "relative", amount: 0, unit: "day", precision: "day" });
		// This internal reader consumes the real store's SQLite, mutex and embedding resources.
		const readerStore = store as unknown as Parameters<typeof readAtomicArrivalRetirementCandidateSet>[0];
		const candidates = await readAtomicArrivalRetirementCandidateSet(readerStore, { projectId: PROJECT_ID, nominatedRowId: newerId, jobId: "standing-order" });
		expect(candidates?.candidateRows.map((row) => row.id)).toContain(olderId);
		expect(fixture.sqlite.prepare("SELECT valid_from FROM nodix_memories WHERE id = ?").get(newerId)).toEqual({ valid_from: SESSION_MS });
		expect(JSON.parse(store.getById(newerId)?.metadata ?? "{}")).toMatchObject({ valid_from: SESSION_MS, temporal_date: "2026-06-04", temporal_precision: "day", temporal_timezone: "UTC" });
		const historicalId = await writeClaim(2, "Nara", { kind: "relative", amount: -1, unit: "day", precision: "day" });
		expect(fixture.sqlite.prepare("SELECT valid_from FROM nodix_memories WHERE id = ?").get(historicalId)).toEqual({ valid_from: Date.UTC(2026, 5, 3) });
		expect(JSON.parse(store.getById(historicalId)?.metadata ?? "{}")).toMatchObject({ valid_from: Date.UTC(2026, 5, 3), temporal_date: "2026-06-03" });
		const historicalCandidates = await readAtomicArrivalRetirementCandidateSet(readerStore, { projectId: PROJECT_ID, nominatedRowId: historicalId, jobId: "standing-order-historical" });
		expect(historicalCandidates?.candidateRows).toEqual([]);
	} finally { await store.close(); fixture.cleanup(); }
});
