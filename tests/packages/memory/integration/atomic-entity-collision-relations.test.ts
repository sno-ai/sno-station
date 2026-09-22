/** @file atomic-entity-collision-relations.test.ts
 * @purpose A card whose entity id lost the name-registration race is pointed at the winner.
 *   The subject is not the only place the card names an entity: both ends of every relation
 *   carry one too, and a losing id names a row that was never inserted.
 * @boundary The real MemoryStore write over real encrypted SQLite; no model calls.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AtomicKeyedRecord } from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/memory/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import type { MemoryStoreInternals } from "../../../../packages/memory/src/store/memory-store-base";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-entity-collision-project";
const EXTRACTOR_VERSION = "atomic-entity-collision-test";
const SESSION_MS = Date.UTC(2026, 5, 4, 9, 0);
const WRITE_MS = Date.UTC(2026, 5, 4, 10, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};
const NAME = "Atlas Migration";
// A second chunk prepared before the first one wrote mints its own id for the same name. That
// is the race this covers: same normalized name, different id, and the insert ignores the loser.
const LOSING_ID = "entity-that-lost-the-race";
const UNRELATED_ID = "entity-nobody-else-claimed";

function record(overrides: Partial<AtomicKeyedRecord> = {}): AtomicKeyedRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText: `${NAME} is owned by the platform team.`,
		subject: NAME,
		subjectKind: "named_entity",
		attribute: null,
		value: "the platform team",
		temporalPhrase: null,
		resolvedTime: null,
		// The write projection reads `time.kind` for a standing record with no resolved date.
		time: { kind: "none" },
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: 3,
			quote: `${NAME} is owned by the platform team.`,
			startOffset: 0,
			endOffset: 40,
		},
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
		...overrides,
	} as AtomicKeyedRecord;
}

function ledgerKey(suffix: string): AtomicExtractionLedgerKey {
	return {
		conversationId: `conversation-collision-${suffix}`,
		chunkHash: `chunk-collision-${suffix}`,
		pipelineVersion: EXTRACTOR_VERSION,
	};
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic entity registration collision", () => {
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

	async function writeChunk(
		suffix: string,
		subject: string,
		relations: { subject: string; predicate: string; object: string }[],
		registration: { entityId: string; displayName: string; normalizedName: string },
	): Promise<void> {
		const cards = buildAtomicWriteCards({
			records: [record()],
			idempotencyKeys: [`entity-collision-key-${suffix}`],
			sourceTurnOffset: 0,
			sessionTimestampMs: SESSION_MS,
			timezone: "UTC",
		});
		const key = ledgerKey(suffix);
		expect(
			store.beginAtomicExtractionChunk({
				...key,
				rawChunk: `user: ${NAME} is owned by the platform team.`,
				routingSnapshotId: `routing-collision-${suffix}`,
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
			cards: cards.map((card) => ({
				...card,
				subject,
				relations,
			})) as never,
			entities: [registration] as never,
		});
	}

	it("points the subject AND both relation ends at the entity that won the name", async () => {
		const winner = store.resolveAtomicMemoryEntity(PROJECT_ID, NAME);
		expect(winner.registration, "a name never seen before must register").toBeDefined();
		await writeChunk("first", winner.entityId, [], {
			entityId: winner.entityId,
			displayName: NAME,
			normalizedName: winner.registration?.normalizedName ?? "",
		});

		// The losing chunk carries its own id for the same name, in the subject and in a relation.
		await writeChunk(
			"second",
			LOSING_ID,
			[
				{ subject: LOSING_ID, predicate: "WORKS_ON", object: UNRELATED_ID },
			],
			{
				entityId: LOSING_ID,
				displayName: NAME,
				normalizedName: winner.registration?.normalizedName ?? "",
			},
		);

		const internals = store as unknown as MemoryStoreInternals;
		const relations = internals.sqlite
			.prepare("SELECT subject, object FROM nodix_memory_relations")
			.all() as { subject: string; object: string }[];
		expect(relations).toHaveLength(1);
		// The losing id never got a row of its own, so a relation left pointing at it dangles.
		expect(relations[0]?.subject).toBe(winner.entityId);
		// An endpoint nobody else claimed is left exactly as the card stated it.
		expect(relations[0]?.object).toBe(UNRELATED_ID);

		const ids = internals.sqlite
			.prepare("SELECT entity_id FROM nodix_memory_entities WHERE project_id = ?")
			.all(PROJECT_ID) as { entity_id: string }[];
		expect(ids.map((row) => row.entity_id)).toEqual([winner.entityId]);
	});
});
