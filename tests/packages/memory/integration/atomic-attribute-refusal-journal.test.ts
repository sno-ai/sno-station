/** @file atomic-attribute-refusal-journal.test.ts
 * @purpose Proves the write door journals WHY an attribute was refused: unknown slug versus a
 *          real slug of the wrong family for the subject kind.
 * @boundary Deterministic projection plus the real encrypted SQLite write door and journal.
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

const PROJECT_ID = "atomic-attribute-refusal";
const EXTRACTOR_VERSION = "atomic-v3-attribute-refusal-test";
const SESSION_TIMESTAMP_MS = Date.UTC(2026, 8, 5, 16, 50);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

interface JournalRow {
	row_id: string;
	reason: string;
	detail: string;
}

// The two shapes the 2026-09-05 stores actually held (P1 of the defect probe): a slug that exists
// in neither dictionary, and a slug that exists but belongs to the other family for the subject.
function refusedRecord(claimText: string, refusedAttribute: string): AtomicKeyedRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText,
		subject: "user",
		subjectKind: "user",
		attribute: null,
		refusedAttribute,
		value: claimText,
		temporalPhrase: null,
		resolvedTime: null,
		endsCurrent: false,
		endedAt: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote: claimText, startOffset: 0, endOffset: claimText.length },
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
	};
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic attribute refusal journal", () => {
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

	it("names an unknown slug and a wrong-family slug with different reasons", async () => {
		const key: AtomicExtractionLedgerKey = {
			conversationId: "conversation-refusal",
			chunkHash: "chunk-refusal",
			pipelineVersion: EXTRACTOR_VERSION,
		};
		expect(
			store.beginAtomicExtractionChunk({
				...key,
				rawChunk: "raw transcript for refusal",
				routingSnapshotId: "routing-snapshot-refusal",
				runParameters: RUN_PARAMETERS,
				nowMs: SESSION_TIMESTAMP_MS,
			}),
		).toMatchObject({ action: "run", entry: { state: "open" } });
		store.recordAtomicExtractionCalls(key, SESSION_TIMESTAMP_MS + 1);

		const records = [
			refusedRecord("The user loves Joan Crawford.", "preference.arts_culture"),
			refusedRecord("The user's budget is $2,900,000.", "project.budget"),
		];
		const cards = buildAtomicWriteCards({
			records,
			idempotencyKeys: ["refusal-unknown", "refusal-wrong-family"],
			sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			timezone: "UTC",
		});
		const result = await store.storeAtomicExtractionChunk({
			ledgerKey: key,
			projectId: PROJECT_ID,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: SESSION_TIMESTAMP_MS + 2,
			cards,
		});
		expect(result.createdCount).toBe(2);

		const rows = fixture.sqlite
			.prepare(`
				SELECT row_id, reason, detail FROM nodix_rem_journal
				WHERE job_type = 'atomic-extraction' AND stage = 'write' AND outcome = 'refused'
				ORDER BY sequence
			`)
			.all() as JournalRow[];
		expect(rows.map(({ reason, detail }) => ({ reason, detail: JSON.parse(detail) }))).toEqual([
			{
				reason: "attribute_not_in_vocabulary",
				detail: { refusedAttribute: "preference.arts_culture" },
			},
			{
				reason: "attribute_not_allowed_for_subject_kind",
				detail: { refusedAttribute: "project.budget" },
			},
		]);
		expect(rows.map(({ row_id }) => row_id).sort()).toEqual([...result.cardIds].sort());
		// Both rows are stored, both unkeyed: the reason changes nothing about what is written.
		const stored = fixture.sqlite
			.prepare("SELECT attribute FROM nodix_memories WHERE project_id = ? ORDER BY rowid")
			.all(PROJECT_ID) as Array<{ attribute: string | null }>;
		expect(stored).toEqual([{ attribute: null }, { attribute: null }]);
	});
});
