/** @file atomic-insight-distiller-retirement.test.ts
 * @purpose Proves the ordinary ambient distiller uses the atomic window and conditional-call formula.
 * @boundary Real encrypted MemoryStore with deterministic substitutes only at model transports.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AtomicProfileKeyingTransport } from "@/extraction/atomic-profile-keying";
import type { AtomicResplitTransport } from "@/extraction/atomic-extraction-gauntlet";
import type { AtomicExtractionRecord } from "@/extraction/atomic-extraction-reply";
import type {
	AtomicGenericExtractionRequest,
	AtomicGenericExtractionTransport,
} from "@/extraction/atomic-generic-extractor";
import {
	AtomicInsightDistiller,
	type AtomicMemoryExtractionTransports,
} from "@/extraction/atomic-memory-extraction";
import type { AtomicSubjectGuardTransport } from "@/extraction/atomic-subject-guard";
import type { Embedder } from "@/extraction/embedding-provider-client";
import { MemoryStore } from "@/storage/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const PROJECT_ID = "atomic-retirement-project";
const SESSION_DATE_TIME = "2026-09-03T20:15:00.000Z";

function wireRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
		ends_current: false,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: 0, quote: "I prefer tea." },
		relations: [],
		single_claim: true,
		...overrides,
	};
}

function atomicRecord(overrides: Partial<AtomicExtractionRecord> = {}): AtomicExtractionRecord {
	return {
		kind: "standing",
		category: "profile",
		claimText: "The user prefers tea.",
		subject: "user",
		subjectKind: "user",
		attribute: "preference.food",
		value: "tea",
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex: 0, quote: "I prefer tea." },
		relations: [],
		singleClaim: true,
		...overrides,
	};
}

class SequencedGenericTransport implements AtomicGenericExtractionTransport {
	readonly requests: AtomicGenericExtractionRequest[] = [];

	constructor(private readonly replies: readonly (readonly Record<string, unknown>[])[]) {}

	async complete(request: AtomicGenericExtractionRequest) {
		const index = this.requests.length;
		this.requests.push(request);
		const records = this.replies[index];
		if (!records) throw new Error(`unexpected generic window ${index}`);
		return { text: JSON.stringify({ records }), truncated: false };
	}
}

class RecordingKeyingTransport implements AtomicProfileKeyingTransport {
	readonly calls: Array<Parameters<AtomicProfileKeyingTransport["keyTurn"]>[0]> = [];

	async keyTurn(input: Parameters<AtomicProfileKeyingTransport["keyTurn"]>[0]) {
		this.calls.push(input);
		return [];
	}
}

class RecordingResplitTransport implements AtomicResplitTransport {
	readonly calls: Array<Parameters<AtomicResplitTransport["resplit"]>[0]> = [];

	constructor(private readonly reply: readonly AtomicExtractionRecord[] = []) {}

	async resplit(input: Parameters<AtomicResplitTransport["resplit"]>[0]) {
		this.calls.push(input);
		return [...this.reply];
	}
}

class RecordingSubjectGuardTransport implements AtomicSubjectGuardTransport {
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

function transportFixture(
	replies: readonly (readonly Record<string, unknown>[])[],
	resplitReply: readonly AtomicExtractionRecord[] = [],
): {
	transports: AtomicMemoryExtractionTransports;
	generic: SequencedGenericTransport;
	profileKeying: RecordingKeyingTransport;
	resplit: RecordingResplitTransport;
	subjectGuard: RecordingSubjectGuardTransport;
} {
	const generic = new SequencedGenericTransport(replies);
	const profileKeying = new RecordingKeyingTransport();
	const resplit = new RecordingResplitTransport(resplitReply);
	const subjectGuard = new RecordingSubjectGuardTransport();
	return {
		transports: { generic, profileKeying, resplit, subjectGuard },
		generic,
		profileKeying,
		resplit,
		subjectGuard,
	};
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic ambient distiller retirement boundary", () => {
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(() => {
		store?.closeSync();
		fixture?.cleanup();
		store = undefined;
		fixture = undefined;
	});

	function setup(transports: AtomicMemoryExtractionTransports): AtomicInsightDistiller {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		return new AtomicInsightDistiller(store, transports, { defaultScope: PROJECT_ID });
	}

	it("uses N-1 generic windows, no later call for empty windows, k enhancements, and one guard", async () => {
		const userMessages = [
			"I prefer tea.",
			"Acknowledged.",
			"I work at Sno.",
			"Thanks.",
		];
		const scripted = transportFixture([
			[
				wireRecord({ source_span: { turn_index: 0, quote: userMessages[0] } }),
			],
			[
				wireRecord({
					claim_text: "The user works at Sno.",
					attribute: "identity.employer",
					value: "Sno",
					source_span: { turn_index: 1, quote: userMessages[2] },
				}),
			],
			[],
		]);
		const distiller = setup(scripted.transports);

		const result = await distiller.extractAndPersist(
			userMessages.map((message) => `user: ${message}`).join("\n\n"),
			"atomic-retirement-no-repairs",
			{
				scope: PROJECT_ID,
				sessionDateTime: SESSION_DATE_TIME,
				sessionTimezone: "UTC",
			},
		);

		expect(scripted.generic.requests).toHaveLength(userMessages.length - 1);
		expect(scripted.profileKeying.calls.map(({ turn }) => turn.content.trim())).toEqual([
			userMessages[0],
			userMessages[2],
		]);
		expect(scripted.resplit.calls).toHaveLength(0);
		expect(scripted.subjectGuard.repairCalls).toHaveLength(0);
		expect(scripted.subjectGuard.guardCalls).toHaveLength(1);
		expect(result).toMatchObject({
			created: 2,
			merged: 0,
			skipped: 0,
			addressLessRefusedCount: 0,
		});
		expect(
			fixture?.runtime.db.prepare("SELECT COUNT(*) AS count FROM nodix_memories").get(),
		).toEqual({ count: 2 });
	});

	it("adds one resplit and one missing-half call for their two repair trigger points", async () => {
		const messages = ["I prefer tea and jazz.", "I moved to Kyoto."];
		const resplitReply = [
			atomicRecord({
				claimText: "The user prefers tea.",
				sourceSpan: { turnIndex: 0, quote: "I prefer tea and jazz." },
			}),
			atomicRecord({
				claimText: "The user prefers jazz.",
				attribute: "preference.music",
				value: "jazz",
				sourceSpan: { turnIndex: 0, quote: "I prefer tea and jazz." },
			}),
		];
		const scripted = transportFixture(
			[
				[
					wireRecord({
						claim_text: "The user prefers tea and jazz.",
						value: "tea and jazz",
						source_span: { turn_index: 0, quote: messages[0] },
						single_claim: false,
					}),
					wireRecord({
						kind: "occurrence",
						claim_text: "The user moved to Kyoto.",
						attribute: "identity.location",
						value: "Kyoto",
						changes_current_state: true,
						ends_current: false,
						todo: "none",
						close_reason: null,
						source_span: { turn_index: 1, quote: messages[1] },
					}),
				],
			],
			resplitReply,
		);
		const distiller = setup(scripted.transports);

		const result = await distiller.extractAndPersist(
			messages.map((message) => `user: ${message}`).join("\n\n"),
			"atomic-retirement-repairs",
			{
				scope: PROJECT_ID,
				sessionDateTime: SESSION_DATE_TIME,
				sessionTimezone: "UTC",
			},
		);

		expect(scripted.generic.requests).toHaveLength(messages.length - 1);
		expect(scripted.profileKeying.calls).toHaveLength(2);
		expect(scripted.resplit.calls).toHaveLength(1);
		expect(scripted.subjectGuard.repairCalls).toHaveLength(1);
		expect(
			scripted.resplit.calls.length + scripted.subjectGuard.repairCalls.length,
		).toBe(2);
		expect(scripted.subjectGuard.guardCalls).toHaveLength(1);
		// A re-split keeps BOTH halves active AND the original bundle parked, so a re-split that
		// silently dropped content still leaves the original on disk (`preserve incomplete resplit
		// records`). The bundle is parked, so recall never returns it and the halves are the answer.
		expect(result).toMatchObject({ created: 4, merged: 0, addressLessRefusedCount: 0 });
		const stored = fixture?.runtime.db
			.prepare("SELECT text, lane, disposition_reason AS reason FROM nodix_memories ORDER BY rowid")
			.all() as Array<{ text: string; lane: string; reason: string | null }>;
		expect(stored.map(({ text, lane, reason }) => ({ text, lane, reason }))).toEqual([
			{ text: "The user moved to Kyoto.", lane: "active", reason: null },
			{ text: "The user prefers tea.", lane: "active", reason: null },
			{ text: "The user prefers jazz.", lane: "active", reason: null },
			{ text: "The user prefers tea and jazz.", lane: "parked", reason: "compound" },
		]);
	});

	it("lets only the owner window write an overlapping original turn", async () => {
		const messages = ["Opening context.", "I prefer tea.", "Closing context."];
		const scripted = transportFixture([
			[
				wireRecord({
					claim_text: "The user prefers coffee.",
					value: "coffee",
					source_span: { turn_index: 1, quote: messages[1] },
				}),
			],
			[
				wireRecord({
					claim_text: "The user prefers tea.",
					value: "tea",
					source_span: { turn_index: 0, quote: messages[1] },
				}),
			],
		]);
		const distiller = setup(scripted.transports);

		const result = await distiller.extractAndPersist(
			messages.map((message) => `user: ${message}`).join("\n\n"),
			"atomic-retirement-overlap-identity",
			{
				scope: PROJECT_ID,
				sessionDateTime: SESSION_DATE_TIME,
				sessionTimezone: "UTC",
			},
		);

		expect(scripted.generic.requests).toHaveLength(messages.length - 1);
		expect(result.created).toBe(1);
		const rows = fixture?.runtime.db
			.prepare("SELECT text FROM nodix_memories WHERE project_id = ?")
			.all(PROJECT_ID) as Array<{ text: string }>;
		expect(rows).toEqual([{ text: "The user prefers coffee." }]);
	});

	it("keeps stable turn ownership when the same session grows", async () => {
		const firstMessages = ["Opening context.", "I prefer tea."];
		const grownMessages = [...firstMessages, "I moved to Kyoto."];
		const scripted = transportFixture([
			[
				wireRecord({
					claim_text: "The user prefers tea.",
					value: "tea",
					source_span: { turn_index: 1, quote: firstMessages[1] },
				}),
			],
			[
				wireRecord({
					claim_text: "The user drinks tea each morning.",
					value: "tea each morning",
					source_span: { turn_index: 1, quote: firstMessages[1] },
				}),
			],
			[
				wireRecord({
					claim_text: "The user moved to Kyoto.",
					attribute: "identity.location",
					value: "Kyoto",
					source_span: { turn_index: 1, quote: grownMessages[2] },
				}),
			],
		]);
		const distiller = setup(scripted.transports);
		const options = {
			scope: PROJECT_ID,
			sessionDateTime: SESSION_DATE_TIME,
			sessionTimezone: "UTC",
		};

		const firstResult = await distiller.extractAndPersist(
			firstMessages.map((message) => `user: ${message}`).join("\n\n"),
			"atomic-retirement-growing-session",
			options,
		);
		const grownResult = await distiller.extractAndPersist(
			grownMessages.map((message) => `user: ${message}`).join("\n\n"),
			"atomic-retirement-growing-session",
			options,
		);

		expect(scripted.generic.requests).toHaveLength(3);
		expect(firstResult.created).toBe(1);
		expect(grownResult.created).toBe(1);
		const rows = fixture?.runtime.db
			.prepare(
				"SELECT text, attribute FROM nodix_memories WHERE project_id = ? ORDER BY attribute",
			)
			.all(PROJECT_ID) as Array<{ text: string; attribute: string }>;
		expect(rows).toEqual([
			{ text: "The user moved to Kyoto.", attribute: "identity.location" },
			{ text: "The user prefers tea.", attribute: "preference.food" },
		]);
	});

	it("refuses a blank session key before any model call", async () => {
		const scripted = transportFixture([[]]);
		const distiller = setup(scripted.transports);

		await expect(
			distiller.extractAndPersist("user: I prefer tea.", "   ", {
				scope: PROJECT_ID,
				sessionDateTime: SESSION_DATE_TIME,
				sessionTimezone: "UTC",
			}),
		).rejects.toThrow(/sessionKey.*required|requires.*sessionKey/u);
		expect(scripted.generic.requests).toHaveLength(0);
	});
});
