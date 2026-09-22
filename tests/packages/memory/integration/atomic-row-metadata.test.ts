import { calculateCalendarTime } from "../../../../packages/memory/src/engine/extraction/calendar-instruction";
/** @file atomic-row-metadata.test.ts
 * @purpose Proves a stored atomic row's metadata names its own memory category, which every reader of that metadata needs.
 * @boundary The real write projection and real encrypted SQLite through MemoryStore; no model calls.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AtomicKeyedRecord } from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/memory/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-row-metadata-project";
const EXTRACTOR_VERSION = "atomic-row-metadata-test";
const SESSION_MS = Date.UTC(2026, 5, 4, 9, 0);
const WRITE_MS = Date.UTC(2026, 8, 4, 5, 40);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

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
		sourceSpan: {
			turnIndex: 0,
			quote: "I walked 8,004 steps today.",
			startOffset: 0,
			endOffset: 27,
		},
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
		...overrides,
	} as AtomicKeyedRecord;
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic row metadata", () => {
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

	it("names the row's own category in its metadata, to-do rows included", async () => {
		// The to-do record is here on purpose: `todoFactCategory` rewrites an open to-do to
		// `profile` after the model called it episodic, so the metadata copy and the column can
		// disagree unless the metadata is taken from the same value the card carries.
		const records = [
			record(),
			record({
				kind: "standing",
				category: "profile",
				claimText: "The user needs to visit the university library.",
				value: "visit the university library",
				temporalPhrase: null,
				resolvedTime: null,
			}),
			record({
				// A to-do is a standing intention, filed as profile; the card carries the category the
				// pipeline already settled, and the metadata must name that same category.
				kind: "standing",
				category: "profile",
				claimText: "The user needs to prepare lecture materials.",
				value: "prepare lecture materials",
				temporalPhrase: null,
				resolvedTime: null,
				todo: "open",
			}),
		];
		const cards = buildAtomicWriteCards({
			records,
			idempotencyKeys: records.map((_, index) => `metadata-key-${index}`),
			sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_MS,
			timezone: "UTC",
		});
		expect(cards).toHaveLength(3);

		const key: AtomicExtractionLedgerKey = {
			conversationId: "conversation-metadata",
			chunkHash: "chunk-metadata",
			pipelineVersion: EXTRACTOR_VERSION,
		};
		expect(
			store.beginAtomicExtractionChunk({
				...key,
				rawChunk: "user: I walked 8,004 steps today.",
				routingSnapshotId: "routing-metadata",
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
			cards,
		});
		expect(result).toMatchObject({ createdCount: 3 });

		const rows = store.sqlite
			.prepare("SELECT text, category, metadata FROM nodix_memories WHERE project_id = ?")
			.all(PROJECT_ID) as { text: string; category: string; metadata: string }[];
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
			// Both keys, because resolveMemoryCategory reads `kind` first and `memory_category`
			// second and throws when neither is present — which is what made every recall fail.
			expect(metadata.kind, row.text).toBe(row.category);
			expect(metadata.memory_category, row.text).toBe(row.category);
		}
		// The to-do row proves the rewrite is respected rather than the raw record's category.
		// The event day, which is how every reader learns a row is an event on a date rather than a
		// standing fact. The benchmark's answer prompt reads `event_at` (then `valid_from`) out of
		// this metadata and prefixes the memory with `[YYYY-MM-DD]`; a row without it is read as a
		// preference, and a week's total silently excludes it.
		const episodicRow = rows.find(({ text }) => text.includes("8,004 steps"));
		const episodicMetadata = JSON.parse(episodicRow?.metadata ?? "{}") as Record<string, unknown>;
		expect(episodicMetadata.event_at).toBe(new Date(Date.UTC(2026, 5, 4)).toISOString());
		expect(episodicMetadata.valid_from).toBe(Date.UTC(2026, 5, 4));

		// A standing preference gets no day: stamping one misleads a time-scoped question just as
		// much as leaving one off an event does.
		const profileRow = rows.find(({ text }) => text.includes("university library"));
		const profileMetadata = JSON.parse(profileRow?.metadata ?? "{}") as Record<string, unknown>;
		expect(profileMetadata.event_at).toBeUndefined();
		expect(profileMetadata.valid_from).toBeUndefined();

		const todoRow = rows.find(({ text }) => text.includes("lecture materials"));
		expect(todoRow?.category).toBe("profile");
	});
});
