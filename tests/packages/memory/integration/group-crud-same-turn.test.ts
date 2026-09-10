/** @file group-crud-same-turn.test.ts
 * @purpose Proves rows born from one conversation turn never close each other at arrival, while
 *   rows of earlier turns still are closed.
 * @boundary The real extraction run, write door, arrival judgement and encrypted SQLite through
 *   `MemoryStore`; the model is the only substitute.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AtomicProfileKeyingTransport } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-profile-keying";
import type { AtomicResplitTransport } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-gauntlet";
import type { AtomicExtractionTurn } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-extraction-reply";
import type {
	AtomicGenericExtractionRequest,
	AtomicGenericExtractionTransport,
} from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-generic-extractor";
import {
	type AtomicMemoryExtractionTransports,
	runAtomicMemoryExtraction,
} from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction";
import type { AtomicSubjectGuardTransport } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-subject-guard";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import { applyStateCategoryMigration } from "../../../../packages/sno-station-mem/src/store/state-category-migration";
import { type AtomicExtractionRunParameters, MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const EXTRACTOR_VERSION = "group-crud-same-turn-test";
const SESSION_MS = Date.UTC(2026, 8, 7, 16, 20);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 4_096,
	subchunkCount: 1,
};
const TIMELINE = "project.timeline";
const BUDGET = "project.budget";
const READING = "preference.reading";
const PROPOSAL = "Next-Generation Cockpit Display Integration Platform";

/**
 * Measured 2026-09-07 on the business executive's proposal: one turn states an 18-month timeline
 * and its three phases, the model returns four `project.timeline` records, and the write door
 * closed each with the next until only "Phase 3" survived. Same turn, one statement.
 */
const TIMELINE_TURN =
	"The project timeline is 18 months: Phase 1 (Requirements & Design) months 1-4, Phase 2 (Development & Testing) months 5-13, Phase 3 (Certification & Deployment) months 14-18.";

interface StoredRow {
	id: string;
	text: string;
	attribute: string | null;
	metadata: string;
}

/** The closure question's candidate block, as `renderRemRetirementTargetPrompt` writes it. */
function offeredCandidates(prompt: string): Array<{ id: string; text: string }> | undefined {
	const block = prompt.split("\n\n").find((part) => part.startsWith("Candidate rows: "));
	if (block === undefined) return undefined;
	return JSON.parse(block.slice("Candidate rows: ".length)) as Array<{ id: string; text: string }>;
}

/**
 * Stands in for the model only. The extraction question gets the one scripted reply; the closure
 * question closes every offered row whose text matches `mustCloseTexts` — the judge is not under
 * test here, the candidate list it is handed is.
 */
class ScriptedGenericTransport implements AtomicGenericExtractionTransport {
	readonly closureQuestions: Array<Array<{ id: string; text: string }>> = [];

	constructor(
		private readonly reply: string,
		private readonly mustCloseTexts: readonly string[] = [],
	) {}

	async complete(request: AtomicGenericExtractionRequest) {
		const candidates = offeredCandidates(request.prompt);
		if (candidates !== undefined) {
			this.closureQuestions.push(candidates);
			const targetRowIds = candidates
				.filter((row) => this.mustCloseTexts.some((text) => row.text.includes(text)))
				.map((row) => row.id);
			return { text: JSON.stringify({ target_row_ids: targetRowIds }), truncated: false };
		}
		if (request.prompt.includes('"new_display_name"')) {
			// The identity judgement merges a name onto the existing entity of the same display
			// name, as the real judge does for a name repeated verbatim.
			const payload = JSON.parse(
				request.prompt.slice(request.prompt.lastIndexOf("\n\n") + 2),
			) as {
				new_display_name: string;
				existing_entities: Array<{ entity_id: string; display_name: string }>;
			};
			const same = payload.existing_entities.find(
				({ display_name }) => display_name === payload.new_display_name,
			);
			return { text: JSON.stringify({ entity_id: same?.entity_id ?? "new" }), truncated: false };
		}
		return { text: this.reply, truncated: false };
	}
}

class BareBaseKeyingTransport implements AtomicProfileKeyingTransport {
	async keyTurn() {
		return [];
	}
}

class NoResplitTransport implements AtomicResplitTransport {
	async resplit() {
		return null;
	}
}

class PassingSubjectGuard implements AtomicSubjectGuardTransport {
	async repairMissingHalf() {
		return [];
	}

	async guardUserSubjects(
		input: Parameters<AtomicSubjectGuardTransport["guardUserSubjects"]>[0],
	) {
		return input.records.map(() => true);
	}
}

function scriptedTransports(
	records: readonly Record<string, unknown>[],
	mustCloseTexts: readonly string[] = [],
): AtomicMemoryExtractionTransports & { generic: ScriptedGenericTransport } {
	return {
		generic: new ScriptedGenericTransport(JSON.stringify({ records }), mustCloseTexts),
		profileKeying: new BareBaseKeyingTransport(),
		resplit: new NoResplitTransport(),
		subjectGuard: new PassingSubjectGuard(),
	};
}

function proposalRecord(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		kind: "standing",
		claim_text: "The project timeline is 18 months.",
		subject: PROPOSAL,
		subject_kind: "named_entity",
		attribute: TIMELINE,
		value: "18 months",
		temporal_phrase: null,
		resolved_time: null,
		importance: "high",
		changes_current_state: true,
		ends_current: false,
		ended_at: null,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: 0, quote: "The project timeline is 18 months" },
		relations: [],
		single_claim: true,
		...overrides,
	};
}

function userRecord(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		...proposalRecord({}),
		subject: "user",
		subject_kind: "user",
		attribute: READING,
		importance: "medium",
		...overrides,
	};
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function openStore(): { fixture: TestDb; store: MemoryStore } {
	const fixture = createTestDb();
	expect(applyStateCategoryMigration(fixture.runtime.db).status).toBe("migrated");
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	cleanups.push(async () => {
		await store.close();
		fixture.cleanup();
	});
	return { fixture, store };
}

function readRows(fixture: TestDb, projectId: string): StoredRow[] {
	return fixture.sqlite
		.prepare(
			"SELECT id, text, attribute, metadata FROM nodix_memories WHERE project_id = ? ORDER BY rowid",
		)
		.all(projectId) as StoredRow[];
}

function supersededBy(row: StoredRow): string | null {
	const value = (JSON.parse(row.metadata) as Record<string, unknown>)["superseded_by"];
	return typeof value === "string" ? value : null;
}

function endsCurrent(row: StoredRow): boolean {
	return (JSON.parse(row.metadata) as Record<string, unknown>)["ends_current"] === true;
}

function journalReasons(fixture: TestDb): string[] {
	return (
		fixture.sqlite
			.prepare("SELECT reason FROM nodix_rem_journal WHERE reason IS NOT NULL")
			.all() as Array<{ reason: string }>
	).map((row) => row.reason);
}

function describeRows(fixture: TestDb, rows: readonly StoredRow[]): string {
	return `${rows
		.map(
			(row) =>
				`${row.id} ${row.attribute ?? "-"} superseded_by=${supersededBy(row) ?? "null"} :: ${row.text}`,
		)
		.join("\n")}\njournal: ${JSON.stringify(journalReasons(fixture))}`;
}

async function runExtraction(input: {
	store: MemoryStore;
	projectId: string;
	turns: readonly AtomicExtractionTurn[];
	transports: AtomicMemoryExtractionTransports;
	suffix: string;
}): Promise<void> {
	await runAtomicMemoryExtraction({
		store: input.store,
		projectId: input.projectId,
		ledgerKey: {
			conversationId: `same-turn-${input.suffix}`,
			chunkHash: `same-turn-chunk-${input.suffix}`,
			pipelineVersion: EXTRACTOR_VERSION,
		},
		turns: input.turns,
		rawChunk: input.turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
		routingSnapshotId: EXTRACTOR_VERSION,
		runParameters: RUN_PARAMETERS,
		estimatedInputTokens: 512,
		extractorVersion: EXTRACTOR_VERSION,
		sessionDateTime: new Date(SESSION_MS).toISOString(),
		sessionTimestampMs: SESSION_MS,
		sessionTimezone: "UTC",
		transports: input.transports,
		nowMs: () => SESSION_MS + 1_000,
		locale: "en",
	});
}

describe("rows born from one turn do not close each other at arrival", () => {
	it("keeps a timeline and its three phases live together", { timeout: 120_000 }, async () => {
		const projectId = "persona:same-turn-phases";
		const { fixture, store } = openStore();
		// The proposal's entity must already exist: a row written under an entity minted in the same
		// batch closes nothing mechanically (REQ-9), which is not the case under test.
		await runExtraction({
			store,
			projectId,
			turns: [{ role: "user", content: `The proposal is titled "${PROPOSAL}".` }],
			transports: scriptedTransports([
				proposalRecord({
					claim_text: `The proposal "${PROPOSAL}" has a lead engineer.`,
					attribute: "project.lead",
					value: "the lead engineer",
					source_span: { turn_index: 0, quote: "The proposal is titled" },
				}),
			]),
			suffix: "phases-seed",
		});
		await runExtraction({
			store,
			projectId,
			turns: [{ role: "user", content: TIMELINE_TURN }],
			transports: scriptedTransports([
				proposalRecord({}),
				proposalRecord({
					claim_text: "Phase 1 (Requirements & Design) is months 1-4.",
					value: "Phase 1 months 1-4",
					source_span: { turn_index: 0, quote: "Phase 1 (Requirements & Design) months 1-4" },
				}),
				proposalRecord({
					claim_text: "Phase 2 (Development & Testing) is months 5-13.",
					value: "Phase 2 months 5-13",
					source_span: { turn_index: 0, quote: "Phase 2 (Development & Testing) months 5-13" },
				}),
				proposalRecord({
					claim_text: "Phase 3 (Certification & Deployment) is months 14-18.",
					value: "Phase 3 months 14-18",
					source_span: {
						turn_index: 0,
						quote: "Phase 3 (Certification & Deployment) months 14-18",
					},
				}),
			]),
			suffix: "phases",
		});
		const rows = readRows(fixture, projectId).filter((row) => row.attribute === TIMELINE);
		const evidence = describeRows(fixture, rows);
		expect(rows, evidence).toHaveLength(4);
		expect(
			rows.filter((row) => supersededBy(row) === null),
			`facets of one statement closed each other.\n${evidence}`,
		).toHaveLength(4);
		expect(
			journalReasons(fixture).filter((reason) => reason.startsWith("closed_on_arrival")),
			evidence,
		).toHaveLength(0);
	});

	it(
		"never offers an ending the replacement stated in the same sentence",
		{ timeout: 120_000 },
		async () => {
			const projectId = "persona:same-turn-replacement";
			const { fixture, store } = openStore();
			// The replacement is listed first so it carries the lower rowid: the ordering that
			// offered it to its own ending's judgement (measured 2026-09-07, "drawn to imaginative
			// stories" closed by "no longer likes memoirs"). The scripted judge closes whatever it
			// is shown that mentions imaginative stories.
			const transports = scriptedTransports(
				[
					userRecord({
						claim_text: "The user is drawn to more imaginative stories.",
						value: "imaginative stories",
						source_span: { turn_index: 0, quote: "drawn to more imaginative stories" },
					}),
					userRecord({
						claim_text: "The user no longer likes memoirs; used to like them.",
						value: "memoirs",
						ends_current: true,
						source_span: { turn_index: 0, quote: "I've gone off memoirs" },
					}),
				],
				["imaginative stories"],
			);
			await runExtraction({
				store,
				projectId,
				turns: [
					{
						role: "user",
						content:
							"I've gone off memoirs lately; I'm drawn to more imaginative stories these days.",
					},
				],
				transports,
				suffix: "replacement",
			});
			const rows = readRows(fixture, projectId).filter((row) => row.attribute === READING);
			const evidence = describeRows(fixture, rows);
			const replacement = rows.find((row) => row.text.includes("imaginative"));
			const ending = rows.find((row) => row.text.includes("no longer likes memoirs"));
			expect(replacement, evidence).toBeDefined();
			expect(ending, evidence).toBeDefined();
			if (replacement === undefined || ending === undefined) return;
			expect(endsCurrent(ending), evidence).toBe(true);
			expect(
				transports.generic.closureQuestions.some((candidates) =>
					candidates.some((candidate) => candidate.id === replacement.id),
				),
				`the ending was offered its own replacement as a retirement candidate.\n${evidence}`,
			).toBe(false);
			expect(
				supersededBy(replacement),
				`the replacement was retired by its own ending.\n${evidence}`,
			).toBeNull();
		},
	);

	it("keeps two dated deadlines of one turn both live", { timeout: 120_000 }, async () => {
		const projectId = "persona:same-turn-dates";
		const { fixture, store } = openStore();
		// The proposal's entity must already exist: a row written under an entity minted in the same
		// batch closes nothing mechanically (REQ-9), which is not the case under test.
		await runExtraction({
			store,
			projectId,
			turns: [{ role: "user", content: `The proposal is titled "${PROPOSAL}".` }],
			transports: scriptedTransports([
				proposalRecord({
					claim_text: `The proposal "${PROPOSAL}" has a lead engineer.`,
					attribute: "project.lead",
					value: "the lead engineer",
					source_span: { turn_index: 0, quote: "The proposal is titled" },
				}),
			]),
			suffix: "dates-seed",
		});
		// Measured 2026-09-07 (creative designer): the later-dated deadline closed the earlier one
		// backward, because the comparison reads dates before turns.
		await runExtraction({
			store,
			projectId,
			turns: [
				{
					role: "user",
					content:
						"The presentation slide deck is due June 6 and the follow-up meeting with the client is June 9.",
				},
			],
			transports: scriptedTransports([
				proposalRecord({
					claim_text: "The presentation slide deck is due 2026-06-06.",
					value: "slide deck due 2026-06-06",
					temporal_phrase: "June 6",
					resolved_time: "2026-06-06",
					source_span: { turn_index: 0, quote: "slide deck is due June 6" },
				}),
				proposalRecord({
					claim_text: "The follow-up meeting with the client is due 2026-06-09.",
					value: "follow-up meeting 2026-06-09",
					temporal_phrase: "June 9",
					resolved_time: "2026-06-09",
					source_span: { turn_index: 0, quote: "follow-up meeting with the client is June 9" },
				}),
			]),
			suffix: "dates",
		});
		const rows = readRows(fixture, projectId).filter((row) => row.attribute === TIMELINE);
		const evidence = describeRows(fixture, rows);
		expect(rows, evidence).toHaveLength(2);
		expect(rows.filter((row) => supersededBy(row) === null), evidence).toHaveLength(2);
		expect(
			journalReasons(fixture).filter((reason) => reason.startsWith("closed_on_arrival")),
			evidence,
		).toHaveLength(0);
	});

	it(
		"keeps a same-turn revision as an ended value beside the new one",
		{ timeout: 120_000 },
		async () => {
			const projectId = "persona:same-turn-revision";
			const { fixture, store } = openStore();
			// The proposal's entity must already exist: a row written under an entity minted in the same
			// batch closes nothing mechanically (REQ-9), which is not the case under test.
			await runExtraction({
				store,
				projectId,
				turns: [{ role: "user", content: `The proposal is titled "${PROPOSAL}".` }],
				transports: scriptedTransports([
						proposalRecord({
							claim_text: `The proposal "${PROPOSAL}" has a lead engineer.`,
							attribute: "project.lead",
							value: "the lead engineer",
							source_span: { turn_index: 0, quote: "The proposal is titled" },
						}),
				]),
				suffix: "revision-seed",
			});
			await runExtraction({
				store,
				projectId,
				turns: [
					{ role: "user", content: "The budget was $500,000; it is now $600,000." },
				],
				transports: scriptedTransports([
					proposalRecord({
						claim_text: "The proposal's budget is no longer $500,000; it was $500,000.",
						attribute: BUDGET,
						value: "$500,000",
						ends_current: true,
						source_span: { turn_index: 0, quote: "The budget was $500,000" },
					}),
					proposalRecord({
						claim_text: "The proposal's budget is $600,000.",
						attribute: BUDGET,
						value: "$600,000",
						source_span: { turn_index: 0, quote: "it is now $600,000" },
					}),
				]),
				suffix: "revision",
			});
			const rows = readRows(fixture, projectId).filter((row) => row.attribute === BUDGET);
			const evidence = describeRows(fixture, rows);
			const ended = rows.find((row) => row.text.includes("no longer"));
			const current = rows.find((row) => row.text.includes("$600,000"));
			expect(ended, evidence).toBeDefined();
			expect(current, evidence).toBeDefined();
			if (ended === undefined || current === undefined) return;
			// The ended value is the model's own ending (REQ-8: it stays live as the current state
			// of that value); the new value is live; nothing was closed mechanically.
			expect(endsCurrent(ended), evidence).toBe(true);
			expect(supersededBy(ended), evidence).toBeNull();
			expect(supersededBy(current), evidence).toBeNull();
		},
	);

	it("still closes an earlier session's value on a one-cardinality arrival", { timeout: 120_000 }, async () => {
		const projectId = "persona:same-turn-cross-turn";
		const { fixture, store } = openStore();
		// Two sessions, as a real revision arrives: the proposal's entity exists before the second
		// value is written (a row under an entity minted in the same batch closes nothing, REQ-9).
		await runExtraction({
			store,
			projectId,
			turns: [{ role: "user", content: "The project timeline is 12 months." }],
			transports: scriptedTransports([
				proposalRecord({
					claim_text: "The project timeline is 12 months.",
					value: "12 months",
					source_span: { turn_index: 0, quote: "The project timeline is 12 months" },
				}),
			]),
			suffix: "cross-turn-first",
		});
		await runExtraction({
			store,
			projectId,
			turns: [{ role: "user", content: "Correction: the project timeline is 18 months." }],
			transports: scriptedTransports([
				proposalRecord({
					claim_text: "The project timeline is 18 months.",
					value: "18 months",
					source_span: { turn_index: 0, quote: "the project timeline is 18 months" },
				}),
			]),
			suffix: "cross-turn-second",
		});
		const rows = readRows(fixture, projectId).filter((row) => row.attribute === TIMELINE);
		const evidence = describeRows(fixture, rows);
		const earlier = rows.find((row) => row.text.includes("12 months"));
		const later = rows.find((row) => row.text.includes("18 months"));
		expect(earlier, evidence).toBeDefined();
		expect(later, evidence).toBeDefined();
		if (earlier === undefined || later === undefined) return;
		expect(
			supersededBy(earlier),
			`the earlier value stayed current after a later session replaced it.\n${evidence}`,
		).toBe(later.id);
		expect(supersededBy(later), evidence).toBeNull();
		// The identity that settles "one turn" is the conversation, not the session ordinal: the
		// ordinal is computed at write time from the ledger's order, so a conversation arriving
		// later with an earlier first write renumbers the others and two rows of different
		// conversations can carry the same stored ordinal.
		const conversationOf = (row: StoredRow): unknown =>
			(JSON.parse(row.metadata) as Record<string, Record<string, unknown> | undefined>)
				["source_order"]?.["conversation_id"];
		expect(conversationOf(earlier), evidence).toBe("same-turn-cross-turn-first");
		expect(conversationOf(later), evidence).toBe("same-turn-cross-turn-second");
	});
});
