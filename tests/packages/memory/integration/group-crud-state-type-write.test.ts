/** @file PRD 150 QCG-13 — `kind` in, store category out, on the real pipeline. No mocks.
 *
 * Two halves, because two different things have to be true. The first runs the real extraction
 * against the real Sno GPU and asserts the invariants that hold whatever wording the model
 * chooses. The second scripts the model's reply so the routing table itself — the wrong-list
 * slug, the re-ask, the agent subject, the unplaceable claim — is pinned exactly.
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
	createSignedAtomicMemoryExtractionTransports,
	runAtomicMemoryExtraction,
} from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction";
import type { AtomicSubjectGuardTransport } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-subject-guard";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import { llmRoutingConfigSchema } from "../../../../packages/sno-station-mem/src/contract/config/plugin-config-mode-schema";
import {
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/sno-station-mem/src/store/store";
import { applyStateCategoryMigration } from "../../../../packages/sno-station-mem/src/store/state-category-migration";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const PROJECT_ID = "group-crud-state-write";
const EXTRACTOR_VERSION = "atomic-v3-state-write-test";
const SESSION_MS = Date.UTC(2026, 8, 4, 12, 0);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 4_096,
	subchunkCount: 1,
};

interface StoredRow {
	id: string;
	text: string;
	category: string;
	subject: string | null;
	attribute: string | null;
	metadata: string;
}

/** The session QCG-13 names: a proposal, a meeting, an e-mail, a purchase and a taste. */
const JOURNEY_TURNS: AtomicExtractionTurn[] = [
	{
		role: "user",
		content:
			'The project proposal is titled "Regional Grid Resilience Study". The proposed budget for it is $420,000.',
	},
	{ role: "assistant", content: "Noted. Anything about the meeting?" },
	{
		role: "user",
		content:
			"In the 'Q3 Reliability Review' meeting notes, Dr. Tanaka was present, and the email about the study should go to the Head of Operations.",
	},
	{ role: "assistant", content: "Got it. Anything else from today?" },
	{
		role: "user",
		content: "I spent $6.40 on coffee this morning, and I really like Thelonious Monk's records.",
	},
];

/**
 * The five facts QCG-13 seeds, each with the store the PRD says it lands in and an anchor that
 * survives any wording the model chooses. The three record fields are `state` rows keyed from
 * the state vocabulary; the purchase is an occurrence; the taste is the user's own.
 */
const SEEDED_FACTS: ReadonlyArray<{
	name: string;
	anchor: RegExp;
	category: "state" | "profile" | "episodic";
	attribute: string | null;
}> = [
	{
		name: "the proposal's budget",
		anchor: /420[,.]?000|420k/i,
		category: "state",
		attribute: "project.budget",
	},
	{
		name: "the meeting's attendee",
		anchor: /Tanaka/,
		category: "state",
		attribute: "meeting.attendee",
	},
	{
		name: "the e-mail's recipient",
		anchor: /Head of Operations/i,
		category: "state",
		attribute: "email.recipient",
	},
	{ name: "the coffee purchase", anchor: /6\.40?\b/, category: "episodic", attribute: null },
	{ name: "the music taste", anchor: /Monk/, category: "profile", attribute: null },
];

/** The task line `reaskStandingSubjects` puts in its prompt; the only stable mark of that call. */
const REASK_TASK_LINE = "Task: resolve each unresolved standing subject";

function refusedJournalRows(
	database: TestDb["sqlite"],
): Array<{ reason: string; detail: string | null }> {
	return database
		.prepare("SELECT reason, detail FROM nodix_rem_journal WHERE outcome = 'refused'")
		.all() as Array<{ reason: string; detail: string | null }>;
}

function describeRows(rows: readonly StoredRow[]): string {
	return rows
		.map((row) => `${row.category} ${row.subject ?? "-"} ${row.attribute ?? "-"} | ${row.text}`)
		.join("\n");
}

function readRows(database: TestDb["sqlite"]): StoredRow[] {
	return database
		.prepare(
			"SELECT id, text, category, subject, attribute, metadata FROM nodix_memories WHERE project_id = ? ORDER BY rowid",
		)
		.all(PROJECT_ID) as StoredRow[];
}

function wireRecord(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		kind: "standing",
		claim_text: "The user prefers tea.",
		subject: "user",
		subject_kind: "user",
		attribute: "preference.food",
		value: "tea",
		temporal_phrase: null,
		resolved_time: null,
		importance: "medium",
		changes_current_state: false,
		// REQ-8: the model says whether the claim states an ending. These journey records state
		// none, so every row here is written live.
		ends_current: false,
		ended_at: null,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: 0, quote: "I prefer tea." },
		relations: [],
		single_claim: true,
		...overrides,
	};
}

class ScriptedGenericTransport implements AtomicGenericExtractionTransport {
	readonly requests: AtomicGenericExtractionRequest[] = [];
	private call = 0;

	constructor(private readonly replies: readonly string[]) {}

	async complete(request: AtomicGenericExtractionRequest) {
		this.requests.push(request);
		const reply = this.replies[Math.min(this.call, this.replies.length - 1)] ?? "{}";
		this.call += 1;
		return { text: reply, truncated: false };
	}
}

class RecordingKeyingTransport implements AtomicProfileKeyingTransport {
	readonly calls: Array<Parameters<AtomicProfileKeyingTransport["keyTurn"]>[0]> = [];

	async keyTurn(input: Parameters<AtomicProfileKeyingTransport["keyTurn"]>[0]) {
		this.calls.push(input);
		return [];
	}
}

class NoResplitTransport implements AtomicResplitTransport {
	async resplit() {
		return null;
	}
}

class RecordingSubjectGuard implements AtomicSubjectGuardTransport {
	readonly guardCalls: Array<Parameters<AtomicSubjectGuardTransport["guardUserSubjects"]>[0]> = [];

	async repairMissingHalf() {
		return [];
	}

	async guardUserSubjects(
		input: Parameters<AtomicSubjectGuardTransport["guardUserSubjects"]>[0],
	) {
		this.guardCalls.push(input);
		return input.records.map(() => true);
	}
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("PRD 150 QCG-13 — the store category is derived in code from kind and subject kind", () => {
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(() => {
		store?.closeSync();
		fixture?.cleanup();
		store = undefined;
		fixture = undefined;
	});

	function setup(): { store: MemoryStore; database: TestDb["sqlite"] } {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		applyStateCategoryMigration(fixture.sqlite);
		return { store, database: fixture.sqlite };
	}

	async function run(
		target: { store: MemoryStore },
		turns: readonly AtomicExtractionTurn[],
		transports: AtomicMemoryExtractionTransports,
		suffix: string,
	) {
		return runAtomicMemoryExtraction({
			store: target.store,
			projectId: PROJECT_ID,
			ledgerKey: {
				conversationId: `state-write-${suffix}`,
				chunkHash: `state-write-chunk-${suffix}`,
				pipelineVersion: EXTRACTOR_VERSION,
			},
			turns,
			rawChunk: turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n"),
			routingSnapshotId: EXTRACTOR_VERSION,
			runParameters: RUN_PARAMETERS,
			estimatedInputTokens: 512,
			extractorVersion: EXTRACTOR_VERSION,
			sessionDateTime: new Date(SESSION_MS).toISOString(),
			sessionTimestampMs: SESSION_MS,
			sessionTimezone: "UTC",
			transports,
			nowMs: () => SESSION_MS,
			locale: "en",
		});
	}

	it("routes a real session's claims to the three stores, and calls the person adapter only for the person", async () => {
		const apiKey = process.env.SNO_MEM_CLAW_LLM_INTERNAL_KEY;
		if (!apiKey) throw new Error("SNO_MEM_CLAW_LLM_INTERNAL_KEY is required; this test is real");
		const target = setup();
		const signed = createSignedAtomicMemoryExtractionTransports(
			{
				preset: "mem_claw/sno_extract_chat",
				apiKey,
				routing: llmRoutingConfigSchema.parse({ mode: "rem-enhanced" }),
				timeoutMs: 180_000,
			},
			"en",
		);
		const keying = new RecordingKeyingTransport();
		const guard = new RecordingSubjectGuard();
		await run(
			target,
			JOURNEY_TURNS,
			{ ...signed, profileKeying: keying, subjectGuard: guard },
			"real",
		);

		const rows = readRows(target.database);
		expect(rows.length).toBeGreaterThan(0);

		for (const row of rows) {
			const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
			expect(["episodic", "profile", "state"]).toContain(row.category);
			// The model is never asked where a claim is kept; the row's category is code's answer.
			if (row.category === "state") {
				expect(row.subject).toMatch(/^entity:/);
				expect(metadata.event_at).toBeUndefined();
				expect(metadata.section_name).toBeUndefined();
			}
			if (row.category === "profile") expect(["user", "agent"]).toContain(row.subject);
			if (row.category === "episodic") expect(metadata.event_at).toBeDefined();
		}

		// The person-profile adapter is trained on the user alone. A row about a proposal, a
		// meeting or an e-mail must never reach it — that mixing is the defect this change removes.
		const keyedTurns = keying.calls.length;
		expect(keyedTurns).toBeLessThanOrEqual(
			rows.filter((row) => row.category === "profile" && row.subject === "user").length,
		);
		const guardedIds = guard.guardCalls.flatMap((call) => call.records.map(() => true));
		expect(guardedIds.length).toBeLessThanOrEqual(
			rows.filter((row) => row.category === "profile").length,
		);
		// QCG-13 names five facts and the store each one lands in. Each is found by an anchor no
		// paraphrase can drop, so a model that reads the budget and the coffee and nothing else —
		// which "some state row, some episodic row" let through — fails here by name.
		for (const fact of SEEDED_FACTS) {
			const row = rows.find((candidate) => fact.anchor.test(candidate.text));
			expect(
				row,
				`${fact.name} was dropped: no row matches ${fact.anchor}\n${describeRows(rows)}`,
			).toBeDefined();
			expect(
				row?.category,
				`${fact.name} landed in ${row?.category}, not ${fact.category}\n${describeRows(rows)}`,
			).toBe(fact.category);
			if (fact.category === "state") {
				expect(row?.subject, `${fact.name} is a state row without an entity subject`).toMatch(
					/^entity:/,
				);
				expect(
					row?.attribute,
					`${fact.name} was stored under ${row?.attribute ?? "no key"}, not ${fact.attribute}: ${row?.subject} | ${row?.text}`,
				).toBe(fact.attribute);
			}
			if (fact.category === "profile") {
				expect(row?.subject, `${fact.name} is a profile row not about the user`).toBe("user");
			}
			if (fact.category === "episodic") {
				expect(
					JSON.parse(row?.metadata ?? "{}").event_at,
					`${fact.name} is an episodic row with no event_at`,
				).toBeDefined();
			}
		}
	}, 300_000);

	it("stores a wrong-list slug unkeyed, routes the agent to profile, and never drops a claim", async () => {
		const target = setup();
		const reply = JSON.stringify({
			records: [
				wireRecord({
					kind: "standing",
					claim_text: 'The "Regional Grid Resilience Study" proposal has a budget of $420,000.',
					subject: "Regional Grid Resilience Study",
					subject_kind: "named_entity",
					attribute: "project.budget",
					value: "$420,000",
					source_span: { turn_index: 0, quote: "The proposed budget for it is $420,000." },
				}),
				wireRecord({
					kind: "standing",
					claim_text: 'The "Regional Grid Resilience Study" proposal is led by the grid team.',
					subject: "Regional Grid Resilience Study",
					subject_kind: "named_entity",
					// A person slug on a thing: the wrong list. It must be stored unkeyed, not applied.
					attribute: "identity.occupation",
					value: "the grid team",
					source_span: { turn_index: 0, quote: "The project proposal is titled" },
				}),
				wireRecord({
					kind: "standing",
					claim_text: "The assistant answers in English.",
					subject: "assistant",
					subject_kind: "agent",
					attribute: "preference.language",
					value: "English",
					source_span: { turn_index: 1, quote: "Noted." },
				}),
				wireRecord({
					kind: "standing",
					claim_text: "The project is on hold.",
					subject: "the project",
					subject_kind: "unresolved",
					attribute: null,
					value: "on hold",
					source_span: { turn_index: 2, quote: "the email about the study" },
				}),
				wireRecord({
					kind: "occurrence",
					claim_text: "The user spent $6.40 on coffee.",
					subject: "user",
					subject_kind: "user",
					attribute: null,
					value: "$6.40",
					source_span: { turn_index: 4, quote: "I spent $6.40 on coffee this morning" },
				}),
			],
		});
		// The re-ask is a second generic call. This one answers the one unresolved record with an
		// explicit null — the branch that must land as episodic rather than as an unkeyed standing
		// row or a dropped claim. An answer that simply omitted the record would not be an answer,
		// and is retried instead.
		const generic = new ScriptedGenericTransport([
			reply,
			JSON.stringify({ resolutions: [{ record_index: 0, subject: null }] }),
		]);
		const keying = new RecordingKeyingTransport();
		await run(
			target,
			JOURNEY_TURNS,
			{
				generic,
				profileKeying: keying,
				resplit: new NoResplitTransport(),
				subjectGuard: new RecordingSubjectGuard(),
			},
			"scripted",
		);

		const rows = readRows(target.database);
		const byValue = (needle: string): StoredRow | undefined =>
			rows.find((row) => row.text.includes(needle));

		const budget = byValue("$420,000");
		expect(budget?.category).toBe("state");
		expect(budget?.subject).toMatch(/^entity:/);
		expect(budget?.attribute).toBe("project.budget");

		// The person slug offered for a thing is refused as a key and the row is still stored.
		const wrongList = byValue("grid team");
		expect(wrongList?.category).toBe("state");
		expect(wrongList?.attribute).toBeNull();

		const agent = byValue("answers in English");
		expect(agent?.category).toBe("profile");
		expect(agent?.subject).toBe("agent");

		// The unresolved standing row is re-asked once, with the session's named proposal offered.
		// Found by the prompt's own task line, not by call order: the entity-identity judgement
		// also speaks to this transport, so "the second call" is not a stable address.
		const reasks = generic.requests.filter((request) => request.prompt.includes(REASK_TASK_LINE));
		expect(
			reasks,
			`the unresolved standing row was never re-asked (${generic.requests.length} generic call(s), none carrying the re-ask task)`,
		).toHaveLength(1);
		const reaskPrompt = reasks[0]?.prompt ?? "";
		expect(reaskPrompt, "the re-ask was made without the unresolved row").toContain(
			"The project is on hold.",
		);
		expect(
			reaskPrompt,
			"the re-ask did not offer the session's named proposal as a candidate",
		).toContain("Regional Grid Resilience Study");

		// Re-asked and still unresolved: episodic with the session time, never a subjectless state row.
		const onHold = byValue("on hold");
		expect(
			onHold?.category,
			`re-asked, but the unresolvable row was written as ${onHold?.category} instead of episodic`,
		).toBe("episodic");
		expect(onHold?.subject, "re-asked, but the unresolvable row kept a subject").toBeNull();
		expect(
			JSON.parse(onHold?.metadata ?? "{}").event_at,
			"re-asked, but the unresolvable row was written without the session time",
		).toBeDefined();
		expect(rows.some((row) => row.category === "state" && row.subject === null)).toBe(false);

		const coffee = byValue("$6.40");
		expect(coffee?.category).toBe("episodic");
		expect(JSON.parse(coffee?.metadata ?? "{}").event_at).toBeDefined();

		// Five claims in, five rows out: nothing is dropped on any branch.
		expect(rows).toHaveLength(5);
		// The adapter is called for the user's own rows only — never for the proposal or the agent.
		for (const call of keying.calls) {
			expect(JSON.stringify(call)).not.toContain("Regional Grid Resilience Study");
		}

		// The wrong-list slug was refused AND journalled: the refusal must be readable back from the
		// store, naming the slug it turned away. A log line is not a journal row.
		const refusals = refusedJournalRows(target.database);
		expect(
			refusals.filter((row) => `${row.reason} ${row.detail ?? ""}`.includes("identity.occupation")),
			`the wrong-list slug identity.occupation was cleared but no refused journal row names it; refused rows: ${JSON.stringify(refusals)}`,
		).toHaveLength(1);
	}, 120_000);

	it("offers a candidate registered in an EARLIER session by display name, so an unnamed claim resolves onto it", async () => {
		const target = setup();

		// First session: the proposal is named, so the product registers it as an entity.
		const firstTurns: AtomicExtractionTurn[] = [
			{
				role: "user",
				content:
					'The project proposal is titled "Regional Grid Resilience Study"; its objective is to assess grid resilience across the region.',
			},
		];
		const firstReply = JSON.stringify({
			records: [
				wireRecord({
					kind: "standing",
					claim_text:
						'The "Regional Grid Resilience Study" proposal aims to assess grid resilience across the region.',
					subject: "Regional Grid Resilience Study",
					subject_kind: "named_entity",
					attribute: "project.objective",
					value: "assess grid resilience across the region",
					source_span: {
						turn_index: 0,
						quote: "its objective is to assess grid resilience across the region.",
					},
				}),
			],
		});
		// The entity-identity judgement is the second generic call of this pass; "new" mints a real
		// `entity:<uuid>` id, the opaque shape a later session receives from the store.
		await run(
			target,
			firstTurns,
			{
				generic: new ScriptedGenericTransport([firstReply, JSON.stringify({ entity_id: "new" })]),
				profileKeying: new RecordingKeyingTransport(),
				resplit: new NoResplitTransport(),
				subjectGuard: new RecordingSubjectGuard(),
			},
			"earlier-session",
		);
		const entities = target.database
			.prepare(
				"SELECT entity_id AS entityId, display_name AS displayName FROM nodix_memory_entities WHERE project_id = ?",
			)
			.all(PROJECT_ID) as Array<{ entityId: string; displayName: string }>;
		expect(entities, "the first session did not register the proposal").toHaveLength(1);
		const proposal = entities[0]!;
		expect(proposal.displayName).toBe("Regional Grid Resilience Study");
		expect(proposal.entityId).toMatch(/^entity:[0-9a-f-]{36}$/);
		const objective = readRows(target.database).find(
			(row) => row.attribute === "project.objective",
		);
		expect(objective?.subject, "the first session's keyed row is not on the registered entity").toBe(
			proposal.entityId,
		);

		// Later session: the budget is stated without the proposal's name. Nothing in this batch is
		// a named entity, so the stored proposal is the only candidate the re-ask can offer.
		const laterTurns: AtomicExtractionTurn[] = [
			{ role: "user", content: "The budget is $2,900,000." },
		];
		const laterReply = JSON.stringify({
			records: [
				wireRecord({
					kind: "standing",
					claim_text: "The budget is $2,900,000.",
					subject: "the proposal",
					subject_kind: "unresolved",
					attribute: "project.budget",
					value: "$2,900,000",
					source_span: { turn_index: 0, quote: "The budget is $2,900,000." },
				}),
			],
		});
		const generic = new ScriptedGenericTransport([
			laterReply,
			JSON.stringify({ resolutions: [{ record_index: 0, subject: proposal.entityId }] }),
		]);
		await run(
			target,
			laterTurns,
			{
				generic,
				profileKeying: new RecordingKeyingTransport(),
				resplit: new NoResplitTransport(),
				subjectGuard: new RecordingSubjectGuard(),
			},
			"later-session",
		);

		const reasks = generic.requests.filter((request) => request.prompt.includes(REASK_TASK_LINE));
		expect(
			reasks,
			`the unnamed budget claim was never re-asked (${generic.requests.length} generic call(s), none carrying the re-ask task)`,
		).toHaveLength(1);
		const reaskPrompt = reasks[0]?.prompt ?? "";
		expect(reaskPrompt, "the re-ask did not offer the stored proposal's id").toContain(
			proposal.entityId,
		);
		// The measured defect: the stored candidate arrived as a bare id. Without its display name no
		// reader can tell which document it is, so "The budget is $2,900,000." resolved to null and
		// went unkeyed as episodic — never closing, never closed by, the proposal's other budgets.
		expect(
			reaskPrompt,
			"the re-ask offered the stored proposal as a bare id, without its display name",
		).toContain("Regional Grid Resilience Study");

		// Resolved onto the stored entity: a keyed state row on the SAME id, and no second entity.
		const rows = readRows(target.database);
		const budget = rows.find((row) => row.text.includes("$2,900,000"));
		expect(budget, `the budget claim was dropped\n${describeRows(rows)}`).toBeDefined();
		expect(budget?.category, describeRows(rows)).toBe("state");
		expect(budget?.subject, "the budget row is not on the earlier session's entity").toBe(
			proposal.entityId,
		);
		expect(budget?.attribute).toBe("project.budget");
		expect(
			target.database
				.prepare("SELECT COUNT(*) AS n FROM nodix_memory_entities WHERE project_id = ?")
				.get(PROJECT_ID),
		).toEqual({ n: 1 });
	}, 120_000);
});
