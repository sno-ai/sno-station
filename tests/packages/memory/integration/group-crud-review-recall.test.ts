/** @file PRD 150 review repairs — recall: where a group is expanded, and what counts as a group.
 *
 * @boundary The real manual-recall entry (`retrieveForMemoryRecallOrEval`) over a real retriever
 * and a real encrypted SQLite store whose rows were written through the real chunk write, with
 * real embeddings. Nothing is substituted; the scoring knobs are pinned permissive so membership
 * and order are decided by the group logic under test and not by a rerank or a recency term.
 *
 * Two of the review's defects live here, each one clause:
 *
 * 6. a group was hoisted to the top of the served list however low its first hit ranked, and its
 *    newest row was pulled above stronger hits (`orderExpandedRecallRows` expands a group at its
 *    first hit's rank);
 * 7. rows with no attribute were merged into one group per subject and the whole open population
 *    of that "group" was served (`readRetrievedGroupRows` reads `attribute IS NOT NULL`).
 *
 * The third recall repair — an aggregation recall is not filtered by the minimum score floor —
 * has no clause here on purpose. The aggregation read (`searchAggregationEvidence`) assigns every
 * row `score: 1` and nothing rescores it before the tool, so the floor can never cut a row on the
 * real path; a test of it would pass with the repair reverted and would prove nothing.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AtomicKeyedRecord } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-profile-keying";
import { buildAtomicWriteCards } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import {
	retrieveForAutoRecall,
	retrieveForMemoryRecallOrEval,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/rem-consumer-retrieval";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import type { MemoryRetriever } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever";
import type { RetrievalResult } from "../../../../packages/sno-station-mem/src/engine/shared/types";
import {
	closeMemoryRow,
	readMemorySourceOrderOrOldest,
} from "../../../../packages/sno-station-mem/src/store/memory-source-order";
import { applyStateCategoryMigration } from "../../../../packages/sno-station-mem/src/store/state-category-migration";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const EXTRACTOR_VERSION = "group-crud-review-recall";
const PROPOSAL = "entity:project_proposal_1";
/** A `many`-ruled slug, so every stakeholder row of the proposal stays open beside the others. */
const STAKEHOLDER = "project.stakeholder";
const SESSION_MS = Date.UTC(2026, 5, 1, 9, 0);
const WRITE_MS = Date.UTC(2026, 8, 5, 5, 0);
const RECALL_MS = Date.UTC(2026, 8, 5, 6, 0);
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

interface Seed {
	label: string;
	text: string;
	category: "profile" | "state" | "episodic";
	subject: string;
	attribute: string | null;
	turn: number;
}

function keyedRecord(seed: Seed): AtomicKeyedRecord {
	return {
		category: seed.category,
		kind: seed.category === "episodic" ? "occurrence" : "standing",
		claimText: seed.text,
		subject: seed.subject,
		subjectKind: seed.category === "profile" ? "user" : "named_entity",
		attribute: seed.attribute,
		value: seed.text,
		temporalPhrase: null,
		resolvedTime: seed.category === "episodic" ? { year: 2026, month: 6, day: 1 } : null,
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

interface RecallFixture {
	fixture: TestDb;
	store: MemoryStore;
	retriever: MemoryRetriever;
	projectId: string;
	idByLabel: Map<string, string>;
}

/** Writes every seed through the real chunk path, then marks the store group-CRUD maintained. */
async function seedStore(projectId: string, seeds: readonly Seed[]): Promise<RecallFixture> {
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	cleanups.push(async () => {
		await store.close();
		fixture.cleanup();
	});
	applyStateCategoryMigration(fixture.runtime.db);
	const idByLabel = new Map<string, string>();
	for (const [index, seed] of seeds.entries()) {
		const key: AtomicExtractionLedgerKey = {
			conversationId: "conversation-recall",
			chunkHash: `chunk-${seed.label}`,
			pipelineVersion: EXTRACTOR_VERSION,
		};
		expect(
			store.beginAtomicExtractionChunk({
				...key,
				rawChunk: `user: ${seed.text}`,
				routingSnapshotId: "routing-group-crud-review-recall",
				runParameters: RUN_PARAMETERS,
				nowMs: WRITE_MS + index * 10,
			}),
		).toMatchObject({ action: "run" });
		store.recordAtomicExtractionCalls(key, WRITE_MS + index * 10 + 1);
		const result = await store.storeAtomicExtractionChunk({
			ledgerKey: key,
			projectId,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: WRITE_MS + index * 10 + 2,
			cards: buildAtomicWriteCards({
				records: [keyedRecord(seed)],
				idempotencyKeys: [`group-crud-review-recall-${seed.label}`],
				sessionTimestampMs: SESSION_MS,
				sourceTurnOffset: 0,
				timezone: "UTC",
			}),
		});
		const [cardId] = result.cardIds;
		if (cardId === undefined) throw new Error(`no row was written for ${seed.label}`);
		idByLabel.set(seed.label, cardId);
	}
	// Recall expands groups only on a store the maintenance pass has receipted. The receipt is the
	// pass's last act and is the one thing recall reads, so the fixture writes that receipt.
	fixture.sqlite
		.prepare(
			`INSERT INTO nodix_todo_migration_receipts(
				migration_id, before_count, after_count, migrated_at
			) VALUES ('group-crud-maintenance-v1', ?, ?, ?)`,
		)
		.run(seeds.length, seeds.length, WRITE_MS + seeds.length * 10);
	// Vector mode, as the validity gate pins it: the clauses are about where a group lands in a
	// ranking, and a lexical fusion term on "the user" would decide that ranking instead.
	const retriever = createRetriever(store, embedder, undefined, {
		...DEFAULT_RETRIEVAL_CONFIG,
		mode: "vector",
		rerank: "none",
		minScore: 0,
		hardMinScore: 0,
	});
	return { fixture, store, retriever, projectId, idByLabel };
}

function labelOf(target: RecallFixture, rowId: string): string {
	for (const [label, id] of target.idByLabel) if (id === rowId) return label;
	return `unknown:${rowId}`;
}

function labels(target: RecallFixture, rows: readonly RetrievalResult[]): string[] {
	return rows.map((row) => labelOf(target, row.entry.id));
}

/** The raw ranking the entry works from: the same retrieve call it makes, before group serving. */
function rawRanking(target: RecallFixture, query: string, limit: number) {
	return target.retriever.retrieve({
		query,
		limit,
		scopeFilter: [target.projectId],
		source: "manual",
		allowAggregation: true,
		excludeInvalidatedBefore: RECALL_MS,
	});
}

describe("PRD 150 review — a group is expanded at its first hit's rank", () => {
	const COFFEE: Seed[] = [
		{
			label: "coffee-flat-white",
			text: "The user drinks a flat white every morning before work.",
			category: "profile",
			subject: "user",
			attribute: "preference.drinks",
			turn: 1,
		},
		{
			label: "coffee-oat-milk",
			text: "The user takes oat milk in their morning coffee.",
			category: "profile",
			subject: "user",
			attribute: "preference.diet",
			turn: 3,
		},
		{
			label: "coffee-corner-cafe",
			text: "The user buys their morning coffee at the corner cafe on the way in.",
			category: "profile",
			subject: "user",
			attribute: "routine.daily",
			turn: 5,
		},
	];
	const STAKEHOLDERS: Seed[] = [
		{
			label: "stakeholder-utilities",
			text: "The project proposal lists the local utility companies as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 7,
		},
		{
			label: "stakeholder-epa",
			text: "The project proposal lists the Environmental Protection Agency as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 9,
		},
		{
			label: "stakeholder-university",
			text: "The project proposal lists the university energy institute as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 11,
		},
	];
	const QUERY = "What does the user drink in the morning?";

	it(
		"serves three stronger single rows first, then the stakeholder group newest-first",
		{ timeout: 180_000 },
		async () => {
			const target = await seedStore("persona:group-crud-review-expansion", [
				...COFFEE,
				...STAKEHOLDERS,
			]);
			const coffeeLabels = COFFEE.map((seed) => seed.label);
			const stakeholderLabels = STAKEHOLDERS.map((seed) => seed.label);

			// Precondition on the raw ranking: at least two coffee rows outrank the group's first
			// hit. Without that the clause cannot tell "expanded at its rank" from "hoisted".
			const raw = labels(target, await rawRanking(target, QUERY, 6));
			const firstGroupHit = raw.findIndex((label) => stakeholderLabels.includes(label));
			expect(
				firstGroupHit,
				`the raw ranking does not put two coffee rows above the group's first hit: ${raw.join(", ")}`,
			).toBeGreaterThanOrEqual(2);
			expect(raw.filter((label) => coffeeLabels.includes(label))).toHaveLength(3);

			// The contract, computed from the raw ranking: every single row keeps its rank, and the
			// whole group — newest first — sits where its first hit was, once.
			const expected: string[] = [];
			for (const label of raw) {
				if (!stakeholderLabels.includes(label)) {
					expected.push(label);
				} else if (!expected.includes("stakeholder-university")) {
					expected.push("stakeholder-university", "stakeholder-epa", "stakeholder-utilities");
				}
			}

			const served = labels(
				target,
				await retrieveForMemoryRecallOrEval(target.retriever, {
					query: QUERY,
					limit: 6,
					scopeFilter: [target.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect(
				served.slice(0, firstGroupHit),
				"the group was hoisted above the stronger single rows",
			).toEqual(raw.slice(0, firstGroupHit));
			expect(served, "the group was not served whole, newest first, at its first hit's rank").toEqual(
				expected,
			);
		},
	);
});

describe("PRD 150 review — rows with no attribute are never merged into a group", () => {
	const UNKEYED: Seed[] = [
		{
			label: "coffee-black",
			text: "The user takes their coffee black, no sugar.",
			category: "profile",
			subject: "user",
			attribute: null,
			turn: 1,
		},
		{
			label: "coffee-flat-white",
			text: "The user drinks a flat white every morning before work.",
			category: "profile",
			subject: "user",
			attribute: null,
			turn: 5,
		},
		{
			// Newest of the three and about something else entirely. Merged into a "group" with the
			// two coffee rows it would be served first, above both, without ever being retrieved.
			label: "dentist-elm-street",
			text: "The dentist appointment is at the Elm Street clinic on Thursday.",
			category: "profile",
			subject: "user",
			attribute: null,
			turn: 9,
		},
	];
	const QUERY = "How does the user take their coffee?";

	it(
		"serves exactly the retrieved unkeyed rows, in rank order, and no unretrieved sibling",
		{ timeout: 180_000 },
		async () => {
			const target = await seedStore("persona:group-crud-review-unkeyed", UNKEYED);

			const raw = labels(target, await rawRanking(target, QUERY, 2));
			expect(
				[...raw].sort(),
				"the raw ranking did not put the two coffee rows first, so the fixture proves nothing",
			).toEqual(["coffee-black", "coffee-flat-white"]);

			const served = labels(
				target,
				await retrieveForMemoryRecallOrEval(target.retriever, {
					query: QUERY,
					limit: 2,
					scopeFilter: [target.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect(
				served,
				"an unretrieved unkeyed row was pulled in beside the two coffee rows",
			).not.toContain("dentist-elm-street");
			expect(served, "the served rows are not the retrieved rows in their rank order").toEqual(
				raw,
			);
		},
	);
});


/** The two states of one budget, written as two rows of one group so one can close the other. */
const BUDGET: Seed[] = [
	{
		label: "budget-first",
		text: "The project proposal budget is $2,900,000.",
		category: "state",
		subject: PROPOSAL,
		attribute: "project.budget",
		turn: 1,
	},
	{
		label: "budget-revised",
		text: "The project proposal budget is $3,450,000.",
		category: "state",
		subject: PROPOSAL,
		attribute: "project.budget",
		turn: 3,
	},
];
const BUDGET_QUERY = "What is the project proposal budget?";

/** `project.stakeholder` holds many values, so these two rows stay open beside each other. */
const OPEN_PAIR: Seed[] = [
	{
		label: "stakeholder-utilities",
		text: "The project proposal lists the local utility companies as a stakeholder.",
		category: "state",
		subject: PROPOSAL,
		attribute: STAKEHOLDER,
		turn: 7,
	},
	{
		label: "stakeholder-epa",
		text: "The project proposal lists the Environmental Protection Agency as a stakeholder.",
		category: "state",
		subject: PROPOSAL,
		attribute: STAKEHOLDER,
		turn: 9,
	},
];
const OPEN_PAIR_QUERY = "Who are the stakeholders of the project proposal?";

/**
 * `project.budget` holds one value, so writing the revised figure closes the first through the
 * production arrival close. This asserts that actually happened rather than assuming it, and
 * closes the row itself if a future cardinality ruling stops doing it, so the fixture can never
 * quietly become "one open row and one absent one".
 */
function closeFirstBudget(target: RecallFixture): void {
	const first = target.idByLabel.get("budget-first");
	const revised = target.idByLabel.get("budget-revised");
	if (first === undefined || revised === undefined) throw new Error("budget fixture is incomplete");
	const closing = target.fixture.sqlite
		.prepare("SELECT metadata, valid_from AS validFrom FROM nodix_memories WHERE id = ?")
		.get(revised) as { metadata: string; validFrom: number | null };
	closeMemoryRow(target.fixture.runtime.db, {
		targetRowId: first,
		closingRowId: revised,
		closingOrder: readMemorySourceOrderOrOldest(closing.metadata),
		closingValidFrom: closing.validFrom,
		supersededAt: WRITE_MS + 1_000,
	});
	const closed = target.fixture.sqlite
		.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
		.get(first) as { metadata: string };
	expect(
		JSON.parse(closed.metadata).superseded_by,
		"the first budget row is not closed, so nothing below is testing a closed row",
	).toBe(revised);
}

describe("PRD 150 review — a closed row is served only to a caller that asked for history", () => {
	it(
		"manual recall serves the open row alone, and both generations under include-history",
		{ timeout: 180_000 },
		async () => {
			const target = await seedStore("persona:group-crud-review-history-manual", BUDGET);
			closeFirstBudget(target);

			const current = labels(
				target,
				await retrieveForMemoryRecallOrEval(target.retriever, {
					query: BUDGET_QUERY,
					limit: 10,
					scopeFilter: [target.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect(current, "the closed budget was served as a current fact").toEqual([
				"budget-revised",
			]);

			const history = labels(
				target,
				await retrieveForMemoryRecallOrEval(target.retriever, {
					query: BUDGET_QUERY,
					limit: 10,
					scopeFilter: [target.projectId],
					facetPolicy: "include-history",
					nowMs: RECALL_MS,
				}),
			);
			expect(
				[...history].sort(),
				"include-history returned nothing of the generation it exists to show",
			).toEqual(["budget-first", "budget-revised"]);
		},
	);

	it(
		"auto recall never injects the closed row, and still serves both while neither is closed",
		{ timeout: 180_000 },
		async () => {
			// The control runs on `project.stakeholder`, which holds many values, so both rows stay
			// open: it proves auto-recall serves every open row of a group and is not simply
			// returning one row whatever the store holds.
			const open = await seedStore("persona:group-crud-review-history-auto-control", OPEN_PAIR);
			const control = labels(
				open,
				await retrieveForAutoRecall(open.retriever, {
					query: OPEN_PAIR_QUERY,
					limit: 10,
					scopeFilter: [open.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect(
				[...control].sort(),
				"the control did not retrieve both open rows, so the filter below proves nothing",
			).toEqual(["stakeholder-epa", "stakeholder-utilities"]);

			const closed = await seedStore("persona:group-crud-review-history-auto", BUDGET);
			closeFirstBudget(closed);
			const injected = labels(
				closed,
				await retrieveForAutoRecall(closed.retriever, {
					query: BUDGET_QUERY,
					limit: 10,
					scopeFilter: [closed.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect(injected, "the retired budget was injected into the agent context").toEqual([
				"budget-revised",
			]);
		},
	);
});


describe("PRD 150 review — the aggregation population is the OPEN population", () => {
	/** Three stakeholder rows of one many-valued group; the newest is closed below. */
	const THREE: Seed[] = [
		{
			label: "agg-utilities",
			text: "The project proposal lists the local utility companies as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 1,
		},
		{
			label: "agg-epa",
			text: "The project proposal lists the Environmental Protection Agency as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 3,
		},
		{
			label: "agg-university",
			text: "The project proposal lists the university energy institute as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 5,
		},
	];
	const TERMS = ["stakeholder"];

	/** A row retired on its own, which is the shape an unkeyed removal leaves behind. */
	function selfClose(target: RecallFixture, label: string): string {
		const rowId = target.idByLabel.get(label);
		if (rowId === undefined) throw new Error(`no row for ${label}`);
		const row = target.fixture.sqlite
			.prepare("SELECT metadata, valid_from AS validFrom FROM nodix_memories WHERE id = ?")
			.get(rowId) as { metadata: string; validFrom: number | null };
		closeMemoryRow(target.fixture.runtime.db, {
			targetRowId: rowId,
			closingRowId: rowId,
			closingOrder: readMemorySourceOrderOrOldest(row.metadata),
			closingValidFrom: row.validFrom,
			supersededAt: WRITE_MS + 2_000,
		});
		return rowId;
	}

	it(
		"counts only the open rows, and counts every generation under include-history",
		{ timeout: 180_000 },
		async () => {
			const target = await seedStore("persona:group-crud-review-agg-count", THREE);
			selfClose(target, "agg-university");

			const open = await target.store.searchAggregationEvidence({
				projectIdFilter: [target.projectId],
				aggregation: { operation: "evidence", terms: TERMS },
				excludeInvalidatedBefore: RECALL_MS,
			});
			expect(
				open[0]?.scopeRowCount,
				"the reported population still counts the row the close retired",
			).toBe(2);
			expect(
				labels(target, open as unknown as RetrievalResult[]).sort(),
				"a closed row was served as evidence",
			).toEqual(["agg-epa", "agg-utilities"]);

			const history = await target.store.searchAggregationEvidence({
				projectIdFilter: [target.projectId],
				aggregation: { operation: "evidence", terms: TERMS },
				facetPolicy: "include-history",
				excludeInvalidatedBefore: RECALL_MS,
			});
			expect(
				history[0]?.scopeRowCount,
				"include-history no longer counts the generation it exists to show",
			).toBe(3);
		},
	);

	it(
		"answers 'last' with the newest OPEN row instead of reporting an empty population",
		{ timeout: 180_000 },
		async () => {
			const target = await seedStore("persona:group-crud-review-agg-last", THREE);
			const askLast = () =>
				target.store.searchAggregationEvidence({
					projectIdFilter: [target.projectId],
					aggregation: { operation: "last", terms: TERMS },
					excludeInvalidatedBefore: RECALL_MS,
				});

			// Close the row this read actually selects, whichever it is. `last` reduces to one row
			// inside SQL, so closing the selected row is the case that reported an empty population
			// over a population that was not empty: the row was removed after `LIMIT 1` chose it.
			const [selected] = labels(target, (await askLast()) as unknown as RetrievalResult[]);
			if (selected === undefined) throw new Error("the fixture returned no 'last' row to close");
			selfClose(target, selected);

			const after = labels(target, (await askLast()) as unknown as RetrievalResult[]);
			expect(after, "'last' answered from nothing at all").toHaveLength(1);
			expect(after, "'last' answered from the row that was closed").not.toContain(selected);
		},
	);
});


describe("PRD 150 review — group expansion respects the query it expands", () => {
	it(
		"keeps episodic and state recall rows separate when category is omitted",
		{ timeout: 180_000 },
		async () => {
			const eventQuery = "The budget review dinner took place at Elm Street Cafe on June 1, 2026.";
			const stateQuery = "The project proposal budget is $2,900,000.";
			const target = await seedStore("persona:group-crud-review-expansion-category", [
				{
					label: "budget-state",
					text: stateQuery,
					category: "state",
					subject: PROPOSAL,
					attribute: "project.budget",
					turn: 1,
				},
				{
					label: "budget-event",
					text: eventQuery,
					category: "episodic",
					subject: PROPOSAL,
					attribute: "project.budget",
					turn: 3,
				},
			]);
			expect(labels(target, await rawRanking(target, eventQuery, 1))).toEqual(["budget-event"]);
			expect(labels(target, await rawRanking(target, stateQuery, 1))).toEqual(["budget-state"]);

			const eventRows = labels(
				target,
				await retrieveForMemoryRecallOrEval(target.retriever, {
					query: eventQuery,
					limit: 1,
					scopeFilter: [target.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect.soft(eventRows, "an event pulled in a state group member").toEqual(["budget-event"]);

			const stateRows = labels(
				target,
				await retrieveForMemoryRecallOrEval(target.retriever, {
					query: stateQuery,
					limit: 1,
					scopeFilter: [target.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect(stateRows, "a state anchor pulled in an event").toEqual(["budget-state"]);
		},
	);

	const THREE: Seed[] = [
		{
			label: "exp-utilities",
			text: "The project proposal lists the local utility companies as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 1,
		},
		{
			label: "exp-epa",
			text: "The project proposal lists the Environmental Protection Agency as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 3,
		},
		{
			label: "exp-university",
			text: "The project proposal lists the university energy institute as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 5,
		},
	];
	const QUERY = "Who are the stakeholders of the project proposal?";

	it(
		"never pulls an expired sibling back in beside the row that was retrieved",
		{ timeout: 180_000 },
		async () => {
			const target = await seedStore("persona:group-crud-review-expansion-expiry", THREE);
			const expiredId = target.idByLabel.get("exp-university");
			if (expiredId === undefined) throw new Error("no row for exp-university");

			const before = labels(
				target,
				await retrieveForMemoryRecallOrEval(target.retriever, {
					query: QUERY,
					limit: 10,
					scopeFilter: [target.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect(
				before,
				"the row did not start inside the served group, so expiring it proves nothing",
			).toContain("exp-university");

			// The row expires an hour before the recall. The search excludes it; the expansion has
			// to exclude it too, or the caller is handed a fact the query already ruled out.
			const row = target.fixture.sqlite
				.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
				.get(expiredId) as { metadata: string };
			target.fixture.sqlite
				.prepare("UPDATE nodix_memories SET metadata = ? WHERE id = ?")
				.run(
					JSON.stringify({ ...JSON.parse(row.metadata), invalidated_at: RECALL_MS - 3_600_000 }),
					expiredId,
				);

			const after = labels(
				target,
				await retrieveForMemoryRecallOrEval(target.retriever, {
					query: QUERY,
					limit: 10,
					scopeFilter: [target.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect(after, "the expansion re-admitted the expired row").not.toContain("exp-university");
			expect(
				after.length,
				"the expansion dropped the rows that are still valid",
			).toBeGreaterThan(0);
		},
	);

	it(
		"leaves an aggregation's reduced answer exactly as storage chose it",
		{ timeout: 180_000 },
		async () => {
			const target = await seedStore("persona:group-crud-review-expansion-agg", THREE);

			const served = await retrieveForMemoryRecallOrEval(target.retriever, {
				query: QUERY,
				limit: 10,
				scopeFilter: [target.projectId],
				aggregation: { operation: "last", terms: ["stakeholder"] },
				nowMs: RECALL_MS,
			});
			expect(
				served,
				"the single row 'last' reduced to was expanded back into its whole group",
			).toHaveLength(1);
			expect(
				served[0]?.scopeRowCount,
				"the expansion replaced the aggregation row and lost its population figure",
			).toBe(3);
		},
	);
});


describe("PRD 150 review — a closed row never spends a recall slot", () => {
	/**
	 * Three near-identical stakeholder rows and one plainly different row. The three closed rows
	 * score highest on the stakeholder query, so with a limit of 1 they fill the whole cut; the
	 * open one is right behind them.
	 */
	const CROWDED: Seed[] = [
		{
			label: "slot-closed-a",
			text: "The project proposal lists the local utility companies as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 1,
		},
		{
			label: "slot-closed-b",
			text: "The project proposal lists the Environmental Protection Agency as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 3,
		},
		{
			label: "slot-open",
			text: "The project proposal lists the university energy institute as a stakeholder.",
			category: "state",
			subject: PROPOSAL,
			attribute: STAKEHOLDER,
			turn: 5,
		},
	];
	const QUERY = "Who are the stakeholders of the project proposal?";

	it(
		"serves the current fact even when the highest-scoring rows of its group are all closed",
		{ timeout: 180_000 },
		async () => {
			const target = await seedStore("persona:group-crud-review-slots", CROWDED);

			const ranked = labels(target, await rawRanking(target, QUERY, 3));
			const openLabel = ranked[ranked.length - 1];
			if (openLabel === undefined) throw new Error("the fixture retrieved nothing");
			// Close everything the ranking puts AHEAD of the last row, so the closed rows are exactly
			// the ones a cut would keep.
			for (const label of ranked.slice(0, -1)) {
				const rowId = target.idByLabel.get(label);
				if (rowId === undefined) throw new Error(`no row for ${label}`);
				const row = target.fixture.sqlite
					.prepare("SELECT metadata, valid_from AS validFrom FROM nodix_memories WHERE id = ?")
					.get(rowId) as { metadata: string; validFrom: number | null };
				closeMemoryRow(target.fixture.runtime.db, {
					targetRowId: rowId,
					closingRowId: rowId,
					closingOrder: readMemorySourceOrderOrOldest(row.metadata),
					closingValidFrom: row.validFrom,
					supersededAt: WRITE_MS + 3_000,
				});
			}

			const served = labels(
				target,
				await retrieveForMemoryRecallOrEval(target.retriever, {
					query: QUERY,
					limit: 1,
					scopeFilter: [target.projectId],
					nowMs: RECALL_MS,
				}),
			);
			expect(
				served,
				"the closed rows spent the whole limit and the current fact was never served",
			).toContain(openLabel);
		},
	);
});
