import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
/** @file PRD 150 QCG-9 — entity identity: the merge, the forced split, the tag.
 *
 * @boundary The real extraction pipeline (`runAtomicMemoryExtraction`) writing to a real encrypted
 * SQLite store, then the production REM update wave (`runRemBatchJob`) over the same file.
 * Nothing about the store is mocked. The two model seams — the entity-identity judgement on the
 * generic transport, and the wave's stages — are
 * ANSWERED here on purpose: QCG-9 measures what the engine does with an answer, not how well a
 * model answers.
 *
 * The variant pair is the measured one. `memory-store-atomic-entity-api.ts` records it in its own
 * comment: in the Memora weekly corpus one e-mail is named `The email is to outline strategic
 * research priorities ...` in one session and `the email titled 'To outline strategic research
 * priorities ....'` in another. Those two survive `normalizeEntityName` as DIFFERENT normalized
 * names — the quote does not wrap the whole value and the trailing character is an apostrophe, not
 * a full stop — so the second one reaches the identity judgement, which is the only way an alias
 * row can ever be created. A variant that normalizes identically never reaches the judgement at
 * all, which is why the first assertion of clause 1 is that the judgement was actually asked.
 */

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
import type { AtomicProfileKeyingTransport } from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import type { AtomicSubjectGuardTransport } from "../../../../packages/memory/src/engine/extraction/atomic-subject-guard";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { applyEntityNameKeyMigration } from "../../../../packages/memory/src/store/entity-name-key-migration";
import { applyStateCategoryMigration } from "../../../../packages/memory/src/store/state-category-migration";
import {
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import { parseRemOperationalConfiguration } from "../../../../packages/memory/src/engine/rem/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const EXTRACTOR_VERSION = "atomic-v3-entity-merge-test";
/** Every run shares one session day, so the ledger's session ordinal is what orders the runs. */
const SESSION_MS = Date.UTC(2026, 8, 4, 9, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 4_096,
	subchunkCount: 1,
};

/** Entity A: the e-mail as the corpus names it in the first weekly session. */
const A_NAME = "The email is to outline strategic research priorities for the coming quarter";
/** The same e-mail as the corpus names it in a later session. A different normalized name. */
const VARIANT_NAME =
	"the email titled 'To outline strategic research priorities for the coming quarter.'";
/** A second, unrelated document. Its rows never carry a merge tag, and clause 4 leans on that. */
const C_NAME = "The staffing update note for the research group";

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
// The real pipeline, driven with answered model seams.
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

/**
 * The generic transport carries BOTH the extraction pass and the entity-identity judgement, so it
 * dispatches on the identity payload's own field name. Every identity prompt is kept: clause 1
 * reads the candidate names out of it.
 */
class AnsweredGenericTransport implements AtomicGenericExtractionTransport {
	readonly identityPrompts: string[] = [];
	private extractionCalls = 0;

	constructor(
		private readonly extractionReply: string,
		private readonly identityAnswer: (newDisplayName: string) => string,
	) {}

	async complete(request: AtomicGenericExtractionRequest) {
		if (request.prompt.includes('"new_display_name"')) {
			this.identityPrompts.push(request.prompt);
			const payload = identityPayload(request.prompt);
			return {
				text: JSON.stringify({ entity_id: this.identityAnswer(payload.new_display_name) }),
				truncated: false,
			};
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

interface IdentityPayload {
	new_display_name: string;
	existing_entities: Array<{ entity_id: string; display_name: string }>;
}

/** The identity prompt is the skill text and then one JSON object, joined by a blank line. */
function identityPayload(prompt: string): IdentityPayload {
	const blocks = prompt.split("\n\n");
	const last = blocks[blocks.length - 1];
	if (last === undefined) throw new Error("the identity prompt carries no payload");
	return JSON.parse(last) as IdentityPayload;
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
	// The `state` category and its CHECK arrive with this migration; entity rows are `state` rows.
	applyStateCategoryMigration(fixture.runtime.db);
	// The re-key that lets several display names point at one entity id — the thing that makes an
	// alias row possible at all. `connection.ts` and `runMigrations` both apply it; so does this.
	applyEntityNameKeyMigration(fixture.runtime.db);
	return { fixture, store, projectId, closeStore };
}

interface ExtractionRun {
	conversationId: string;
	turns: readonly AtomicExtractionTurn[];
	records: ReadonlyArray<Record<string, unknown>>;
	identityAnswer: (newDisplayName: string) => string;
	nowMs: number;
}

async function runExtraction(
	target: StoreFixture,
	run: ExtractionRun,
): Promise<AnsweredGenericTransport> {
	const generic = new AnsweredGenericTransport(
		JSON.stringify({ records: run.records }),
		run.identityAnswer,
	);
	const transports: AtomicMemoryExtractionTransports = {
		generic,
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
		sessionDateTime: new Date(SESSION_MS).toISOString(),
		sessionTimestampMs: SESSION_MS,
		sessionTimezone: "UTC",
		transports,
		nowMs: () => run.nowMs,
		locale: "en",
	});
	expect(result.status, `extraction run ${run.conversationId} did not complete`).toBe("complete");
	return generic;
}

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
	validUntil: number | null;
}

function readRows(fixture: TestDb, projectId: string): StoredRow[] {
	return fixture.sqlite
		.prepare(
			`SELECT id, text, subject, attribute, lane, metadata, valid_until AS validUntil
			FROM nodix_memories WHERE project_id = ? ORDER BY rowid`,
		)
		.all(projectId) as StoredRow[];
}

/**
 * A row the gauntlet parks — an unresolvable quote, a compound claim — is relocated out of
 * `nodix_memories` entirely the next time the product opens the database, which is what the wave
 * does. Every "nothing was closed" assertion in this file would then pass over an empty table, so
 * each fixture states how many live rows it expects before anything is measured.
 */
function assertActiveRowCount(fixture: TestDb, projectId: string, expected: number): StoredRow[] {
	const rows = readRows(fixture, projectId);
	expect(
		rows.filter((row) => row.lane !== "active").map((row) => row.text),
		"the pipeline parked a row, so it would vanish before the wave and prove nothing",
	).toEqual([]);
	expect(rows, `${projectId} does not hold the rows this fixture is built from`).toHaveLength(
		expected,
	);
	return rows;
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

function entityRows(
	fixture: TestDb,
	projectId: string,
): Array<{ entityId: string; displayName: string; normalizedName: string }> {
	return fixture.sqlite
		.prepare(
			`SELECT entity_id AS entityId, display_name AS displayName,
				normalized_name AS normalizedName
			FROM nodix_memory_entities WHERE project_id = ? ORDER BY normalized_name`,
		)
		.all(projectId) as Array<{ entityId: string; displayName: string; normalizedName: string }>;
}

function entityIdFor(fixture: TestDb, projectId: string, displayName: string): string {
	const row = entityRows(fixture, projectId).find((entry) => entry.displayName === displayName);
	if (row === undefined) throw new Error(`no entity was registered for: ${displayName}`);
	return row.entityId;
}

function journalRows(
	fixture: TestDb,
	reason: string,
): Array<{ rowId: string | null; detail: string | null }> {
	return fixture.sqlite
		.prepare("SELECT row_id AS rowId, detail FROM nodix_rem_journal WHERE reason = ?")
		.all(reason) as Array<{ rowId: string | null; detail: string | null }>;
}

// ---------------------------------------------------------------------------------------------
// The production REM update wave, with its stages answered.
// ---------------------------------------------------------------------------------------------

interface Observation {
	stage: string;
	prompt: string;
}

function neutralReplyFor(stage: string): string {
	switch (stage) {
		case "rem-update-retirement-target":
			return JSON.stringify({ target_row_ids: [] });
		case "rem-update-judgment":
			return JSON.stringify({ proposed_current: "", retired_values: [] });
		case "rem-update-relation-judgment":
			return JSON.stringify({
				supersedes: true,
				retires_anything: true,
				supersedes_everything: true,
			});
		case "rem-update-verification":
			return JSON.stringify({
				faithful: false,
				retired_absent: false,
				all_facts_accounted: false,
			});
		case "rem-replace-clause-carry":
			return JSON.stringify({ already_current: [] });
		default:
			return "{}";
	}
}

/** The nominated row and the offered candidates, read off the retirement-target prompt. */
function retirementPrompt(prompt: string): {
	nominated: { id: string };
	candidates: Array<{ id: string }>;
} {
	const candidateMark = prompt.lastIndexOf("Candidate rows: ");
	const nominatedMark = prompt.lastIndexOf("Nominated row: ");
	return {
		nominated: JSON.parse(
			prompt.slice(nominatedMark + "Nominated row: ".length, candidateMark).trim(),
		) as { id: string },
		candidates: JSON.parse(prompt.slice(candidateMark + "Candidate rows: ".length)) as Array<{
			id: string;
		}>,
	};
}

/** Every candidate id offered to a given nominated row, across its batches. */
function offeredIds(observations: readonly Observation[], nominatedRowId: string): string[] {
	return observations
		.filter((observation) => observation.stage === "rem-update-retirement-target")
		.map((observation) => retirementPrompt(observation.prompt))
		.filter((parsed) => parsed.nominated.id === nominatedRowId)
		.flatMap((parsed) => parsed.candidates.map((candidate) => candidate.id));
}

/**
 * Runs the shipped wave over the store file. The retirement answer is a plan keyed on the
 * nominated row id, filtered to what was actually offered — so naming a row the engine never
 * offered cannot smuggle a close into the fixture.
 */
async function runUpdateWave(
	target: StoreFixture,
	plan: Readonly<Record<string, readonly string[]>>,
): Promise<Observation[]> {
	await target.closeStore();
	const stateRoot = mkdtempSync(join(tmpdir(), "group-crud-entity-merge-"));
	writeSettingsFixture(stateRoot, { mode: "local-first", store: { path: target.fixture.dbPath, encryptionKey: target.fixture.encryptionKey },
		embedding: { cacheDir: "" } });
	process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = target.fixture.dbPath;
	process.env["SNO_PROFILE_DIR"] = stateRoot;
	cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
	const observations: Observation[] = [];
	try {
		await runRemBatchJob({
			jobId: `job-${target.projectId}`,
			jobType: "rem-update",
			scope: target.projectId,
			configuration: parseRemOperationalConfiguration(
				createRemOwnerDecidedOperationalConfiguration(),
			),
			modelStageResponses: createRemModelStageResponsePort({
				respond: async ({ stage, prompt }) => {
					observations.push({ stage, prompt });
					if (stage !== "rem-update-retirement-target") return neutralReplyFor(stage);
					const parsed = retirementPrompt(prompt);
					const wanted = plan[parsed.nominated.id] ?? [];
					return JSON.stringify({
						target_row_ids: wanted.filter((id) =>
							parsed.candidates.some((candidate) => candidate.id === id),
						),
					});
				},
			}),
		});
	} catch (error) {
		// A wave whose model calls are all refused throws; that is production behaviour and not what
		// this file measures. Anything else is a real failure.
		const message = error instanceof Error ? error.message : String(error);
		if (!message.startsWith("REM LLM calls all failed")) throw error;
	}
	return observations;
}

// ---------------------------------------------------------------------------------------------
// Clauses 1 and 3 — one store, one journey: merge and tag both close directions.
// ---------------------------------------------------------------------------------------------

const JOURNEY_PROJECT = "persona:group-crud-entity-merge";

const A_RECIPIENT_TEXT =
	"The email's recipient list includes the Head of Operations of the research group.";
const A_KEY_POINT_TEXT = "The email's key point is that new hiring is paused for the quarter.";
const C_KEY_POINT_TEXT =
	"The staffing update note's key point is that the office move happens in March.";
const B_RECIPIENT_TEXT =
	"The email's recipient list was updated from the Head of Operations to the Director of Research.";
const B_KEY_POINT_TEXT = "The email's key point is that new hiring resumes in the spring.";
const A_KEY_POINT_LATER_TEXT =
	"The email's key point was updated from hiring resuming in the spring to hiring resuming in the summer.";
const C_KEY_POINT_LATER_TEXT =
	"The staffing update note's key point was updated from the office move happening in March " +
	"to the office move happening in May.";

const WEEK_ONE_TURNS: AtomicExtractionTurn[] = [
	{
		role: "user",
		content:
			"The email is to outline strategic research priorities for the coming quarter, and it " +
			"goes to the Head of Operations of the research group. Its key point is that new hiring " +
			"is paused for the quarter. Separately, the staffing update note for the research group " +
			"says the office move happens in March.",
	},
	{ role: "assistant", content: "Noted." },
];
const WEEK_TWO_TURNS: AtomicExtractionTurn[] = [
	{
		role: "user",
		content:
			"On the email titled 'To outline strategic research priorities for the coming quarter.', " +
			"the recipient list was updated from the Head of Operations to the Director of Research, " +
			"and its key point is now that new hiring resumes in the spring.",
	},
	{ role: "assistant", content: "Understood." },
];
const WEEK_THREE_TURNS: AtomicExtractionTurn[] = [
	{
		role: "user",
		content:
			"The email is to outline strategic research priorities for the coming quarter; its key " +
			"point was updated from hiring resuming in the spring to hiring resuming in the summer. " +
			"The staffing update note's key point moved from March to May.",
	},
	{ role: "assistant", content: "Understood." },
];

function journeyWeekOneRecords(): Array<Record<string, unknown>> {
	return [
		wireRecord({
			claim_text: A_RECIPIENT_TEXT,
			subject: A_NAME,
			attribute: "email.recipient",
			value: "the Head of Operations of the research group",
			source_span: { turn_index: 0, quote: "it goes to the Head of Operations" },
		}),
		wireRecord({
			claim_text: A_KEY_POINT_TEXT,
			subject: A_NAME,
			attribute: "email.key_point",
			value: "new hiring is paused for the quarter",
			source_span: { turn_index: 0, quote: "new hiring is paused for the quarter" },
		}),
		wireRecord({
			claim_text: C_KEY_POINT_TEXT,
			subject: C_NAME,
			attribute: "email.key_point",
			value: "the office move happens in March",
			source_span: { turn_index: 0, quote: "the office move happens in March" },
		}),
	];
}

function journeyWeekTwoRecords(): Array<Record<string, unknown>> {
	return [
		wireRecord({
			claim_text: B_RECIPIENT_TEXT,
			subject: VARIANT_NAME,
			attribute: "email.recipient",
			value: "the Director of Research",
			source_span: {
				turn_index: 0,
				quote: "the recipient list was updated from the Head of Operations to the Director of Research",
			},
		}),
		wireRecord({
			claim_text: B_KEY_POINT_TEXT,
			subject: VARIANT_NAME,
			attribute: "email.key_point",
			value: "new hiring resumes in the spring",
			source_span: { turn_index: 0, quote: "new hiring resumes in the spring" },
		}),
	];
}

function journeyWeekThreeRecords(): Array<Record<string, unknown>> {
	return [
		wireRecord({
			claim_text: A_KEY_POINT_LATER_TEXT,
			subject: A_NAME,
			attribute: "email.key_point",
			value: "hiring resuming in the summer",
			source_span: { turn_index: 0, quote: "hiring resuming in the spring to hiring resuming" },
		}),
		wireRecord({
			claim_text: C_KEY_POINT_LATER_TEXT,
			subject: C_NAME,
			attribute: "email.key_point",
			value: "the office move happening in May",
			source_span: { turn_index: 0, quote: "moved from March to May" },
		}),
	];
}

interface Journey {
	target: StoreFixture;
	identityPrompts: string[];
	entityA: string;
	mergeId: string;
}

/** Three weekly sessions through the real pipeline: seed A and C, merge the variant, then a later A. */
async function runMergeJourney(): Promise<Journey> {
	const target = openStore(JOURNEY_PROJECT);
	await runExtraction(target, {
		conversationId: "email-priorities-week-1",
		turns: WEEK_ONE_TURNS,
		records: journeyWeekOneRecords(),
		// Nothing is registered yet, so the only honest answer the skill allows is `new`.
		identityAnswer: () => "new",
		nowMs: SESSION_MS + 1_000,
	});
	const entityA = entityIdFor(target.fixture, JOURNEY_PROJECT, A_NAME);
	const mergeRun = await runExtraction(target, {
		conversationId: "email-priorities-week-2",
		turns: WEEK_TWO_TURNS,
		records: journeyWeekTwoRecords(),
		identityAnswer: (newDisplayName) => {
			expect(
				newDisplayName,
				"the identity judgement was asked about a name other than the variant",
			).toBe(VARIANT_NAME);
			return entityA;
		},
		nowMs: SESSION_MS + 2_000,
	});
	const laterRun = await runExtraction(target, {
		conversationId: "email-priorities-week-3",
		turns: WEEK_THREE_TURNS,
		records: journeyWeekThreeRecords(),
		// Every name in this session is already registered, so the judgement must not be asked at
		// all. Asserted rather than thrown: `resolveAtomicEntityIdentity` swallows a transport
		// throw, journals it and falls back to the deterministic slug, so a throw here would be
		// invisible and the week-3 rows would quietly land under a different subject.
		identityAnswer: () => "new",
		nowMs: SESSION_MS + 3_000,
	});
	expect(
		laterRun.identityPrompts,
		"a name that is already registered was sent to the identity judgement",
	).toEqual([]);
	// Three sessions: three rows, then two, then two.
	assertActiveRowCount(target.fixture, JOURNEY_PROJECT, 7);
	const mergedRow = rowByText(target.fixture, JOURNEY_PROJECT, B_RECIPIENT_TEXT);
	const mergeId = metadataOf(mergedRow)["merge_id"];
	expect(typeof mergeId, "the merged row carries no merge_id").toBe("string");
	return {
		target,
		identityPrompts: mergeRun.identityPrompts,
		entityA,
		mergeId: mergeId as string,
	};
}

describe("PRD 150 QCG-9 — a variant name is shown A's name, and an existing-id answer merges", () => {
	it(
		"offers A's display name, writes the variant's rows under A's id, and tags them with a merge_id",
		{ timeout: 300_000 },
		async () => {
			const journey = await runMergeJourney();
			const { fixture } = journey.target;

			expect(
				journey.identityPrompts,
				"the variant name never reached the identity judgement, so no merge could ever happen",
			).toHaveLength(1);
			const payload = identityPayload(journey.identityPrompts[0] ?? "");
			expect(payload.new_display_name).toBe(VARIANT_NAME);
			expect(
				payload.existing_entities.map((entity) => entity.display_name),
				"A's display name was not among the existing candidate names shown to the judgement",
			).toContain(A_NAME);
			expect(
				payload.existing_entities.find((entity) => entity.display_name === A_NAME)?.entity_id,
				"A's name was offered under an id that is not A's",
			).toBe(journey.entityA);

			// The alias: a second display name in the entity table pointing at A's id. Only the
			// re-keyed table can hold this — the old primary key allowed one name per entity.
			const registered = entityRows(fixture, JOURNEY_PROJECT);
			const alias = registered.find((entity) => entity.displayName === VARIANT_NAME);
			expect(alias, "the variant name was not registered as an alias row").toBeDefined();
			expect(alias?.entityId, "the alias row does not point at A's entity id").toBe(
				journey.entityA,
			);
			expect(
				alias?.normalizedName,
				"the alias collapsed onto A's normalized name, so it is not a second key at all",
			).not.toBe(
				registered.find((entity) => entity.displayName === A_NAME)?.normalizedName,
			);

			// Both rows the merged statement wrote are subjected to A and carry the same tag.
			for (const text of [B_RECIPIENT_TEXT, B_KEY_POINT_TEXT]) {
				const row = rowByText(fixture, JOURNEY_PROJECT, text);
				expect(row.subject, `${text} was not written under A's entity id`).toBe(
					journey.entityA,
				);
				expect(
					metadataOf(row)["merge_id"],
					`${text} was written under a merge and carries no merge_id`,
				).toBe(journey.mergeId);
			}
			// A's own rows predate the merge and must stay untagged.
			for (const text of [A_RECIPIENT_TEXT, A_KEY_POINT_TEXT]) {
				expect(
					metadataOf(rowByText(fixture, JOURNEY_PROJECT, text))["merge_id"],
					`${text} predates the merge and was tagged anyway`,
				).toBeUndefined();
			}

			// The journal records the merge and the identity candidates that were offered.
			const journal = fixture.sqlite
				.prepare(
					`SELECT detail FROM nodix_rem_journal
					WHERE stage = 'entity-identity' AND outcome = 'done'`,
				)
				.all() as Array<{ detail: string }>;
			const merge = journal
				.map((row) => JSON.parse(row.detail) as Record<string, unknown>)
				.find((detail) => detail["merge_id"] === journey.mergeId);
			expect(merge, "the merge was not journaled under its merge_id").toBeDefined();
			expect(merge?.["entity_id"]).toBe(journey.entityA);
			expect(merge?.["display_name"]).toBe(VARIANT_NAME);
			expect(
				merge?.["offered_entity_ids"],
				"the journal does not record which ids the judgement was offered",
			).toContain(journey.entityA);
		},
	);
});

describe("PRD 150 QCG-9 — both close directions of a merge carry the merge_id", () => {
	it(
		"tags a later A-statement's close of a B-row and a merged B-statement's close of an A-row",
		{ timeout: 300_000 },
		async () => {
			const journey = await runMergeJourney();
			const { fixture } = journey.target;
			const aRecipient = rowByText(fixture, JOURNEY_PROJECT, A_RECIPIENT_TEXT);
			const bRecipient = rowByText(fixture, JOURNEY_PROJECT, B_RECIPIENT_TEXT);
			const bKeyPoint = rowByText(fixture, JOURNEY_PROJECT, B_KEY_POINT_TEXT);
			const aKeyPointLater = rowByText(fixture, JOURNEY_PROJECT, A_KEY_POINT_LATER_TEXT);
			const cKeyPoint = rowByText(fixture, JOURNEY_PROJECT, C_KEY_POINT_TEXT);
			const cKeyPointLater = rowByText(fixture, JOURNEY_PROJECT, C_KEY_POINT_LATER_TEXT);

			await runUpdateWave(journey.target, {
				// The statement carries the tag; the row it closes does not.
				[bRecipient.id]: [aRecipient.id],
				// The row being closed carries the tag; the statement does not.
				[aKeyPointLater.id]: [bKeyPoint.id],
				// Neither side carries anything: the untagged control clause 4 leans on.
				[cKeyPointLater.id]: [cKeyPoint.id],
			});

			const closedA = rowByText(fixture, JOURNEY_PROJECT, A_RECIPIENT_TEXT);
			expect(
				metadataOf(closedA)["superseded_by"],
				"the merged statement did not close the A-row it was pointed at",
			).toBe(bRecipient.id);
			expect(
				metadataOf(closedA)["close_merge_id"],
				"a merged statement closed an A-row and the close carries no merge_id",
			).toBe(journey.mergeId);

			const closedB = rowByText(fixture, JOURNEY_PROJECT, B_KEY_POINT_TEXT);
			expect(
				metadataOf(closedB)["superseded_by"],
				"the later A-statement did not close the B-row it was pointed at",
			).toBe(aKeyPointLater.id);
			expect(
				metadataOf(closedB)["close_merge_id"],
				"a merged row was closed and the close carries no merge_id",
			).toBe(journey.mergeId);

			const closedC = rowByText(fixture, JOURNEY_PROJECT, C_KEY_POINT_TEXT);
			expect(
				metadataOf(closedC)["superseded_by"],
				"the untagged control pair did not close, so clause 4 would prove nothing",
			).toBe(cKeyPointLater.id);
			expect(
				metadataOf(closedC)["close_merge_id"],
				"a close between two rows of an unmerged entity was tagged with a merge_id",
			).toBeUndefined();
		},
	);
});

// ---------------------------------------------------------------------------------------------
// Clause 2 — a forced `new` answer writes a fresh id and closes nothing, on all three paths.
// ---------------------------------------------------------------------------------------------

const SPLIT_PROJECT = "persona:group-crud-entity-split";

/** The three paths QCG-9 names, as they exist for a document subject. */
const SPLIT_PATHS = [
	{ label: "keyed", attribute: "email.recipient" as string | null },
	// `email.purpose` is one of the state vocabulary's single-valued slugs: its group closes
	// mechanically, with no model in the loop. That is the path most likely to close by accident.
	{ label: "one", attribute: "email.purpose" as string | null },
	{ label: "unkeyed", attribute: null as string | null },
];

const SPLIT_A_TEXTS: Record<string, string> = {
	keyed: "The email's recipient list includes the Head of Operations of the research group.",
	one: "The email's purpose is to outline strategic research priorities for the coming quarter.",
	unkeyed: "The email was dictated on a Monday morning before the standup.",
};
const SPLIT_FRESH_TEXTS: Record<string, string> = {
	keyed: "The other email's recipient list includes the university's grants office.",
	one: "The other email's purpose is to confirm the grants office deadline.",
	unkeyed: "The other email was dictated on a Friday afternoon after the review.",
};
const SPLIT_FRESH_TRANSITION_TEXTS: Record<string, string> = {
	keyed: "The other email's recipient list was updated from the grants office to the finance office.",
	one: "The other email's purpose was updated from confirming the deadline to requesting an extension.",
	unkeyed: "The other email's dictation slot was updated from Friday afternoon to Friday evening.",
};

const SPLIT_WEEK_ONE_TURNS: AtomicExtractionTurn[] = [
	{
		role: "user",
		content:
			"The email is to outline strategic research priorities for the coming quarter; it goes " +
			"to the Head of Operations of the research group, and I dictated it on a Monday morning " +
			"before the standup.",
	},
	{ role: "assistant", content: "Noted." },
];
const SPLIT_WEEK_TWO_TURNS: AtomicExtractionTurn[] = [
	{
		role: "user",
		content:
			"On the email titled 'To outline strategic research priorities for the coming quarter.', " +
			"the recipient list is the grants office and its purpose is to confirm the deadline; " +
			"I dictated it on a Friday afternoon after the review. Since then the recipient list " +
			"moved to the finance office, the purpose became requesting an extension, and the " +
			"dictation slot moved to Friday evening.",
	},
	{ role: "assistant", content: "Understood." },
];

/**
 * The quote of each claim, per path. It has to be a real substring of its own turn: a span the
 * gauntlet cannot resolve is parked as `subject-unverified`, and a parked row never reaches the
 * wave at all — which would make every "closed nothing" assertion below pass for the wrong reason.
 */
const SPLIT_A_QUOTES: Record<string, string> = {
	keyed: "it goes to the Head of Operations of the research group",
	one: "The email is to outline strategic research priorities for the coming quarter",
	unkeyed: "I dictated it on a Monday morning before the standup",
};
const SPLIT_FRESH_QUOTES: Record<string, string> = {
	keyed: "the recipient list is the grants office",
	one: "its purpose is to confirm the deadline",
	unkeyed: "I dictated it on a Friday afternoon after the review",
};
const SPLIT_FRESH_TRANSITION_QUOTES: Record<string, string> = {
	keyed: "the recipient list moved to the finance office",
	one: "the purpose became requesting an extension",
	unkeyed: "the dictation slot moved to Friday evening",
};

function splitRecordsFor(
	subject: string,
	texts: Record<string, string>,
	quotes: Record<string, string>,
): Array<Record<string, unknown>> {
	return SPLIT_PATHS.map((path) => {
		const text = texts[path.label];
		const quote = quotes[path.label];
		if (text === undefined || quote === undefined) {
			throw new Error(`no text or quote for the ${path.label} path`);
		}
		return wireRecord({
			claim_text: text,
			subject,
			attribute: path.attribute,
			value: text,
			source_span: { turn_index: 0, quote },
		});
	});
}

describe("PRD 150 QCG-9 — a forced `new` answer writes a fresh id and closes nothing", () => {
	it(
		"splits on the keyed, single-valued and unkeyed paths, and offers the fresh subject nothing",
		{ timeout: 300_000 },
		async () => {
			const target = openStore(SPLIT_PROJECT);
			await runExtraction(target, {
				conversationId: "split-week-1",
				turns: SPLIT_WEEK_ONE_TURNS,
				records: splitRecordsFor(A_NAME, SPLIT_A_TEXTS, SPLIT_A_QUOTES),
				identityAnswer: () => "new",
				nowMs: SESSION_MS + 1_000,
			});
			const entityA = entityIdFor(target.fixture, SPLIT_PROJECT, A_NAME);

			// The same variant name as the merge journey, and this time the judgement answers `new`
			// — the answer the skill demands whenever there is doubt.
			const splitRun = await runExtraction(target, {
				conversationId: "split-week-2",
				turns: SPLIT_WEEK_TWO_TURNS,
				records: [
					...splitRecordsFor(VARIANT_NAME, SPLIT_FRESH_TEXTS, SPLIT_FRESH_QUOTES),
					...splitRecordsFor(
						VARIANT_NAME,
						SPLIT_FRESH_TRANSITION_TEXTS,
						SPLIT_FRESH_TRANSITION_QUOTES,
					),
				],
				identityAnswer: (newDisplayName) => {
					expect(newDisplayName).toBe(VARIANT_NAME);
					return "new";
				},
				nowMs: SESSION_MS + 2_000,
			});
			expect(
				splitRun.identityPrompts,
				"the variant never reached the judgement, so `new` was never actually answered",
			).toHaveLength(1);

			const { fixture } = target;
			// Three rows for A, then six for the variant: two on each of the three paths.
			assertActiveRowCount(fixture, SPLIT_PROJECT, 9);
			const freshEntity = entityIdFor(fixture, SPLIT_PROJECT, VARIANT_NAME);
			expect(freshEntity, "the `new` answer reused A's entity id").not.toBe(entityA);
			expect(freshEntity, "the `new` answer did not mint a fresh id").toMatch(/^entity:/);

			const freshRowIds: string[] = [];
			for (const texts of [SPLIT_FRESH_TEXTS, SPLIT_FRESH_TRANSITION_TEXTS]) {
				for (const path of SPLIT_PATHS) {
					const text = texts[path.label];
					if (text === undefined) throw new Error(`no text for the ${path.label} path`);
					const row = rowByText(fixture, SPLIT_PROJECT, text);
					freshRowIds.push(row.id);
					expect(row.subject, `the ${path.label} row was not written under the fresh id`).toBe(
						freshEntity,
					);
					expect(
						metadataOf(row)["merge_id"],
						`a \`new\` answer tagged the ${path.label} row with a merge_id`,
					).toBeUndefined();
					expect(
						metadataOf(row)["entity_identity_new"],
						`the ${path.label} row does not record that its subject is a fresh entity`,
					).toBe(true);
				}
			}

			// Nothing is closed on arrival, on any of the three paths.
			for (const row of readRows(fixture, SPLIT_PROJECT)) {
				expect(
					metadataOf(row)["superseded_by"],
					`the write path closed ${row.text} under a fresh-entity statement`,
				).toBeUndefined();
			}

			const observations = await runUpdateWave(target, {});

			// The three transition-shaped fresh rows are nominated, and each is offered NOTHING —
			// no judged candidate and no mechanical one. Without the fresh-entity gate the newer
			// fresh row of each path would be offered its own older sibling, and the `one` path
			// would close it with no model in the loop at all.
			for (const path of SPLIT_PATHS) {
				const text = SPLIT_FRESH_TRANSITION_TEXTS[path.label];
				if (text === undefined) throw new Error(`no text for the ${path.label} path`);
				const nominated = rowByText(fixture, SPLIT_PROJECT, text);
				expect(
					offeredIds(observations, nominated.id),
					`the ${path.label} path offered candidates to a statement about a fresh entity`,
				).toEqual([]);
				expect(
					journalRows(fixture, "no_retirement_target").map((row) => row.rowId),
					`the ${path.label} path did not record an empty candidate set for the fresh subject`,
				).toContain(nominated.id);
			}
			expect(
				journalRows(fixture, "cardinality_one"),
				"a single-valued attribute closed a row mechanically under a fresh entity",
			).toEqual([]);

			// Every row A owns, and every row the fresh entity owns, is still open.
			for (const row of readRows(fixture, SPLIT_PROJECT)) {
				expect(
					metadataOf(row)["superseded_by"],
					`a \`new\` answer closed ${row.text}`,
				).toBeUndefined();
				expect(row.validUntil, `a \`new\` answer ended ${row.text}`).toBeNull();
			}
			for (const path of SPLIT_PATHS) {
				const text = SPLIT_A_TEXTS[path.label];
				if (text === undefined) throw new Error(`no text for the ${path.label} path`);
				const row = rowByText(fixture, SPLIT_PROJECT, text);
				expect(row.subject, `A's ${path.label} row changed subject`).toBe(entityA);
			}
			expect(freshRowIds).toHaveLength(6);
		},
	);
});
