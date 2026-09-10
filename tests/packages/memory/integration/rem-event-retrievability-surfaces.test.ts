/** @file rem-event-retrievability-surfaces.test.ts
 * @purpose Pins where each REM action decides event-fact safety: the rewrite against its own two
 *          surfaces, the close against the row that carries the event onto the aggregation path.
 * @boundary Real encrypted SQLite, real lane and soft-close mutations; no substitute retrieval.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import {
	decideRemUpdateVerification,
	decideReplaceCoverage,
} from "../../../../packages/rem-core/src/index.ts";
import { createLlmClient } from "../../../../apps/mem-claw/src/shared/llm-client.ts";
import {
	createMemClawRemPorts,
	createRemReplaceCarrierPort,
} from "../../../../apps/mem-claw/src/storage/rem-sqlite-adapter.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";

const OLDER = "The researcher bought coffee for $6.50 at Blue Bottle on 2026-08-08.";
const NEWER = "Coffee at Blue Bottle cost six dollars fifty on August eighth.";
const PROJECT = "agent:rem-retrievability-runtime";
const TIMESTAMP = "2026-08-08T12:00:00.000Z";
let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("ACC-6 close-side carrier state", () => {
	let testDb: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(async () => {
		await store?.close();
		testDb?.cleanup();
		store = undefined;
		testDb = undefined;
	});

	it("retains a carrier that is active, unsuperseded and on the current facet", async () => {
		const seeded = await seed();
		await expect(carrierFor(seeded).carrierState()).resolves.toEqual({ retained: true });
	});

	it("refuses a carrier the wave has parked out of the active lane", async () => {
		const seeded = await seed();
		const moved = await portsFor(seeded).forget.moveLane({
			rowId: seeded.newer.id,
			plannedContentHash: seeded.newer.contentHash,
			targetLane: "parked",
			reason: "The carrier was parked before this close could be decided.",
			timestamp: TIMESTAMP,
		});
		expect(moved.applied).toBe(true);

		await expect(carrierFor(seeded).carrierState()).resolves.toEqual({
			retained: false,
			fault: "carrier_inactive",
		});
	});

	it("refuses a carrier an earlier pair in the same batch already closed", async () => {
		const seeded = await seed();
		const successor = await seeded.store.store({
			text: "Coffee at Blue Bottle now costs seven dollars.",
			category: "episodic",
			projectId: PROJECT,
			importance: 0.8,
		});
		const closed = await portsFor(seeded).conflict.softClose({
			rowId: seeded.newer.id,
			successorId: successor.id,
			plannedContentHash: seeded.newer.contentHash,
			plannedSuccessorContentHash: successor.contentHash,
			reason: "An earlier pair in this batch closed the carrier.",
			timestamp: TIMESTAMP,
		});
		expect(closed.applied).toBe(true);

		await expect(carrierFor(seeded).carrierState()).resolves.toEqual({
			retained: false,
			fault: "carrier_superseded",
		});
	});

	it("refuses a carrier a category-filtered counting question never returns beside the loser", async () => {
		const seeded = await seed();
		await expect(
			createRemReplaceCarrierPort({
				database: seeded.testDb.runtime.db,
				winnerRowId: seeded.newer.id,
				loserRowId: seeded.older.id,
				loserProjectId: PROJECT,
				loserCategory: "persona",
			}).carrierState(),
		).resolves.toEqual({ retained: false, fault: "carrier_out_of_aggregation_scope" });
	});

	it("refuses a carrier row that does not exist", async () => {
		const seeded = await seed();
		await expect(
			createRemReplaceCarrierPort({
				database: seeded.testDb.runtime.db,
				winnerRowId: "row-that-was-never-written",
				loserRowId: seeded.older.id,
				loserProjectId: PROJECT,
				loserCategory: "episodic",
			}).carrierState(),
		).resolves.toEqual({ retained: false, fault: "carrier_missing" });
	});

	it("allows an event-fact close whose carrier is retained, and names the fault when it is not", async () => {
		const seeded = await seed();
		const atoms = [{ clauseIndex: 0, class: "event-fact" as const, status: "covered" as const }];
		await expect(
			decideReplaceCoverage({
				older: OLDER,
				newer: NEWER,
				retiringClauseIndices: [0],
				atoms,
				carrier: carrierFor(seeded),
			}),
		).resolves.toMatchObject({ decision: "allow" });

		const moved = await portsFor(seeded).forget.moveLane({
			rowId: seeded.newer.id,
			plannedContentHash: seeded.newer.contentHash,
			targetLane: "parked",
			reason: "The carrier was parked before this close could be decided.",
			timestamp: TIMESTAMP,
		});
		expect(moved.applied).toBe(true);

		await expect(
			decideReplaceCoverage({
				older: OLDER,
				newer: NEWER,
				retiringClauseIndices: [0],
				atoms,
				carrier: carrierFor(seeded),
			}),
		).resolves.toMatchObject({
			decision: "refuse",
			reason: "event_not_retrievable",
			detail: "carrier_inactive",
		});
	});

	async function seed(): Promise<{
		testDb: TestDb;
		store: MemoryStore;
		older: { id: string; contentHash: string };
		newer: { id: string; contentHash: string };
	}> {
		const createdDb = createTestDb();
		testDb = createdDb;
		const createdStore = new MemoryStore({ dbPath: createdDb.dbPath, embedder });
		store = createdStore;
		const older = await createdStore.store({
			text: OLDER,
			category: "episodic",
			projectId: PROJECT,
			importance: 0.8,
		});
		const newer = await createdStore.store({
			text: NEWER,
			category: "episodic",
			projectId: PROJECT,
			importance: 0.8,
		});
		return { testDb: createdDb, store: createdStore, older, newer };
	}
});

describe("ACC-6 rewrite-side event-fact surfaces", () => {
	it("allows an event fact when the model accounts for every source fact", () => {
		expect(
			decideRemUpdateVerification(
				'{"faithful":true,"retired_absent":true,"all_facts_accounted":true}',
			),
		).toEqual({ outcome: "apply" });
	});

	it("refuses an event fact the model says was lost", () => {
		expect(
			decideRemUpdateVerification(
				'{"faithful":true,"retired_absent":true,"all_facts_accounted":false}',
			),
		).toEqual({ outcome: "refuse", reason: "surviving_fact_lost" });
	});

	it("refuses an invalid model reply without a string fallback", () => {
		expect(decideRemUpdateVerification("not-json")).toEqual({
			outcome: "refuse",
			reason: "model_response_invalid",
		});
	});
});

function carrierFor(seeded: {
	testDb: TestDb;
	older: { id: string };
	newer: { id: string };
}) {
	return createRemReplaceCarrierPort({
		database: seeded.testDb.runtime.db,
		winnerRowId: seeded.newer.id,
		loserRowId: seeded.older.id,
		loserProjectId: PROJECT,
		loserCategory: "episodic",
	});
}

function portsFor(seeded: { testDb: TestDb }) {
	return createMemClawRemPorts({
		database: seeded.testDb.runtime.db,
		llmClient: createLlmClient({
			preset: "mem_claw/sno_conflict_verdict",
			baseURL: "http://localhost:8070/codex/v1",
		}),
	});
}
