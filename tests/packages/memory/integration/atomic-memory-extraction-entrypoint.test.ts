/** @file Proves the complete atomic extraction entrypoint against encrypted SQLite. */

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
	type ClaimedFact,
	runAtomicMemoryExtraction,
} from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-memory-extraction";
import type { AtomicSubjectGuardTransport } from "../../../../packages/sno-station-mem/src/engine/extraction/atomic-subject-guard";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import { ATOMIC_MEMORY_VALID_INTERVAL_CHECK_SQL } from "../../../../packages/sno-station-mem/src/store/atomic-memory-cutover-sql";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-entrypoint-project";
const EXTRACTOR_VERSION = "atomic-v3-entrypoint-test";
const SESSION_TIMESTAMP_MS = Date.UTC(2026, 8, 3, 20, 15);
const EVENT_FROM_MS = Date.UTC(2026, 8, 2, 20, 15);
const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

interface StoredRow {
	id: string;
	text: string;
	category: string;
	project_id?: string;
	subject: string | null;
	attribute: string | null;
	valid_from: number | null;
	valid_until: number | null;
	maturity: string | null;
	source: string | null;
	extractor_version: string | null;
	lane: string;
	disposition_reason: string | null;
	metadata: string;
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
		time: { kind: "none" }, ended_time: { kind: "none" },
		resolved_time: null,
		importance: "medium",
		changes_current_state: false,
		ends_current: false,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: 0, quote: "I prefer tea." },
		relations: [],
		single_claim: true,
		...overrides,
	};
}

/** The lane-1 capture face of a record: the fields the merge carries by code, keyed by id. */
function captureFactRecord(record: Record<string, unknown>, id: number): Record<string, unknown> {
	return {
		id,
		fact: record.claim_text,
		subject: record.subject,
		subject_kind: record.subject_kind,
		temporal_phrase: record.temporal_phrase ?? null,
		ended_at_phrase: record.ended_at_phrase ?? null,
		source_span: record.source_span,
	};
}

/** The lane-2 enrichment face of a record: the classification fields, keyed by the same id. */
function enrichmentReplyRecord(record: Record<string, unknown>, id: number): Record<string, unknown> {
	return {
		id,
		kind: record.kind,
		attribute: record.attribute,
		value: record.value,
		ends_current: record.ends_current,
		importance: record.importance,
		changes_current_state: record.changes_current_state,
		todo: record.todo,
		close_reason: record.close_reason,
		single_claim: record.single_claim,
		relations: record.relations,
		time: record.time,
		ended_time: record.ended_time,
	};
}

class FixedGenericTransport implements AtomicGenericExtractionTransport {
	readonly requests: AtomicGenericExtractionRequest[] = [];
	private readonly records: Array<Record<string, unknown>>;

	constructor(reply: string, private readonly progressTurns: readonly number[] = []) {
		this.records = (JSON.parse(reply) as { records: Array<Record<string, unknown>> }).records;
	}

	async complete(request: AtomicGenericExtractionRequest) {
		this.requests.push(request);
		if (request.prompt.includes("Task: resolve each unresolved standing subject")) {
			const data = JSON.parse(request.prompt.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "null") as { records: Array<{ recordIndex: number }> };
			return { text: JSON.stringify({ resolutions: data.records.map(({ recordIndex }) => ({ record_index: recordIndex, subject: null })) }), truncated: false };
		}
		if (request.prompt.includes('"new_display_name":')) return { text: '{"entity_id":"new"}', truncated: false };
		// Lane 2 (enrichment): the prompt carries a `facts:` block. Return one enrichment per
		// requested id, mapped back to the scripted record by its id.
		if (request.prompt.includes("facts:\n")) {
			const facts = JSON.parse(request.prompt.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]") as Array<{ id: number }>;
			const missing = facts.find(({ id }) => this.records[id] === undefined);
			if (missing) throw new Error(`enrichment asked for unknown fact id ${missing.id}`);
			return { text: JSON.stringify({ enrichments: facts.map(({ id }) => enrichmentReplyRecord(this.records[id] as Record<string, unknown>, id)) }), truncated: false };
		}
		// Lane 1 (capture): decisions for every user turn, one fact per scripted record.
		const turns = JSON.parse(request.prompt.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]") as Array<{role: string; turn_index: number}>;
		return { text: JSON.stringify({
			claims_found: this.records.map((record) => record.claim_text),
			decisions: turns.filter((turn) => turn.role === "user").map((turn) => ({ turn_index: turn.turn_index, progress_only: this.progressTurns.includes(turn.turn_index) })),
			facts: this.records.map((record, id) => captureFactRecord(record, id)),
		}), truncated: false };
	}
}

class EmptyKeyingTransport implements AtomicProfileKeyingTransport {
	readonly calls: Array<Parameters<AtomicProfileKeyingTransport["keyTurn"]>[0]> = [];

	async keyTurn(input: Parameters<AtomicProfileKeyingTransport["keyTurn"]>[0]) {
		this.calls.push(input);
		return [];
	}
}

class FailedResplitTransport implements AtomicResplitTransport {
	readonly calls: Array<Parameters<AtomicResplitTransport["resplit"]>[0]> = [];

	async resplit(input: Parameters<AtomicResplitTransport["resplit"]>[0]) {
		this.calls.push(input);
		return null;
	}
}

class AllowSubjectGuardTransport implements AtomicSubjectGuardTransport {
	readonly repairCalls: Array<
		Parameters<AtomicSubjectGuardTransport["repairMissingHalf"]>[0]
	> = [];
	readonly guardCalls: Array<Parameters<AtomicSubjectGuardTransport["guardUserSubjects"]>[0]> = [];

	async repairMissingHalf(
		input: Parameters<AtomicSubjectGuardTransport["repairMissingHalf"]>[0],
	) {
		this.repairCalls.push(input);
		return [];
	}

	async guardUserSubjects(
		input: Parameters<AtomicSubjectGuardTransport["guardUserSubjects"]>[0],
	) {
		this.guardCalls.push(input);
		return input.records.map(() => true);
	}
}

function transports(replyRecords: readonly Record<string, unknown>[], progressTurns: readonly number[] = []): {
	value: AtomicMemoryExtractionTransports;
	generic: FixedGenericTransport;
	profileKeying: EmptyKeyingTransport;
	resplit: FailedResplitTransport;
	subjectGuard: AllowSubjectGuardTransport;
} {
	const generic = new FixedGenericTransport(JSON.stringify({ records: replyRecords }), progressTurns);
	const profileKeying = new EmptyKeyingTransport();
	const resplit = new FailedResplitTransport();
	const subjectGuard = new AllowSubjectGuardTransport();
	return {
		value: { generic, profileKeying, resplit, subjectGuard },
		generic,
		profileKeying,
		resplit,
		subjectGuard,
	};
}

function ledgerKey(suffix: string): AtomicExtractionLedgerKey {
	return {
		conversationId: `atomic-entrypoint-${suffix}`,
		chunkHash: `atomic-entrypoint-chunk-${suffix}`,
		pipelineVersion: EXTRACTOR_VERSION,
	};
}

function assertProjectWall(rows: readonly StoredRow[], projectId: string): void {
	for (const row of rows) {
		if (row.project_id !== projectId) {
			throw new Error(`project wall failed: expected ${projectId}, got ${String(row.project_id)}`);
		}
	}
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic memory extraction production entrypoint", () => {
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
		return { store, database: fixture.sqlite };
	}

	it("writes the legal journey outcomes through one product boundary and keeps the wall", async () => {
		const target = setup();
		const turns: AtomicExtractionTurn[] = [
			{ role: "user", content: "I prefer tea." },
			{ role: "user", content: "At 20:15 on 2 September 2026, I moved to Kyoto." },
			{ role: "user", content: "Ada Lovelace is a mathematician. They prefer notebooks." },
			{ role: "user", content: "I prefer curry and jazz." },
			{ role: "user", content: "I am halfway through writing the release notes." },
		];
		const genericRecords = [
			wireRecord({}),
			wireRecord({
				kind: "occurrence",
				claim_text: "At 20:15 on 2 September 2026, the user moved to Kyoto.",
				attribute: "identity.location",
				value: "Kyoto",
				temporal_phrase: "At 20:15 on 2 September 2026",
				time: { kind: "absolute", year: 2026, month: 9, day: 2, hour: 20, minute: 15, precision: "minute" },
				source_span: { turn_index: 1, quote: turns[1]?.content },
			}),
			wireRecord({
				claim_text: "Ada Lovelace is a mathematician.",
				subject: "Ada Lovelace",
				subject_kind: "named_entity",
				attribute: "identity.occupation",
				value: "mathematician",
				source_span: { turn_index: 2, quote: "Ada Lovelace is a mathematician." },
			}),
			wireRecord({
				claim_text: "They prefer notebooks.",
				subject: "they",
				subject_kind: "unresolved",
				attribute: "preference.tools",
				value: "notebooks",
				source_span: { turn_index: 2, quote: "They prefer notebooks." },
			}),
			wireRecord({
				claim_text: "The user prefers curry and jazz.",
				attribute: "preference.food",
				value: "curry and jazz",
				source_span: { turn_index: 3, quote: turns[3]?.content },
				single_claim: false,
			}),
		];
		const scripted = transports(genericRecords);
		let nowMs = SESSION_TIMESTAMP_MS;

		const result = await runAtomicMemoryExtraction({
			store: target.store,
			projectId: PROJECT_ID,
			ledgerKey: ledgerKey("records"),
			turns,
			rawChunk: turns.map(({ role, content }) => `${role}: ${content}`).join("\n"),
			routingSnapshotId: "atomic-entrypoint-routing",
			runParameters: RUN_PARAMETERS,
			estimatedInputTokens: 120,
			extractorVersion: EXTRACTOR_VERSION,
			sessionDateTime: "2026-09-03T20:15:00Z",
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			sessionTimezone: "UTC",
			transports: scripted.value,
			nowMs: () => nowMs++,
		});
		if (result.status !== "complete") throw new Error(`unexpected result ${result.status}`);

		expect(result.write).toMatchObject({
			createdCount: 5,
			ledger: { state: "complete" },
		});
		expect(scripted.generic.requests.map(({ prompt }) =>
			prompt.includes("Task: resolve each unresolved standing subject") ? "resolve-subject" :
			prompt.includes('"new_display_name":') ? "entity-identity" : "extraction",
		)).toEqual(["extraction", "extraction", "resolve-subject", "entity-identity"]);
		expect(scripted.profileKeying.calls.map(({ turnIndex }) => turnIndex)).toEqual([0, 3]);
		expect(scripted.resplit.calls).toHaveLength(1);
		expect(scripted.subjectGuard.guardCalls).toHaveLength(1);
		const rows = target.database
			.prepare(
				`SELECT id, text, category, project_id, subject, attribute, valid_from, valid_until,
					maturity, source, extractor_version, lane, disposition_reason, metadata
				FROM nodix_memories ORDER BY id`,
			)
			.all() as StoredRow[];
		expect(rows).toHaveLength(5);
		expect(() => assertProjectWall(rows, PROJECT_ID)).not.toThrow();
		const first = rows[0];
		if (!first) throw new Error("expected an atomic row for the wall oracle");
		expect(() => assertProjectWall([{ ...first, project_id: "other-project" }], PROJECT_ID)).toThrow(
			"project wall failed",
		);
		expect(() => assertProjectWall([{ ...first, project_id: undefined }], PROJECT_ID)).toThrow(
			"project wall failed",
		);
		expect(
			rows.every(
				(row) =>
					row.maturity === "extracted" &&
					row.source === "edge" &&
					row.extractor_version === EXTRACTOR_VERSION,
			),
		).toBe(true);

		expect(target.store.getAtomicBySubjectAttribute(PROJECT_ID, "user", "preference.food"))
			.toMatchObject({ text: "The user prefers tea.", lane: "active" });
		const events = rows.filter((row) => row.category === "episodic" && row.text.includes("Kyoto"));
		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event).toMatchObject({
			valid_from: EVENT_FROM_MS,
			valid_until: EVENT_FROM_MS + 60_000,
			lane: "active",
		});
		expect(target.store.listAtomicValidAt(PROJECT_ID, EVENT_FROM_MS).map(({ id }) => id)).toContain(
			event?.id,
		);
		expect(
			target.store.listAtomicValidAt(PROJECT_ID, EVENT_FROM_MS + 60_000).map(({ id }) => id),
		).not.toContain(event?.id);

		const entityRecord = result.records.find((record) =>
			record.claimText.includes("Ada Lovelace"),
		);
		expect(entityRecord?.subject).toMatch(/^entity:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
		const entity = target.database
			.prepare(
				"SELECT entity_id, display_name, normalized_name, project_id FROM nodix_memory_entities",
			)
			.get() as
			| {
					entity_id: string;
					display_name: string;
					normalized_name: string;
					project_id: string;
			  }
			| undefined;
		expect(entity).toEqual({
			entity_id: entityRecord?.subject,
			display_name: "Ada Lovelace",
			normalized_name: "ada lovelace",
			project_id: PROJECT_ID,
		});
		const unresolved = rows.find((row) => row.text === "They prefer notebooks.");
		expect(unresolved?.subject).toBeNull();
		expect(
			target.database.prepare("SELECT COUNT(*) AS count FROM nodix_memory_entities").get(),
		).toEqual({ count: 1 });

		const compound = rows.find((row) => row.disposition_reason === "compound");
		expect(compound).toMatchObject({ lane: "parked", subject: null, attribute: null });
		expect(compound ? target.store.isMemoryOnFactSurface(compound.id) : true).toBe(false);
		expect(rows.some((row) => row.text.includes("halfway through"))).toBe(false);

		const liveSchema = target.database
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memories'")
			.get() as { sql: string };
		expect(liveSchema.sql).not.toContain(ATOMIC_MEMORY_VALID_INTERVAL_CHECK_SQL);
		target.database.exec(
			`CREATE TABLE atomic_interval_check_copy (
				valid_from INTEGER,
				valid_until INTEGER,
				CHECK (${ATOMIC_MEMORY_VALID_INTERVAL_CHECK_SQL})
			)`,
		);
		expect(() =>
			target.database
				.prepare(
					"INSERT INTO atomic_interval_check_copy(valid_from, valid_until) VALUES (?, ?)",
				)
				.run(EVENT_FROM_MS, EVENT_FROM_MS),
		).toThrow();
	});

	it("drops an emitted progress record before SQLite after capturing and enriching it", async () => {
		const target = setup();
		const turn: AtomicExtractionTurn = {
			role: "user",
			content: "I am halfway through writing the release notes.",
		};
		const scripted = transports([wireRecord({
			claim_text: "The user is working on the release notes.",
			subject_kind: "unresolved", subject: "release notes", attribute: null,
			value: "writing release notes", todo: "open",
			source_span: { turn_index: 0, quote: turn.content },
		})], [0]);
		let nowMs = SESSION_TIMESTAMP_MS;

		const result = await runAtomicMemoryExtraction({
			store: target.store,
			projectId: PROJECT_ID,
			ledgerKey: ledgerKey("empty"),
			turns: [turn],
			rawChunk: `user: ${turn.content}`,
			routingSnapshotId: "atomic-entrypoint-empty-routing",
			runParameters: RUN_PARAMETERS,
			estimatedInputTokens: 15,
			extractorVersion: EXTRACTOR_VERSION,
			sessionDateTime: "2026-09-03T20:15:00Z",
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			sessionTimezone: "UTC",
			transports: scripted.value,
			nowMs: () => nowMs++,
		});
		if (result.status !== "complete") throw new Error(`unexpected result ${result.status}`);

		expect(result.records).toEqual([]);
		expect(result.write).toMatchObject({ createdCount: 0, ledger: { state: "complete" } });
		// The two lanes make a window two generic calls: the progress-only fact is captured (lane 1)
		// and enriched (lane 2), then excludeProgressRecords drops it before any store write. The
		// drop guarantee — no record, no row, and no gauntlet stages — is what this proves.
		expect(scripted.generic.requests).toHaveLength(2);
		expect(scripted.profileKeying.calls).toHaveLength(0);
		expect(scripted.resplit.calls).toHaveLength(0);
		expect(scripted.subjectGuard.guardCalls).toHaveLength(0);
		expect(target.database.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get()).toEqual({
			count: 0,
		});
	});

	it("keys a record by its chunk, so two windows of one conversation never collide", async () => {
		// Two days of one conversation, each stating a figure at the same turn, in a quote of the
		// same length at the same offsets. Under the old turn-and-offset key the second record was
		// silently mapped onto the first and never stored.
		const target = setup();
		const windows = [
			{ suffix: "day-one", content: "I spent $37.36 on groceries just yesterday", value: "$37.36" },
			{ suffix: "day-two", content: "I just spent $9.02 on coffee this morning.", value: "$9.02" },
		];
		for (const window of windows) {
			const turn: AtomicExtractionTurn = { role: "user", content: window.content };
			const scripted = transports([
				wireRecord({
					kind: "occurrence",
					claim_text: `The user spent ${window.value}.`,
					attribute: "expense.amount",
					value: window.value,
					source_span: { turn_index: 0, quote: window.content },
				}),
			]);
			let nowMs = SESSION_TIMESTAMP_MS;
			const result = await runAtomicMemoryExtraction({
				store: target.store,
				projectId: PROJECT_ID,
				ledgerKey: {
					conversationId: "atomic-entrypoint-one-conversation",
					chunkHash: `atomic-entrypoint-chunk-${window.suffix}`,
					pipelineVersion: EXTRACTOR_VERSION,
				},
				turns: [turn],
				rawChunk: `user: ${turn.content}`,
				routingSnapshotId: "atomic-entrypoint-routing",
				runParameters: RUN_PARAMETERS,
				estimatedInputTokens: 15,
				extractorVersion: EXTRACTOR_VERSION,
				sessionDateTime: "2026-09-03T20:15:00Z",
				sessionTimestampMs: SESSION_TIMESTAMP_MS,
				sessionTimezone: "UTC",
				transports: scripted.value,
				nowMs: () => nowMs++,
			});
			if (result.status !== "complete") throw new Error(`unexpected result ${result.status}`);
			expect(result.write).toMatchObject({ createdCount: 1, ledger: { state: "complete" } });
		}

		const rows = target.database
			.prepare("SELECT text, metadata FROM nodix_memories ORDER BY rowid")
			.all() as Array<{ text: string; metadata: string }>;
		expect(rows.map((row) => row.text)).toEqual([
			"The user spent $37.36.",
			"The user spent $9.02.",
		]);
		const keys = rows.map((row) => JSON.parse(row.metadata).idempotency_key as string);
		expect(new Set(keys).size).toBe(2);
	});

	it("commits one to-do and its durable fact in the atomic write transaction", async () => {
		const target = setup();
		const turn: AtomicExtractionTurn = {
			role: "user",
			content: "I need to submit the report tomorrow.",
		};
		const scripted = transports([
			wireRecord({
				claim_text: "The user needs to submit the report tomorrow.",
				attribute: "goal.project",
				value: "Submit the report",
				todo: "open",
				source_span: { turn_index: 0, quote: turn.content },
			}),
		]);
		let nowMs = SESSION_TIMESTAMP_MS;

		const result = await runAtomicMemoryExtraction({
			store: target.store,
			projectId: PROJECT_ID,
			ledgerKey: ledgerKey("todo-open"),
			turns: [turn],
			rawChunk: `user: ${turn.content}`,
			routingSnapshotId: "atomic-entrypoint-todo-routing",
			runParameters: RUN_PARAMETERS,
			estimatedInputTokens: 15,
			extractorVersion: EXTRACTOR_VERSION,
			sessionDateTime: "2026-09-03T20:15:00Z",
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			sessionTimezone: "UTC",
			transports: scripted.value,
			nowMs: () => nowMs++,
		});
		if (result.status !== "complete") throw new Error(`unexpected result ${result.status}`);

		expect(result.write).toMatchObject({ createdCount: 1, ledger: { state: "complete" } });
		expect(
			target.database
				.prepare(
					`SELECT description, status, source_session AS sourceSession,
						extraction_path AS extractionPath
					FROM nodix_todos WHERE project_id = ?`,
				)
				.get(PROJECT_ID),
		).toEqual({
			description: "Submit the report",
			status: "open",
			sourceSession: "atomic-entrypoint-todo-open",
			extractionPath: "agent_end_atomic",
		});
		expect(
			target.database
				.prepare(
					`SELECT COUNT(*) AS count FROM nodix_memories
					WHERE json_valid(metadata)
						AND json_extract(metadata, '$.active_task_kind') IS NOT NULL`,
				)
				.get(),
		).toEqual({ count: 0 });
	});

	it("applies same-batch to-do events in source order", async () => {
		const target = setup();
		const turns: AtomicExtractionTurn[] = [
			{ role: "user", content: "I plan to submit the report." },
			{ role: "user", content: "The to-do submit the report is done." },
		];
		const scripted = transports([
			wireRecord({
				claim_text: "The user plans to submit the report.",
				value: "submit the report",
				todo: "open",
				source_span: { turn_index: 0, quote: turns[0]?.content },
			}),
			wireRecord({
				kind: "occurrence",
				claim_text: "The user completed submitting the report.",
				value: "submit the report",
				todo: "done",
				close_reason: "done",
				source_span: { turn_index: 1, quote: turns[1]?.content },
			}),
		]);
		let nowMs = SESSION_TIMESTAMP_MS;

		const measured = await runAtomicMemoryExtraction({
			store: target.store,
			projectId: PROJECT_ID,
			ledgerKey: ledgerKey("todo-same-batch"),
			turns,
			rawChunk: turns.map(({ role, content }) => `${role}: ${content}`).join("\n"),
			routingSnapshotId: "atomic-entrypoint-todo-same-batch-routing",
			runParameters: RUN_PARAMETERS,
			estimatedInputTokens: 24,
			extractorVersion: EXTRACTOR_VERSION,
			sessionDateTime: "2026-09-03T20:15:00Z",
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			sessionTimezone: "UTC",
			transports: scripted.value,
			nowMs: () => nowMs++,
		});

		expect(measured.status).toBe("complete");
		expect(
			target.database
				.prepare(
					`SELECT description, status, closed_at AS closedAt, close_reason AS closeReason
					FROM nodix_todos WHERE project_id = ?`,
				)
				.get(PROJECT_ID),
		).toEqual({
			description: "submit the report",
			status: "done",
			closedAt: SESSION_TIMESTAMP_MS,
			closeReason: "done",
		});
	});

	it("writes no to-do for an unowned or subject-rejected record", async () => {
		const target = setup();
		const turns: AtomicExtractionTurn[] = [
			{ role: "user", content: "I plan to file the archive." },
			{ role: "user", content: "I plan to publish the minutes." },
		];
		const scripted = transports([
			wireRecord({
				claim_text: "The user plans to file the archive.",
				value: "file the archive",
				todo: "open",
				source_span: { turn_index: 0, quote: turns[0]?.content },
			}),
			wireRecord({
				claim_text: "The user plans to publish the minutes.",
				value: "publish the minutes",
				todo: "open",
				source_span: { turn_index: 1, quote: turns[1]?.content },
			}),
		]);
		scripted.value.subjectGuard = {
			repairMissingHalf: async () => [],
			guardUserSubjects: async ({ records }) => records.map((_record, index) => index === 0),
		};
		let nowMs = SESSION_TIMESTAMP_MS;

		await runAtomicMemoryExtraction({
			store: target.store,
			projectId: PROJECT_ID,
			ledgerKey: ledgerKey("todo-admission"),
			turns,
			rawChunk: turns.map(({ role, content }) => `${role}: ${content}`).join("\n"),
			routingSnapshotId: "atomic-entrypoint-todo-admission-routing",
			runParameters: RUN_PARAMETERS,
			estimatedInputTokens: 24,
			extractorVersion: EXTRACTOR_VERSION,
			sessionDateTime: "2026-09-03T20:15:00Z",
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			sessionTimezone: "UTC",
			sourceTurnOffset: 0,
			admittedSourceTurnIndexes: [1],
			transports: scripted.value,
			nowMs: () => nowMs++,
		});

		expect(
			target.database.prepare("SELECT COUNT(*) AS count FROM nodix_todos").get(),
		).toEqual({ count: 0 });
	});
	it("withdraws the claim of a record dropped for being over the token ceiling", async () => {
		const target = setup();
		const turns: AtomicExtractionTurn[] = [{ role: "user", content: "I prefer tea." }];
		// Well past DEFAULT_MAX_CONTEXT_TOKENS, so the store would refuse it and the filter drops
		// the card before the write.
		const tooLong = Array.from({ length: 700 }, (_, index) => `detail${index}`).join(" ");
		const longRun = transports([
			wireRecord({ claim_text: `The user prefers tea because ${tooLong}` }),
		]);
		let nowMs = SESSION_TIMESTAMP_MS;
		// One session's windows share this table: it is what stops the next overlapping window
		// re-writing a fact an earlier one already stored.
		const claimedSourceSpans = new Map<number, ClaimedFact[]>();
		const common = {
			store: target.store,
			projectId: PROJECT_ID,
			claimedSourceSpans,
			// The window owns this turn, which is what turns the claim table on.
			admittedSourceTurnIndexes: [0],
			turns,
			rawChunk: "user: I prefer tea.",
			routingSnapshotId: "atomic-entrypoint-routing",
			runParameters: RUN_PARAMETERS,
			estimatedInputTokens: 120,
			extractorVersion: EXTRACTOR_VERSION,
			sessionDateTime: "2026-09-03T20:15:00Z",
			sessionTimestampMs: SESSION_TIMESTAMP_MS,
			sessionTimezone: "UTC",
		};

		const dropped = await runAtomicMemoryExtraction({
			...common,
			ledgerKey: { ...ledgerKey("ceiling-first"), conversationId: "atomic-entrypoint-ceiling" },
			transports: longRun.value,
			nowMs: () => nowMs++,
		});
		if (dropped.status !== "complete") throw new Error(`unexpected result ${dropped.status}`);
		expect(dropped.write?.createdCount).toBe(0);

		// The next overlapping window states the same turn's claim short enough to fit. Nothing
		// was stored for that turn, so this copy must be written rather than read as a repeat.
		const shortRun = transports([wireRecord({})]);
		const written = await runAtomicMemoryExtraction({
			...common,
			ledgerKey: { ...ledgerKey("ceiling-second"), conversationId: "atomic-entrypoint-ceiling" },
			transports: shortRun.value,
			nowMs: () => nowMs++,
		});
		if (written.status !== "complete") throw new Error(`unexpected result ${written.status}`);
		expect(written.write?.createdCount).toBe(1);

		const rows = target.database
			.prepare("SELECT text FROM nodix_memories")
			.all() as { text: string }[];
		expect(rows.map((row) => row.text)).toEqual(["The user prefers tea."]);
	});
});
