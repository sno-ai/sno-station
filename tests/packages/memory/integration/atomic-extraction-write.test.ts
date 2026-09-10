/** @file atomic-extraction-write.test.ts
 * @purpose Proves atomic-card arrival, replay, rollback, and deferred text immutability.
 * @boundary Real encrypted SQLite through MemoryStore and the isolated cutover trigger helper.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "@/extraction/embedding-provider-client";
import {
	ATOMIC_MEMORY_TEXT_IMMUTABILITY_TRIGGER,
	installAtomicMemoryTextImmutabilityTrigger,
} from "@/storage/atomic-memory-cutover-sql";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	type AtomicExtractionWriteCard,
	MemoryStore,
} from "@/storage/store";
import type { SqliteDatabaseLike } from "@/storage/sqlite-runtime";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

const PROJECT_ID = "atomic-write-project";
const EXTRACTOR_VERSION = "atomic-v3-test";
const CARD_TEXT = "The user lives in Kyoto.";
/**
 * When the remembered move happened — 2026-06-04, and deliberately nowhere near the tiny write
 * clocks these cases pass as `nowMs`. The row's `timestamp` used to be bound from that write
 * clock, so a card whose event time matched it proved nothing.
 */
const EVENT_MS = Date.UTC(2026, 5, 4, 9, 30);

interface CountRow {
	count: number;
}

interface LedgerStateRow {
	state: string;
}

interface StoredAtomicRow {
	id: string;
	text: string;
	category: string;
	project_id: string;
	subject: string | null;
	attribute: string | null;
	maturity: string | null;
	source: string | null;
	extractor_version: string | null;
	lane: string;
	metadata: string;
	timestamp: number;
}

function ledgerKey(suffix: string): AtomicExtractionLedgerKey {
	return {
		conversationId: `conversation-${suffix}`,
		chunkHash: `chunk-${suffix}`,
		pipelineVersion: EXTRACTOR_VERSION,
	};
}

function readCount(database: SqliteDatabaseLike, sql: string, ...parameters: unknown[]): number {
	return (database.prepare(sql).get(...parameters) as CountRow).count;
}

function readLedgerState(
	database: SqliteDatabaseLike,
	key: AtomicExtractionLedgerKey,
): string | undefined {
	return (
		database
			.prepare(
				"SELECT state FROM nodix_atomic_extraction_ledger WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?",
			)
			.get(key.conversationId, key.chunkHash, key.pipelineVersion) as LedgerStateRow | undefined
	)?.state;
}

function beginRecordedChunk(
	store: MemoryStore,
	database: SqliteDatabaseLike,
	key: AtomicExtractionLedgerKey,
	nowMs: number,
): void {
	expect(
		store.beginAtomicExtractionChunk({
			...key,
			rawChunk: `raw transcript for ${key.chunkHash}`,
			routingSnapshotId: "routing-snapshot-atomic-write",
			runParameters: RUN_PARAMETERS,
			nowMs,
		}),
	).toMatchObject({ action: "run", entry: { state: "open" } });
	store.recordAtomicExtractionCalls(key, nowMs + 1);
	expect(readLedgerState(database, key)).toBe("calls_recorded");
}

function card(idempotencyKey: string): AtomicExtractionWriteCard {
	return {
		idempotencyKey,
		// The write stamps this into the row's order key, so every card must name its turn.
		globalTurnIndex: 0,
		// This card states no ending, so it is written live.
		endsCurrent: false,
		endedAt: null,
		text: CARD_TEXT,
		category: "episodic",
		subject: "user",
		attribute: "identity.location",
		timestamp: EVENT_MS,
		validFrom: null,
		validUntil: null,
		importance: 0.8,
		timezone: "Asia/Tokyo",
		lane: "active",
		dispositionReason: null,
		rawCandidateJson: null,
		metadata: { value: "Kyoto" },
		relations: [{ subject: "user", predicate: "LOCATED_AT", object: "Kyoto" }],
	};
}

function readAtomicRows(database: SqliteDatabaseLike): StoredAtomicRow[] {
	return database
		.prepare(
			`SELECT id, text, category, project_id, subject, attribute, maturity, source,
				extractor_version, lane, metadata, timestamp
			FROM nodix_memories
			WHERE project_id = ?
			ORDER BY id`,
		)
		.all(PROJECT_ID) as StoredAtomicRow[];
}

function readRawRow(database: SqliteDatabaseLike, id: string): Record<string, unknown> {
	const row = database
		.prepare(
			`SELECT *, hex(CAST(text AS BLOB)) AS text_bytes,
				hex(CAST(metadata AS BLOB)) AS metadata_bytes,
				hex(CAST(content_hash AS BLOB)) AS content_hash_bytes
			FROM nodix_memories WHERE id = ?`,
		)
		.get(id) as Record<string, unknown> | undefined;
	if (!row) throw new Error(`missing atomic row ${id}`);
	return row;
}

function hasTextTrigger(database: SqliteDatabaseLike): boolean {
	return (
		readCount(
			database,
			"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = ?",
			ATOMIC_MEMORY_TEXT_IMMUTABILITY_TRIGGER,
		) === 1
	);
}

async function writeOneCard(
	store: MemoryStore,
	database: SqliteDatabaseLike,
	suffix: string,
	nowMs: number,
): Promise<string> {
	const key = ledgerKey(suffix);
	beginRecordedChunk(store, database, key, nowMs);
	const result = await store.storeAtomicExtractionChunk({
		ledgerKey: key,
		projectId: PROJECT_ID,
		extractorVersion: EXTRACTOR_VERSION,
		nowMs: nowMs + 2,
		cards: [card(`idempotency-${suffix}`)],
	});
	expect(result).toMatchObject({ createdCount: 1 });
	expect(result.ledger.state).toBe("complete");
	const id = result.cardIds[0];
	if (!id) throw new Error("atomic write returned no card id");
	return id;
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic extraction write", () => {
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

	it("creates one open card per arrival and refuses a key it has already written", async () => {
		const firstKey = ledgerKey("first-arrivals");
		const cards = [card("arrival-one"), card("arrival-two")];
		beginRecordedChunk(store, fixture.runtime.db, firstKey, 10);

		const first = await store.storeAtomicExtractionChunk({
			ledgerKey: firstKey,
			projectId: PROJECT_ID,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: 12,
			cards,
		});

		expect(first).toMatchObject({ createdCount: cards.length });
		expect(first.ledger.state).toBe("complete");
		expect(new Set(first.cardIds).size).toBe(cards.length);
		const rows = readAtomicRows(fixture.runtime.db);
		expect(rows).toHaveLength(cards.length);
		for (const row of rows) {
			expect(row).toMatchObject({
				text: CARD_TEXT,
				category: "episodic",
				project_id: PROJECT_ID,
				subject: "user",
				attribute: "identity.location",
				maturity: "extracted",
				source: "edge",
				extractor_version: EXTRACTOR_VERSION,
				lane: "active",
				// The event's own time, not the write clock this call passed as `nowMs` (12).
				timestamp: EVENT_MS,
			});
			const metadata = JSON.parse(row.metadata) as {
				idempotency_key?: string;
				value?: string;
				invalidated_at?: number;
			};
			expect(metadata.value).toBe("Kyoto");
			expect(metadata.invalidated_at).toBeUndefined();
		}
		expect(rows.map(({ metadata }) => JSON.parse(metadata).idempotency_key).sort()).toEqual([
			"arrival-one",
			"arrival-two",
		]);
		expect(
			readCount(
				fixture.runtime.db,
				"SELECT COUNT(*) AS count FROM nodix_memory_chunks WHERE memory_id IN (SELECT id FROM nodix_memories WHERE project_id = ?)",
				PROJECT_ID,
			),
		).toBe(cards.length);
		expect(
			readCount(
				fixture.runtime.db,
				"SELECT COUNT(DISTINCT memory_id) AS count FROM nodix_memory_chunks WHERE memory_id IN (SELECT id FROM nodix_memories WHERE project_id = ?)",
				PROJECT_ID,
			),
		).toBe(cards.length);
		expect(
			readCount(
				fixture.runtime.db,
				"SELECT COUNT(*) AS count FROM nodix_memory_relations WHERE source_card_id IN (SELECT id FROM nodix_memories WHERE project_id = ?)",
				PROJECT_ID,
			),
		).toBe(cards.length);
		expect(readLedgerState(fixture.runtime.db, firstKey)).toBe("complete");

		const beforeReplay = new Map(
			first.cardIds.map((id) => [id, readRawRow(fixture.runtime.db, id)]),
		);
		// A key that already exists is an identity defect, not a replay: the write refuses it
		// loudly and the transaction leaves nothing behind, instead of mapping the new card onto
		// the old row and counting it as skipped.
		const secondKey = ledgerKey("same-key-again");
		beginRecordedChunk(store, fixture.runtime.db, secondKey, 20);
		await expect(
			store.storeAtomicExtractionChunk({
				ledgerKey: secondKey,
				projectId: PROJECT_ID,
				extractorVersion: EXTRACTOR_VERSION,
				nowMs: 22,
				cards,
			}),
		).rejects.toThrow(/idempotency key already written/);
		expect(readLedgerState(fixture.runtime.db, secondKey)).toBe("calls_recorded");
		expect(readAtomicRows(fixture.runtime.db)).toHaveLength(cards.length);
		for (const [id, snapshot] of beforeReplay) {
			expect(readRawRow(fixture.runtime.db, id)).toEqual(snapshot);
		}
		expect(
			readCount(fixture.runtime.db, "SELECT COUNT(*) AS count FROM nodix_memory_chunks"),
		).toBe(cards.length);
		expect(
			readCount(fixture.runtime.db, "SELECT COUNT(*) AS count FROM nodix_memory_relations"),
		).toBe(cards.length);
		expect(readLedgerState(fixture.runtime.db, secondKey)).toBe("calls_recorded");
	});

	it("rolls back the card, chunk, relation, and ledger completion on relation failure", async () => {
		const key = ledgerKey("relation-failure");
		const duplicateRelation = { subject: "user", predicate: "PREFERS", object: "tea" } as const;
		const failingCard: AtomicExtractionWriteCard = {
			...card("relation-failure-card"),
			relations: [duplicateRelation, duplicateRelation],
		};
		beginRecordedChunk(store, fixture.runtime.db, key, 30);

		await expect(
			store.storeAtomicExtractionChunk({
				ledgerKey: key,
				projectId: PROJECT_ID,
				extractorVersion: EXTRACTOR_VERSION,
				nowMs: 32,
				cards: [failingCard],
			}),
		).rejects.toThrow();

		expect(readCount(fixture.runtime.db, "SELECT COUNT(*) AS count FROM nodix_memories")).toBe(0);
		expect(readCount(fixture.runtime.db, "SELECT COUNT(*) AS count FROM nodix_memory_chunks")).toBe(
			0,
		);
		expect(
			readCount(fixture.runtime.db, "SELECT COUNT(*) AS count FROM nodix_memory_relations"),
		).toBe(0);
		expect(readLedgerState(fixture.runtime.db, key)).toBe("calls_recorded");
	});

	it("keeps the cutover trigger dark except on an isolated copy store", async () => {
		const originalId = await writeOneCard(store, fixture.runtime.db, "original", 40);
		expect(hasTextTrigger(fixture.runtime.db)).toBe(false);
		await expect(store.update(originalId, { text: "Changed in place." })).rejects.toThrow(
			/Atomic memory text is immutable/u,
		);
		await store.updateMetadata(originalId, { bad_recall_count: 1 });
		const originalMetadata = JSON.parse(
			(readAtomicRows(fixture.runtime.db)[0]?.metadata ?? "{}"),
		) as { idempotency_key?: string; bad_recall_count?: number };
		expect(originalMetadata).toMatchObject({
			idempotency_key: "idempotency-original",
			bad_recall_count: 1,
		});

		const isolatedCopy = createTestDb();
		const isolatedStore = new MemoryStore({ dbPath: isolatedCopy.dbPath, embedder });
		try {
			const isolatedId = await writeOneCard(
				isolatedStore,
				isolatedCopy.runtime.db,
				"isolated-copy",
				50,
			);
			installAtomicMemoryTextImmutabilityTrigger(isolatedCopy.runtime.db);
			expect(hasTextTrigger(isolatedCopy.runtime.db)).toBe(true);
			await expect(isolatedStore.update(isolatedId, { text: "Changed through API." })).rejects
				.toThrow(/Atomic memory text is immutable/u);
			expect(() =>
				isolatedCopy.runtime.db
					.prepare("UPDATE nodix_memories SET text = ? WHERE id = ?")
					.run("Changed through SQL.", isolatedId),
			).toThrow(/nodix_memories\.text is immutable/u);
			expect(
				isolatedCopy.runtime.db
					.prepare("SELECT text FROM nodix_memories WHERE id = ?")
					.get(isolatedId),
			).toEqual({ text: CARD_TEXT });
		} finally {
			await isolatedStore.close();
			isolatedCopy.cleanup();
		}

		expect(hasTextTrigger(fixture.runtime.db)).toBe(false);
		expect(
			fixture.runtime.db.prepare("SELECT text FROM nodix_memories WHERE id = ?").get(originalId),
		).toEqual({ text: CARD_TEXT });
	});
});
