import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
/** @file PRD 150 review repairs — the write path: order, legacy rows, entity spelling, negation.
 *
 * @boundary The real chunk write (`MemoryStore.storeAtomicExtractionChunk`), the real extraction
 * pipeline (`runAtomicMemoryExtraction`) and the production REM update wave, all over a real
 * encrypted SQLite store. The store is never substituted. The two model seams — the generic
 * transport the pipeline calls, and the wave's stages — are ANSWERED, because each clause here
 * measures what the engine does with a given answer, never how well a model answers.
 *
 * Each clause is one defect the post-landing review found that the existing suite had not
 * caught. Reverting the matching repair turns the clause red:
 *
 * 1. an undated statement lost to a dated older row of its `one` group
 *    (`compareMemorySourceOrder` compares `valid_from` only when both sides carry one);
 * 2. a row written before the order key threw the whole write
 *    (`readMemorySourceOrderOrOldest` in `openGroupRows` and the arrival close);
 * 3. two spellings of one new entity in one batch minted two entities
 *    (identity cache keyed on `normalizeEntityName`, `INSERT OR IGNORE` on the entity table);
 * 4. a pure negation closed its `one` group mechanically
 *    (the mechanical one-group close requires a nominated row that is not `pure-negation`);
 * 5. an unparseable second retirement batch discarded the first batch's targets
 *    (a refusal `break`s the batch loop instead of returning).
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AtomicResplitTransport } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-gauntlet";
import type { AtomicExtractionTurn } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import type {
	AtomicGenericExtractionRequest,
	AtomicGenericExtractionTransport,
} from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor";
import {
	type AtomicMemoryExtractionTransports,
	runAtomicMemoryExtraction,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import type {
	AtomicKeyedRecord,
	AtomicProfileKeyingTransport,
} from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import type { AtomicSubjectGuardTransport } from "../../../../packages/memory/src/engine/extraction/atomic-subject-guard";
import { buildAtomicWriteCards } from "../../../../packages/memory/src/engine/extraction/atomic-write-projection";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { applyEntityNameKeyMigration } from "../../../../packages/memory/src/store/entity-name-key-migration";
import { applyStateCategoryMigration } from "../../../../packages/memory/src/store/state-category-migration";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import {
	classifyRemRow,
	parseRemOperationalConfiguration,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const EXTRACTOR_VERSION = "group-crud-review-write-path";
const PROPOSAL = "entity:project_proposal_1";
/** A `one`-ruled document slug: a proposal carries exactly one budget. */
const BUDGET = "project.budget";
/** The conversation's own day; every row written from it reads the session as its clock. */
const SESSION_MS = Date.UTC(2026, 5, 1, 9, 0);
/** The write clock, well after the session, so the two can never be confused in a row. */
const WRITE_MS = Date.UTC(2026, 8, 5, 5, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 4_096,
	subchunkCount: 1,
};

const priorEnvironment = {
	SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
	SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
};
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const [name, value] of Object.entries(priorEnvironment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

// ---------------------------------------------------------------------------------------------
// Reading the store back.
// ---------------------------------------------------------------------------------------------

interface StoredRow {
	id: string;
	text: string;
	subject: string | null;
	attribute: string | null;
	lane: string;
	metadata: string;
	validFrom: number | null;
}

function readRow(fixture: TestDb, rowId: string): StoredRow {
	const row = fixture.sqlite
		.prepare(
			`SELECT id, text, subject, attribute, lane, metadata, valid_from AS validFrom
			FROM nodix_memories WHERE id = ?`,
		)
		.get(rowId) as StoredRow | undefined;
	if (row === undefined) throw new Error(`row ${rowId} is not in the store`);
	return row;
}

function readRows(fixture: TestDb, projectId: string): StoredRow[] {
	return fixture.sqlite
		.prepare(
			`SELECT id, text, subject, attribute, lane, metadata, valid_from AS validFrom
			FROM nodix_memories WHERE project_id = ? ORDER BY rowid`,
		)
		.all(projectId) as StoredRow[];
}

function rowByText(fixture: TestDb, projectId: string, text: string): StoredRow {
	const rows = readRows(fixture, projectId);
	const row = rows.find((entry) => entry.text === text);
	if (row === undefined) {
		throw new Error(
			`no row was written for: ${text}\nrows present:\n${rows.map((entry) => `  ${entry.text}`).join("\n")}`,
		);
	}
	return row;
}

function metadataOf(row: StoredRow): Record<string, unknown> {
	return JSON.parse(row.metadata) as Record<string, unknown>;
}

function supersededBy(fixture: TestDb, rowId: string): string | null {
	const value = metadataOf(readRow(fixture, rowId))["superseded_by"];
	return typeof value === "string" ? value : null;
}

function journalReasons(fixture: TestDb, rowId?: string): string[] {
	const rows =
		rowId === undefined
			? fixture.sqlite
					.prepare("SELECT reason FROM nodix_rem_journal WHERE reason IS NOT NULL")
					.all()
			: fixture.sqlite
					.prepare(
						"SELECT reason FROM nodix_rem_journal WHERE row_id = ? AND reason IS NOT NULL",
					)
					.all(rowId);
	return (rows as Array<{ reason: string }>).map((row) => row.reason);
}

interface StoreFixture {
	fixture: TestDb;
	store: MemoryStore;
	projectId: string;
	closeStore: () => Promise<void>;
}

function openStore(projectId: string): StoreFixture {
	const fixture = createTestDb();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	let closed = false;
	const closeStore = async () => {
		if (closed) return;
		closed = true;
		await store.close();
	};
	cleanups.push(async () => {
		await closeStore();
		fixture.cleanup();
	});
	// The `state` category CHECK and the entity re-key are what the product applies at open;
	// a fixture is a database the product is about to use, so it takes both steps too.
	applyStateCategoryMigration(fixture.runtime.db);
	applyEntityNameKeyMigration(fixture.runtime.db);
	return { fixture, store, projectId, closeStore };
}

// ---------------------------------------------------------------------------------------------
// The direct chunk write, one statement per chunk.
// ---------------------------------------------------------------------------------------------

interface BudgetStatement {
	label: string;
	text: string;
	turn: number;
	resolvedTime?: { year: number; month: number; day: number };
	temporalPhrase?: string;
}

function budgetRecord(statement: BudgetStatement): AtomicKeyedRecord {
	return {
		category: "state",
		kind: "standing",
		claimText: statement.text,
		subject: PROPOSAL,
		subjectKind: "named_entity",
		attribute: BUDGET,
		value: statement.text,
		temporalPhrase: statement.temporalPhrase ?? null,
		resolvedTime: statement.resolvedTime ?? null,
		endsCurrent: false,
		endedAt: null,
		importance: "high",
		changesCurrentState: true,
		todo: "none",
		closeReason: null,
		sourceSpan: {
			turnIndex: statement.turn,
			quote: statement.text,
			startOffset: 0,
			endOffset: statement.text.length,
		},
		relations: [],
		singleClaim: true,
		lane: "active",
		dispositionReason: null,
		resplit: false,
	};
}

/** Writes each statement through the real chunk path, in order, all in one conversation. */
async function writeBudgetStatements(
	target: StoreFixture,
	statements: readonly BudgetStatement[],
): Promise<Map<string, string>> {
	const idByLabel = new Map<string, string>();
	for (const [index, statement] of statements.entries()) {
		const key: AtomicExtractionLedgerKey = {
			conversationId: "conversation-budget",
			chunkHash: `chunk-${statement.label}`,
			pipelineVersion: EXTRACTOR_VERSION,
		};
		expect(
			target.store.beginAtomicExtractionChunk({
				...key,
				rawChunk: `user: ${statement.text}`,
				routingSnapshotId: "routing-group-crud-review",
				runParameters: RUN_PARAMETERS,
				nowMs: WRITE_MS + index * 10,
			}),
		).toMatchObject({ action: "run" });
		target.store.recordAtomicExtractionCalls(key, WRITE_MS + index * 10 + 1);
		const result = await target.store.storeAtomicExtractionChunk({
			ledgerKey: key,
			projectId: target.projectId,
			extractorVersion: EXTRACTOR_VERSION,
			nowMs: WRITE_MS + index * 10 + 2,
			cards: buildAtomicWriteCards({
				records: [budgetRecord(statement)],
				idempotencyKeys: [`group-crud-review-${statement.label}`],
				sessionTimestampMs: SESSION_MS,
				sourceTurnOffset: 0,
				timezone: "UTC",
			}),
		});
		const [cardId] = result.cardIds;
		if (cardId === undefined) throw new Error(`no row was written for ${statement.label}`);
		idByLabel.set(statement.label, cardId);
	}
	return idByLabel;
}

describe("PRD 150 review — an undated statement is ordered by its place, not lost to a date", () => {
	it(
		"writes the undated newer budget open and closes the dated older one under it",
		{ timeout: 180_000 },
		async () => {
			const target = openStore("persona:group-crud-review-undated");
			// The opening figure carries a resolved date. The revision carries only a phrase the
			// resolver could not place, so it reaches the store with no `valid_from` at all.
			const dated: BudgetStatement = {
				label: "budget-dated",
				text: "The project proposal budget is $800,000.",
				turn: 1,
				resolvedTime: { year: 2026, month: 3, day: 2 },
			};
			const undated: BudgetStatement = {
				label: "budget-undated",
				text: "The project proposal budget was recently raised to $1,200,000.",
				turn: 5,
				temporalPhrase: "recently",
			};
			const idByLabel = await writeBudgetStatements(target, [dated, undated]);
			const datedId = idByLabel.get(dated.label);
			const undatedId = idByLabel.get(undated.label);
			if (datedId === undefined || undatedId === undefined) throw new Error("rows missing");

			const undatedRow = readRow(target.fixture, undatedId);
			expect(
				undatedRow.validFrom,
				"the revision was written with a date, so this fixture no longer tests an undated row",
			).toBeNull();
			expect(readRow(target.fixture, datedId).validFrom).toBe(Date.UTC(2026, 2, 2));

			expect(
				supersededBy(target.fixture, undatedId),
				"the undated newer budget was closed on arrival under the dated older one",
			).toBeNull();
			expect(
				supersededBy(target.fixture, datedId),
				"the dated older budget stayed open beside the undated revision",
			).toBe(undatedId);
			expect(journalReasons(target.fixture, undatedId)).toContain(
				`closed_on_arrival_forward:${datedId}`,
			);
		},
	);
});

describe("PRD 150 review — a row from before the order key does not break the group write", () => {
	function seedLegacyRow(
		target: StoreFixture,
		row: { id: string; text: string; timestampMs: number },
	): void {
		// A row written before PRD 150: category, subject and attribute are set, but the metadata
		// carries no `source_order`. The maintenance pass backfills it; a wave may run first.
		target.fixture.sqlite
			.prepare(
				`INSERT INTO nodix_memories(
					id, text, category, project_id, importance, timestamp, timezone, metadata,
					content_hash, fact_id, lane, subject, attribute, valid_from,
					maturity, source, extractor_version
				) VALUES (?, ?, 'state', ?, 0.9, ?, 'UTC', ?, ?, ?, 'active', ?, ?, ?, 'extracted', 'edge', ?)`,
			)
			.run(
				row.id,
				row.text,
				target.projectId,
				row.timestampMs,
				JSON.stringify({ kind: "state", memory_category: "state", value: row.text }),
				createHash("sha256").update(row.text).digest("hex"),
				`fact-${row.id}`,
				PROPOSAL,
				BUDGET,
				row.timestampMs,
				"pre-prd-150",
			);
	}

	it(
		"closes two legacy rows of the group under a new arrival without throwing",
		{ timeout: 180_000 },
		async () => {
			const target = openStore("persona:group-crud-review-legacy");
			// Two legacy rows, so the arrival has to ORDER them as well as compare against them.
			seedLegacyRow(target, {
				id: "legacy-budget-800k",
				text: "The project proposal budget is $800,000.",
				timestampMs: Date.UTC(2026, 2, 2),
			});
			seedLegacyRow(target, {
				id: "legacy-budget-850k",
				text: "The project proposal budget is $850,000.",
				timestampMs: Date.UTC(2026, 3, 10),
			});
			for (const legacy of ["legacy-budget-800k", "legacy-budget-850k"]) {
				expect(
					() => JSON.parse(readRow(target.fixture, legacy).metadata).source_order,
					"the legacy fixture row carries an order key, so it no longer tests a legacy row",
				).not.toThrow();
				expect(metadataOf(readRow(target.fixture, legacy))["source_order"]).toBeUndefined();
			}

			const idByLabel = await writeBudgetStatements(target, [
				{
					label: "budget-revision",
					text: "The project proposal budget was updated from $850,000 to $1,200,000.",
					turn: 3,
				},
			]);
			const arrivalId = idByLabel.get("budget-revision");
			if (arrivalId === undefined) throw new Error("the arrival was not written");

			expect(
				supersededBy(target.fixture, arrivalId),
				"the new arrival was closed under a legacy row",
			).toBeNull();
			for (const legacy of ["legacy-budget-800k", "legacy-budget-850k"]) {
				expect(
					supersededBy(target.fixture, legacy),
					`${legacy} stayed open behind the new budget`,
				).toBe(arrivalId);
			}
			expect(journalReasons(target.fixture, arrivalId)).toContain("cardinality_one");
		},
	);
});

// ---------------------------------------------------------------------------------------------
// The real extraction pipeline, with its generic transport answered.
// ---------------------------------------------------------------------------------------------

/** One extracted claim on the wire, in the shape the response schema pins. */
function wireRecord(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		kind: "standing",
		subject_kind: "named_entity",
		temporal_phrase: null,
		resolved_time: null,
		importance: "medium",
		changes_current_state: false,
		ends_current: false,
		ended_at: null,
		todo: "none",
		close_reason: null,
		relations: [],
		single_claim: true,
		...overrides,
	};
}

/** The nominated row and the offered candidates, read off a retirement-target prompt. */
function retirementPrompt(prompt: string): {
	nominated: { id: string; text: string };
	candidates: Array<{ id: string; text: string }>;
} {
	const candidateMark = prompt.lastIndexOf("Candidate rows: ");
	const nominatedMark = prompt.lastIndexOf("Nominated row: ");
	return {
		nominated: JSON.parse(
			prompt.slice(nominatedMark + "Nominated row: ".length, candidateMark).trim(),
		) as { id: string; text: string },
		candidates: JSON.parse(prompt.slice(candidateMark + "Candidate rows: ".length)) as Array<{
			id: string;
			text: string;
		}>,
	};
}

/**
 * The generic transport carries the extraction pass, the entity-identity judgement AND the
 * arrival-retirement judgement, so it dispatches on each prompt's own shape.
 */
class AnsweredGenericTransport implements AtomicGenericExtractionTransport {
	readonly identityPrompts: string[] = [];
	readonly retirementBatches: Array<Array<{ id: string; text: string }>> = [];
	private extractionCalls = 0;

	constructor(
		private readonly extractionReply: string,
		private readonly retirementReply: (
			batch: ReadonlyArray<{ id: string; text: string }>,
		) => string = () => JSON.stringify({ target_row_ids: [] }),
	) {}

	async complete(request: AtomicGenericExtractionRequest) {
		if (request.prompt.includes('"new_display_name"')) {
			this.identityPrompts.push(request.prompt);
			// Nothing is registered under these names yet, so `new` is the only honest answer.
			return { text: JSON.stringify({ entity_id: "new" }), truncated: false };
		}
		if (request.prompt.includes("Task: REM retirement target judgment.")) {
			const { candidates } = retirementPrompt(request.prompt);
			this.retirementBatches.push(candidates);
			return { text: this.retirementReply(candidates), truncated: false };
		}
		this.extractionCalls += 1;
		// The first generic call is the extraction pass. Anything after it — the numeric sweep, the
		// unresolved-subject re-ask — has nothing to add to these sessions.
		return {
			text: this.extractionCalls === 1 ? this.extractionReply : "{}",
			truncated: false,
		};
	}
}

class NoKeyingTransport implements AtomicProfileKeyingTransport {
	async keyTurn() {
		return [];
	}
}

class NoResplitTransport implements AtomicResplitTransport {
	async resplit() {
		return null;
	}
}

class PassThroughSubjectGuard implements AtomicSubjectGuardTransport {
	async repairMissingHalf() {
		return [];
	}

	async guardUserSubjects(input: Parameters<AtomicSubjectGuardTransport["guardUserSubjects"]>[0]) {
		return input.records.map(() => true);
	}
}

async function runExtraction(
	target: StoreFixture,
	run: {
		conversationId: string;
		turns: readonly AtomicExtractionTurn[];
		records: ReadonlyArray<Record<string, unknown>>;
		generic: AnsweredGenericTransport;
		sessionMs: number;
		nowMs: number;
	},
): Promise<void> {
	const transports: AtomicMemoryExtractionTransports = {
		generic: run.generic,
		profileKeying: new NoKeyingTransport(),
		resplit: new NoResplitTransport(),
		subjectGuard: new PassThroughSubjectGuard(),
	};
	const result = await runAtomicMemoryExtraction({
		store: target.store,
		projectId: target.projectId,
		ledgerKey: {
			conversationId: run.conversationId,
			chunkHash: `chunk-${run.conversationId}`,
			pipelineVersion: EXTRACTOR_VERSION,
		},
		turns: run.turns,
		rawChunk: run.turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
		routingSnapshotId: EXTRACTOR_VERSION,
		runParameters: RUN_PARAMETERS,
		estimatedInputTokens: 512,
		extractorVersion: EXTRACTOR_VERSION,
		sessionDateTime: new Date(run.sessionMs).toISOString(),
		sessionTimestampMs: run.sessionMs,
		sessionTimezone: "UTC",
		transports,
		nowMs: () => run.nowMs,
		locale: "en",
	});
	expect(result.status, `extraction run ${run.conversationId} did not complete`).toBe("complete");
}

describe("PRD 150 review — two spellings of one new entity in one batch make one entity", () => {
	const OBJECTIVE_TEXT = "Project Helios's objective is to cut grid losses by ten percent.";
	const DELIVERABLE_TEXT = "project helios's first deliverable is a pilot report.";

	it(
		"registers one entity for 'Project Helios' and 'project helios' and lands both rows on it",
		{ timeout: 180_000 },
		async () => {
			const target = openStore("persona:group-crud-review-entity-spelling");
			const generic = new AnsweredGenericTransport(
				JSON.stringify({
					records: [
						wireRecord({
							claim_text: OBJECTIVE_TEXT,
							subject: "Project Helios",
							attribute: "project.objective",
							value: "cut grid losses by ten percent",
							source_span: {
								turn_index: 0,
								quote: "objective is to cut grid losses by ten percent",
							},
						}),
						wireRecord({
							claim_text: DELIVERABLE_TEXT,
							subject: "project helios",
							attribute: "project.deliverable",
							value: "a pilot report",
							source_span: { turn_index: 0, quote: "first deliverable is a pilot report" },
						}),
					],
				}),
			);
			await runExtraction(target, {
				conversationId: "helios-kickoff",
				turns: [
					{
						role: "user",
						content:
							"Project Helios's objective is to cut grid losses by ten percent, and " +
							"project helios's first deliverable is a pilot report.",
					},
					{ role: "assistant", content: "Noted." },
				],
				records: [],
				generic,
				sessionMs: SESSION_MS,
				nowMs: WRITE_MS,
			});

			const entities = target.fixture.sqlite
				.prepare(
					`SELECT entity_id AS entityId, display_name AS displayName,
						normalized_name AS normalizedName
					FROM nodix_memory_entities WHERE project_id = ? ORDER BY display_name`,
				)
				.all(target.projectId) as Array<{
				entityId: string;
				displayName: string;
				normalizedName: string;
			}>;
			expect(
				entities.map((entity) => entity.normalizedName),
				"two spellings of one name registered more than one entity",
			).toEqual(["project helios"]);
			const [entity] = entities;
			if (entity === undefined) throw new Error("no entity was registered");

			const objective = rowByText(target.fixture, target.projectId, OBJECTIVE_TEXT);
			const deliverable = rowByText(target.fixture, target.projectId, DELIVERABLE_TEXT);
			expect([objective.lane, deliverable.lane]).toEqual(["active", "active"]);
			expect(
				objective.subject,
				"the first spelling's row is not on the registered entity",
			).toBe(entity.entityId);
			expect(
				deliverable.subject,
				"the second spelling's row landed on a different subject than the first",
			).toBe(entity.entityId);
		},
	);
});

describe("PRD 150 review — an unparseable later retirement batch keeps the earlier batch's targets", () => {
	const ARRIVAL_PROJECT = "persona:group-crud-review-arrival-batches";
	const HELIOS = "entity:project-helios-seeded";
	const SEED_MS = Date.UTC(2026, 3, 6, 9, 0);
	const STAKEHOLDERS = [
		"the city council",
		"the regional grid operator",
		"the state energy office",
		"the utility workers' union",
		"the county planning board",
		"the local chamber of commerce",
		"the environmental review panel",
		"the community solar cooperative",
		"the transmission owners' association",
		"the university energy institute",
		"the ratepayer advocate",
		"the municipal water district",
		"the port authority",
		"the tribal utility commission",
		"the downtown business alliance",
		"the rural electric cooperative",
	];
	const DELIVERABLES = [
		"a pilot report",
		"a grid-loss baseline study",
		"a substation retrofit plan",
		"a public dashboard",
	];
	const RETIRED = ["helios-stakeholder-03", "helios-stakeholder-11"];

	function seedEntityAndRows(target: StoreFixture): void {
		target.fixture.sqlite
			.prepare(
				`INSERT INTO nodix_memory_entities(
					project_id, entity_id, display_name, normalized_name, created_at
				) VALUES (?, ?, 'Project Helios', 'project helios', ?)`,
			)
			.run(target.projectId, HELIOS, SEED_MS);
		const insert = target.fixture.sqlite.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata,
				content_hash, fact_id, lane, subject, attribute, valid_from,
				maturity, source, extractor_version
			) VALUES (?, ?, 'state', ?, 0.9, ?, 'UTC', ?, ?, ?, 'active', ?, ?, ?, 'extracted', 'edge', ?)`,
		);
		const rows = [
			...STAKEHOLDERS.map((name, index) => ({
				id: `helios-stakeholder-${String(index).padStart(2, "0")}`,
				text: `Project Helios lists ${name} as a stakeholder.`,
				attribute: "project.stakeholder",
				turn: index + 1,
			})),
			...DELIVERABLES.map((name, index) => ({
				id: `helios-deliverable-${String(index).padStart(2, "0")}`,
				text: `Project Helios's deliverables include ${name}.`,
				attribute: "project.deliverable",
				turn: STAKEHOLDERS.length + index + 1,
			})),
		];
		for (const row of rows) {
			insert.run(
				row.id,
				row.text,
				target.projectId,
				SEED_MS + row.turn,
				JSON.stringify({
					kind: "state",
					memory_category: "state",
					value: row.text,
					source_order: {
						valid_from: SEED_MS,
						session_ordinal: 0,
						global_turn_index: row.turn,
						rowid: row.turn,
					},
				}),
				createHash("sha256").update(row.text).digest("hex"),
				`fact-${row.id}`,
				HELIOS,
				row.attribute,
				SEED_MS,
				"seeded-before-arrival",
			);
		}
	}

	it(
		"closes the first batch's named targets after the second batch's reply is unparseable",
		{ timeout: 240_000 },
		async () => {
			const target = openStore(ARRIVAL_PROJECT);
			seedEntityAndRows(target);
			const removal = "Project Helios no longer lists the city council as a stakeholder.";
			const generic = new AnsweredGenericTransport(
				JSON.stringify({
					records: [
						wireRecord({
							claim_text: removal,
							subject: "Project Helios",
							attribute: "project.stakeholder",
							value: "the city council",
							ends_current: true,
							changes_current_state: true,
							source_span: {
								turn_index: 0,
								quote: "no longer lists the city council as a stakeholder",
							},
						}),
					],
				}),
				(batch) =>
					// Same-attribute candidates rank first, so the sixteen stakeholder rows fill the
					// first batch and the four deliverable rows are the second. The first batch is
					// answered; the second is not JSON at all.
					batch.some((candidate) => candidate.id.startsWith("helios-stakeholder-"))
						? JSON.stringify({
								target_row_ids: RETIRED.filter((id) =>
									batch.some((candidate) => candidate.id === id),
								),
							})
						: "I cannot tell which of these rows the removal retires.",
			);
			await runExtraction(target, {
				conversationId: "helios-stakeholder-removal",
				turns: [
					{ role: "user", content: removal },
					{ role: "assistant", content: "Understood." },
				],
				records: [],
				generic,
				sessionMs: SESSION_MS,
				nowMs: WRITE_MS,
			});

			const nominated = rowByText(target.fixture, target.projectId, removal);
			expect(nominated.lane, "the removal was parked and nominated nothing").toBe("active");
			expect(
				generic.retirementBatches.map((batch) => batch.length),
				"the candidate set did not split into a full first batch and a short second one",
			).toEqual([16, 4]);
			expect(
				generic.retirementBatches[0]?.every((candidate) =>
					candidate.id.startsWith("helios-stakeholder-"),
				),
				"the first batch is not the same-attribute rows, so the scripted answer went to the wrong batch",
			).toBe(true);

			for (const rowId of RETIRED) {
				expect(
					supersededBy(target.fixture, rowId),
					`${rowId} was named by the answered first batch and was left open`,
				).toBe(nominated.id);
			}
			const untouched = [
				...STAKEHOLDERS.map((_, index) => `helios-stakeholder-${String(index).padStart(2, "0")}`),
				...DELIVERABLES.map((_, index) => `helios-deliverable-${String(index).padStart(2, "0")}`),
			].filter((rowId) => !RETIRED.includes(rowId));
			for (const rowId of untouched) {
				expect(supersededBy(target.fixture, rowId), `${rowId} was closed by nobody`).toBeNull();
			}
			const refusals = target.fixture.sqlite
				.prepare(
					`SELECT outcome, reason FROM nodix_rem_journal
					WHERE stage = ? AND outcome = 'refused'`,
				)
				.all(`arrival-retirement-target:${nominated.id}`) as Array<{
				outcome: string;
				reason: string;
			}>;
			expect(
				refusals.map((row) => row.reason),
				"the unparseable second batch left no refusal in the journal",
			).toEqual(["model_response_invalid"]);
		},
	);
});

// ---------------------------------------------------------------------------------------------
// The production update wave over seeded state rows.
// ---------------------------------------------------------------------------------------------

describe("PRD 150 review — a pure negation never closes its one-group mechanically", () => {
	const SCOPE = "persona:group-crud-review-negation";
	const BASE_VALID_FROM = Date.UTC(2026, 8, 1);
	const OLDER_BUDGET = "The proposal budget is $800,000.";
	const NEGATION = "No longer carries a budget of $800,000; the figure was withdrawn pending review.";

	interface SeedRow {
		id: string;
		text: string;
		turn: number;
	}

	function seedRow(database: TestDb["runtime"]["raw"], row: SeedRow): void {
		database
			.prepare(
				`INSERT INTO nodix_memories(
					id, text, category, project_id, importance, timestamp, timezone, metadata,
					content_hash, fact_id, lane, raw_candidate_json, subject, attribute, valid_from
				) VALUES (?, ?, 'state', ?, 0.9, ?, 'UTC', ?, ?, ?, 'active', ?, ?, ?, ?)`,
			)
			.run(
				row.id,
				row.text,
				SCOPE,
				BASE_VALID_FROM + row.turn,
				JSON.stringify({
					kind: "state",
					memory_category: "state",
					topic: BUDGET,
					source_order: {
						valid_from: BASE_VALID_FROM,
						session_ordinal: 0,
						global_turn_index: row.turn,
						rowid: row.turn,
					},
				}),
				createHash("sha256").update(row.text).digest("hex"),
				`fact-${row.id}`,
				JSON.stringify({ evidence: row.text }),
				PROPOSAL,
				BUDGET,
				BASE_VALID_FROM,
			);
	}

	function neutralReplyFor(stage: string): string {
		switch (stage) {
			case "rem-update-retirement-target":
				return JSON.stringify({ target_row_ids: [] });
			case "rem-update-judgment":
				return JSON.stringify({ proposed_current: "", retired_values: [] });
			case "rem-update-relation-judgment":
				return JSON.stringify({
					supersedes: false,
					retires_anything: false,
					supersedes_everything: false,
				});
			case "rem-update-verification":
				return JSON.stringify({
					faithful: false,
					retired_absent: false,
					all_facts_accounted: false,
				});
			default:
				return "{}";
		}
	}

	interface Observation {
		stage: string;
		prompt: string;
	}

	async function runUpdateWave(fixture: TestDb): Promise<Observation[]> {
		const stateRoot = mkdtempSync(join(tmpdir(), "group-crud-review-negation-"));
		writeSettingsFixture(stateRoot, { mode: "local-first", store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey },
			embedding: { cacheDir: "" } });
		process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = fixture.dbPath;
		process.env["SNO_PROFILE_DIR"] = stateRoot;
		cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
		const observations: Observation[] = [];
		try {
			await runRemBatchJob({
				jobId: "job-group-crud-review-negation",
				jobType: "rem-update",
				scope: SCOPE,
				configuration: parseRemOperationalConfiguration(
					createRemOwnerDecidedOperationalConfiguration(),
				),
				modelStageResponses: createRemModelStageResponsePort({
					respond: async ({ stage, prompt }) => {
						observations.push({ stage, prompt });
						return neutralReplyFor(stage);
					},
				}),
			});
		} catch (error) {
			// A wave whose every model call is refused throws; that is production behaviour and not
			// what this clause measures.
			const message = error instanceof Error ? error.message : String(error);
			if (!message.startsWith("REM LLM calls all failed")) throw error;
		}
		return observations;
	}

	it(
		"leaves the older budget open under a neutral judgement, and offers it to the judgement",
		{ timeout: 240_000 },
		async () => {
			// The fixture's own classifier must read the negation as a pure negation, or the clause
			// is testing the transition path by accident.
			expect(
				classifyRemRow({ rowId: "probe", text: NEGATION, contentHash: "probe" }).state,
				"the negation row does not classify as pure-negation, so this fixture proves nothing",
			).toBe("pure-negation");

			const fixture = createTestDb();
			cleanups.push(() => fixture.cleanup());
			seedRow(fixture.runtime.raw, { id: "state-budget-older", text: OLDER_BUDGET, turn: 1 });
			seedRow(fixture.runtime.raw, { id: "state-budget-negation", text: NEGATION, turn: 9 });

			const observations = await runUpdateWave(fixture);

			expect(
				supersededBy(fixture, "state-budget-older"),
				"the older budget was closed mechanically by a pure negation",
			).toBeNull();
			expect(journalReasons(fixture)).not.toContain("cardinality_one");
			const offered = observations
				.filter((observation) => observation.stage === "rem-update-retirement-target")
				.map((observation) => retirementPrompt(observation.prompt))
				.filter((parsed) => parsed.nominated.id === "state-budget-negation")
				.flatMap((parsed) => parsed.candidates.map((candidate) => candidate.id));
			expect(
				offered,
				"the older budget was never offered to the retirement judgement for the negation",
			).toContain("state-budget-older");
		},
	);
});
