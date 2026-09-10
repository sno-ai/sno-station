/** @file atomic-entity-name-resolution.test.ts
 * @purpose Proves the two real shapes one dictated document is named by gather onto a single entity.
 * @boundary The real MemoryStore entity resolution over real encrypted SQLite; no model calls.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AtomicKeyedRecord } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const PROJECT_ID = "atomic-entity-name-project";
const EXTRACTOR_VERSION = "atomic-entity-name-test";
const SESSION_MS = Date.UTC(2026, 5, 4, 9, 0);
const WRITE_MS = Date.UTC(2026, 5, 4, 10, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

/**
 * Both names of one email, copied from the Memora corpus. Session 24 states it plainly; session 83
 * states the same phrase quoted, with the full stop inside the quotes. Resolution matches on the
 * exact name or the normalized one and has no fuzzy fallback, so before the fix these produced two
 * entities and the email's fields never gathered under one id.
 */
const PLAIN_NAME = "To outline strategic research priorities for enhancing digital accessibility in healthcare";
const QUOTED_NAME = "'To outline strategic research priorities for enhancing digital accessibility in healthcare.'";

function record(overrides: Partial<AtomicKeyedRecord> = {}): AtomicKeyedRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText: `The '${PLAIN_NAME}' email is addressed to the Non-profit Leadership Team.`,
		subject: PLAIN_NAME,
		subjectKind: "named_entity",
		attribute: null,
		value: "Non-profit Leadership Team",
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: 7,
			quote: "The email will be sent to the Non-profit Leadership Team.",
			startOffset: 0,
			endOffset: 56,
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

describe("atomic entity name resolution", () => {
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

	it("gathers a quoted, full-stopped repeat of a name onto the entity already registered", async () => {
		const first = store.resolveAtomicMemoryEntity(PROJECT_ID, PLAIN_NAME);
		expect(first.registration, "a name never seen before must register").toBeDefined();

		// Registration only reaches the table through a write, which is how the pipeline does it.
		const records = [record()];
		const cards = buildAtomicWriteCards({
			records,
			idempotencyKeys: ["entity-name-key-0"],
			sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_MS,
			timezone: "UTC",
		});
		const key: AtomicExtractionLedgerKey = {
			conversationId: "conversation-entity-name",
			chunkHash: "chunk-entity-name",
			pipelineVersion: EXTRACTOR_VERSION,
		};
		expect(
			store.beginAtomicExtractionChunk({
				...key,
				rawChunk: "user: The email will be sent to the Non-profit Leadership Team.",
				routingSnapshotId: "routing-entity-name",
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
			cards: cards.map((card) => ({ ...card, subject: first.entityId })),
			...(first.registration ? { entities: [first.registration] } : {}),
		});

		const second = store.resolveAtomicMemoryEntity(PROJECT_ID, QUOTED_NAME);
		expect(second.entityId).toBe(first.entityId);
		expect(second.registration, "the second shape must not mint a second entity").toBeUndefined();
	});

	it("keeps an apostrophe that is part of the name", () => {
		// An apostrophe is a letter's neighbour here, not a wrapper. Stripping it would merge
		// "O'Brien" with "OBrien" and split it from itself across sessions.
		const brien = store.resolveAtomicMemoryEntity(PROJECT_ID, "O'Brien");
		const proposal = store.resolveAtomicMemoryEntity(PROJECT_ID, "the user's proposal");
		expect(brien.registration?.normalizedName).toBe("o'brien");
		expect(proposal.registration?.normalizedName).toBe("the user's proposal");
		expect(brien.entityId).not.toBe(proposal.entityId);
	});

	it("never normalizes a non-empty name down to nothing", () => {
		// An empty normalized name would collide every such entity into one id.
		for (const name of ["'...'", "。", "\"\"", "!!!"]) {
			const resolved = store.resolveAtomicMemoryEntity(PROJECT_ID, name);
			expect(resolved.registration?.normalizedName, name).not.toBe("");
			expect(resolved.entityId, name).toBeTruthy();
		}
	});
});
