/** @file PRD 150 review repairs — extraction projection: an unplaceable phrase gets no date.
 *
 * @boundary The real projection (`buildAtomicWriteCards`) feeding the real chunk write over a
 * real encrypted SQLite store; every assertion reads the row back from the store.
 *
 * The defect: an episodic record whose temporal phrase the resolver could not place — "last
 * summer" with no resolved time — was stamped with the session's date as its event date, so a
 * memory of last summer read as an event of the day it was mentioned. The repair keeps the phrase
 * and writes no `event_at` / `valid_from`; a record with no phrase at all still keeps the session
 * date, which is the control that shows the guard is selective and not dead.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AtomicKeyedRecord } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const PROJECT_ID = "persona:group-crud-review-projection";
const EXTRACTOR_VERSION = "group-crud-review-projection";
/** The conversation's day: 1 June 2026, 09:00 UTC. "Last summer" is not this day. */
const SESSION_MS = Date.UTC(2026, 5, 1, 9, 0);
const WRITE_MS = Date.UTC(2026, 8, 5, 5, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

interface EpisodicSeed {
	label: string;
	text: string;
	temporalPhrase: string | null;
	turn: number;
}

function episodicRecord(seed: EpisodicSeed): AtomicKeyedRecord {
	return {
		category: "episodic",
		kind: "occurrence",
		claimText: seed.text,
		subject: "user",
		subjectKind: "user",
		attribute: null,
		value: seed.text,
		temporalPhrase: seed.temporalPhrase,
		// The resolver could not place the phrase: no resolved time, and the phrase kept.
		resolvedTime: null,
		endsCurrent: false,
		endedAt: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: seed.turn,
			quote: seed.text,
			startOffset: 0,
			endOffset: seed.text.length,
		},
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
	};
}

interface StoredRow {
	id: string;
	timestamp: number;
	validFrom: number | null;
	validUntil: number | null;
	metadata: Record<string, unknown>;
}

async function writeAndRead(seeds: readonly EpisodicSeed[]): Promise<Map<string, StoredRow>> {
	const fixture: TestDb = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	cleanups.push(async () => {
		await store.close();
		fixture.cleanup();
	});
	const key: AtomicExtractionLedgerKey = {
		conversationId: "conversation-projection",
		chunkHash: "chunk-projection",
		pipelineVersion: EXTRACTOR_VERSION,
	};
	expect(
		store.beginAtomicExtractionChunk({
			...key,
			rawChunk: seeds.map((seed) => `user: ${seed.text}`).join("\n"),
			routingSnapshotId: "routing-group-crud-review-projection",
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
		cards: buildAtomicWriteCards({
			records: seeds.map(episodicRecord),
			idempotencyKeys: seeds.map((seed) => `group-crud-review-projection-${seed.label}`),
			sessionTimestampMs: SESSION_MS,
			sourceTurnOffset: 0,
			timezone: "UTC",
		}),
	});
	expect(result.cardIds, "not every record was written").toHaveLength(seeds.length);
	const rows = new Map<string, StoredRow>();
	for (const [index, seed] of seeds.entries()) {
		const rowId = result.cardIds[index];
		if (rowId === undefined) throw new Error(`no row for ${seed.label}`);
		const row = fixture.sqlite
			.prepare(
				`SELECT id, timestamp, valid_from AS validFrom, valid_until AS validUntil, metadata
				FROM nodix_memories WHERE id = ?`,
			)
			.get(rowId) as Omit<StoredRow, "metadata"> & { metadata: string };
		rows.set(seed.label, { ...row, metadata: JSON.parse(row.metadata) as Record<string, unknown> });
	}
	return rows;
}

describe("PRD 150 review — an episodic record with an unplaceable phrase carries no event date", () => {
	it(
		"writes 'last summer' with no event_at or valid_from, and a phrase-less record with the session date",
		{ timeout: 180_000 },
		async () => {
			const rows = await writeAndRead([
				{
					label: "cabin-last-summer",
					text: "The user stayed at a lakeside cabin in Vermont last summer.",
					temporalPhrase: "last summer",
					turn: 1,
				},
				{
					label: "dentist-booked",
					text: "The user booked a dentist appointment at the Elm Street clinic.",
					temporalPhrase: null,
					turn: 3,
				},
			]);
			const cabin = rows.get("cabin-last-summer");
			const dentist = rows.get("dentist-booked");
			if (cabin === undefined || dentist === undefined) throw new Error("rows missing");

			// The unplaceable phrase: kept as a phrase, dated to nothing.
			expect(cabin.metadata["temporal_phrase"]).toBe("last summer");
			expect(
				cabin.metadata["event_at"],
				"a memory of last summer was dated to the day it was mentioned",
			).toBeUndefined();
			expect(cabin.metadata["valid_from"]).toBeUndefined();
			expect(cabin.metadata["valid_until"]).toBeUndefined();
			expect(cabin.validFrom).toBeNull();
			expect(cabin.validUntil).toBeNull();
			// The row's own clock still falls back to the session, never to the write clock.
			expect(cabin.timestamp).toBe(SESSION_MS);

			// The control: no phrase at all means the thing happened in this conversation.
			expect(dentist.metadata["temporal_phrase"]).toBeUndefined();
			expect(
				dentist.metadata["event_at"],
				"a phrase-less episodic record lost its session date, so the guard is not selective",
			).toBe(new Date(SESSION_MS).toISOString());
			expect(dentist.metadata["valid_from"]).toBe(SESSION_MS);
			expect(dentist.timestamp).toBe(SESSION_MS);
		},
	);
});
