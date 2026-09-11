/** @file atomic-parked-quote-evidence.test.ts
 * @purpose Proves a parked row keeps the quote that failed to match, and an active row keeps its column null.
 * @boundary The real gauntlet, the real write projection and real encrypted SQLite; no model calls.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AtomicExtractionRecord, AtomicExtractionTurn } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import { runAtomicExtractionGauntlet } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import type { AtomicKeyedRecord } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-parked-quote-project";
const EXTRACTOR_VERSION = "atomic-parked-quote-test";
const SESSION_MS = Date.UTC(2026, 5, 4, 9, 0);
const WRITE_MS = Date.UTC(2026, 5, 4, 10, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

const TURNS: AtomicExtractionTurn[] = [
	{ role: "user", content: "I switched my main editor to Emacs last week." },
	{ role: "assistant", content: "Noted. Anything else about your setup?" },
	{ role: "user", content: "The email is to outline strategic research priorities." },
];

/** The quote is real user text, but it lives at turn 2 and the record names turn 1. */
const MISPLACED_QUOTE = "The email is to outline strategic research priorities.";

function extractionRecord(overrides: Partial<AtomicExtractionRecord> = {}): AtomicExtractionRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText: "The user's main editor is Emacs.",
		subject: "user",
		subjectKind: "user",
		attribute: null,
		value: "Emacs",
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: 0,
			quote: "I switched my main editor to Emacs last week.",
		},
		relations: [],
		singleClaim: true,
		...overrides,
	} as AtomicExtractionRecord;
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic parked quote evidence", () => {
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

	it("stores the failed quote on a parked row and leaves an active row's column null", async () => {
		// One record whose quote is in the turn it names, and one whose quote is a whole turn's
		// text from somewhere else — the exact shape a miscounted turn index produces.
		const records = await runAtomicExtractionGauntlet({
			records: [
				extractionRecord(),
				extractionRecord({
					claimText: "The email outlines strategic research priorities.",
					value: "outline strategic research priorities",
					sourceSpan: { turnIndex: 1, quote: MISPLACED_QUOTE },
				}),
			],
			turns: TURNS,
			locale: "en",
		});
		expect(records).toHaveLength(2);

		const active = records[0];
		const parked = records[1];
		if (active === undefined || parked === undefined) throw new Error("gauntlet lost a record");
		expect(active.lane).toBe("active");
		expect(active.unresolvedSourceSpan, "a resolved span leaves no failed quote").toBeUndefined();
		expect(parked.lane).toBe("parked");
		expect(parked.dispositionReason).toBe("subject-unverified");
		expect(parked.sourceSpan).toBeNull();
		expect(parked.unresolvedSourceSpan?.quote).toBe(MISPLACED_QUOTE);
		expect(parked.unresolvedSourceSpan?.turnIndex).toBe(1);

		const cards = buildAtomicWriteCards({
			records: records as AtomicKeyedRecord[],
			idempotencyKeys: records.map((_, index) => `parked-quote-key-${index}`),
			sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_MS,
			timezone: "UTC",
		});
		const key: AtomicExtractionLedgerKey = {
			conversationId: "conversation-parked-quote",
			chunkHash: "chunk-parked-quote",
			pipelineVersion: EXTRACTOR_VERSION,
		};
		expect(
			store.beginAtomicExtractionChunk({
				...key,
				rawChunk: TURNS.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
				routingSnapshotId: "routing-parked-quote",
				runParameters: RUN_PARAMETERS,
				nowMs: WRITE_MS,
			}),
		).toMatchObject({ action: "run" });
		store.recordAtomicExtractionCalls(key, WRITE_MS + 1);
		await store.storeAtomicExtractionChunk({
			ledgerKey: key,
			projectId: PROJECT_ID,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: WRITE_MS + 2,
			cards,
		});

		const rows = store.sqlite
			.prepare(
				"SELECT text, lane, raw_candidate_json AS rawCandidateJson FROM nodix_memories WHERE project_id = ? ORDER BY text",
			)
			.all(PROJECT_ID) as Array<{ text: string; lane: string; rawCandidateJson: string | null }>;
		expect(rows).toHaveLength(2);

		const parkedRow = rows.find((row) => row.lane === "parked");
		const activeRow = rows.find((row) => row.lane === "active");
		expect(parkedRow).toBeDefined();
		expect(activeRow).toBeDefined();
		// The null on an active row is load-bearing: REM reads this column as replace evidence and
		// matches clause values as plain substrings, so a populated one changes replace behaviour.
		expect(activeRow?.rawCandidateJson).toBeNull();

		const candidate = JSON.parse(parkedRow?.rawCandidateJson ?? "null") as {
			sourceSpan: unknown;
			unresolvedSourceSpan?: { turnIndex: number; quote: string };
		};
		expect(candidate.sourceSpan).toBeNull();
		expect(candidate.unresolvedSourceSpan?.quote).toBe(MISPLACED_QUOTE);
		expect(candidate.unresolvedSourceSpan?.turnIndex).toBe(1);
	});
});
