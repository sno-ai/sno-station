/** @file atomic-two-lane-extraction.test.ts
 * @purpose Proves the two-lane extractor's completion guarantee and frozen output shape end to end.
 * @boundary runAtomicGenericExtractionPass over a real store, driven by a lane-aware stub transport.
 *
 * These cover the PRD 200 acceptance rows QCG-5a (bisection loses no fact) and QCG-6 (the produced
 * AtomicExtractionRecord shape is unchanged, DEC-6). QCG-5b (single-fact fallback read-back through
 * the store) lives below in its own describe.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	ATOMIC_ENRICHMENT_RESPONSE_JSON_SCHEMA,
	type AtomicExtractionTurn,
} from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import type { AtomicResplitTransport } from "../../../../packages/memory/src/engine/extraction/atomic-extraction-gauntlet";
import {
	type AtomicMemoryExtractionTransports,
	runAtomicMemoryExtraction,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import {
	type AtomicGenericExtractionCompletion,
	type AtomicGenericExtractionInput,
	type AtomicGenericExtractionRequest,
	type AtomicGenericExtractionTransport,
	runAtomicGenericExtractionPass,
} from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor";
import type { AtomicProfileKeyingTransport } from "../../../../packages/memory/src/engine/extraction/atomic-profile-keying";
import type { AtomicSubjectGuardTransport } from "../../../../packages/memory/src/engine/extraction/atomic-subject-guard";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

// One user turn (index 1); every captured fact cites it. Kept plain — no email/URL/key-shaped
// text — so the prompt sanitizer rewrites nothing we later match on.
const TURNS: AtomicExtractionTurn[] = [
	{ role: "system", content: "System line." },
	{ role: "user", content: "I like my weekends." },
	{ role: "assistant", content: "Noted." },
];

function completion(text: string, truncated = false): AtomicGenericExtractionCompletion {
	return { text, truncated };
}

/** One captured fact as it appears on the lane-1 (capture) wire. */
function captureFactWire(id: number, fact: string): Record<string, unknown> {
	return {
		id,
		fact,
		subject: "the user",
		subject_kind: "user",
		temporal_phrase: null,
		ended_at_phrase: null,
		source_span: { turn_index: 1, quote: fact },
	};
}

/** A valid lane-1 capture reply: claims_found length equals facts length, ids are 0..n-1. */
function captureReplyJson(facts: readonly { id: number; fact: string }[]): string {
	return JSON.stringify({
		claims_found: facts.map((f) => f.fact),
		decisions: [{ turn_index: 1, progress_only: false }],
		facts: facts.map((f) => captureFactWire(f.id, f.fact)),
	});
}

/** One enrichment as it appears on the lane-2 wire, keyed by id. */
function enrichmentWire(
	id: number,
	value: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		kind: "standing",
		attribute: null,
		value,
		ends_current: false,
		importance: "medium",
		changes_current_state: false,
		todo: "none",
		close_reason: null,
		single_claim: true,
		relations: [],
		time: { kind: "none" },
		ended_time: { kind: "none" },
		...overrides,
	};
}

/**
 * A transport that answers the two lanes the engine builds internally. The engine calls
 * `transport.complete` once for the capture prompt and once per enrichment batch; the enrichment
 * prompt is the only one that embeds the enrichment response schema, so that exact string is the
 * lane marker (immune to skill-text drift). The batch's fact ids are read out of the last `<take>`
 * block of the enrichment prompt (capture has one such block, enrichment has two).
 */
class TwoLaneTransport implements AtomicGenericExtractionTransport {
	readonly requests: AtomicGenericExtractionRequest[] = [];

	constructor(
		private readonly captureReply: string,
		private readonly enrich: (factIds: number[]) => AtomicGenericExtractionCompletion,
	) {}

	private isEnrichment(prompt: string): boolean {
		return prompt.includes(`response_schema: ${JSON.stringify(ATOMIC_ENRICHMENT_RESPONSE_JSON_SCHEMA)}`);
	}

	private factIds(prompt: string): number[] {
		const block = prompt.split("<take>\n").at(-1)?.split("\n</take>")[0] ?? "[]";
		return (JSON.parse(block) as Array<{ id: number }>).map((fact) => fact.id);
	}

	async complete(request: AtomicGenericExtractionRequest): Promise<AtomicGenericExtractionCompletion> {
		this.requests.push(request);
		if (!this.isEnrichment(request.prompt)) return completion(this.captureReply);
		return this.enrich(this.factIds(request.prompt));
	}
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("two-lane atomic extraction — bisection and frozen record shape", () => {
	let fixture: TestDb;
	let store: MemoryStore;
	let now: number;

	beforeEach(() => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		now = 0;
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	function ledgerKey(suffix: string): AtomicExtractionLedgerKey {
		return { conversationId: `conversation-${suffix}`, chunkHash: `chunk-${suffix}`, pipelineVersion: "atomic-v1" };
	}

	function input(
		key: AtomicExtractionLedgerKey,
		transport: AtomicGenericExtractionTransport,
	): AtomicGenericExtractionInput {
		return {
			store,
			ledgerKey: key,
			turns: TURNS,
			rawChunk: JSON.stringify(TURNS),
			routingSnapshotId: "routing-snapshot-v1",
			runParameters: RUN_PARAMETERS,
			sessionDateTime: "2026-09-02T12:00:00-07:00",
			estimatedInputTokens: 100,
			nowMs: () => {
				now += 1;
				return now;
			},
			transport,
		};
	}

	// QCG-5a — the bisection causal test. Lane 1 captures 40 facts. Lane 2 returns UNPARSEABLE for
	// any batch of MORE than 8 facts and a valid id-keyed reply for any batch of 8 or fewer. The
	// 1400-token enrichment budget chunks 40 short facts into batches of ~17/17/6, so the first two
	// batches (17) exceed 8 and MUST bisect (17 -> 9+8, 9 -> 5+4) until every leaf is 8 or fewer.
	// CAUSAL DISCRIMINATOR: bisection lets each fact reach a small-enough SUCCEEDING enrichment
	// batch, so every record carries its lane-2 value ("value <id>"). Were bisection absent (an
	// oversized batch dropped, or fallen whole to the single-fact fallback), the value would be the
	// lane-1 fact text instead of "value <id>", or facts would be missing — so the per-record value
	// assertion below goes RED without bisection. The value check also fails if bisection mis-binds
	// a fact to a neighbour's enrichment by position rather than by id.
	it("QCG-5a bisects a failing oversized batch to size and loses no fact (coverage 100%)", async () => {
		const failAbove = 8;
		const facts = Array.from({ length: 40 }, (_, index) => ({
			id: index,
			fact: `The user enjoys weekend activity number ${index}`,
		}));
		const transport = new TwoLaneTransport(captureReplyJson(facts), (factIds) =>
			factIds.length > failAbove
				? completion("deliberate unparseable garbage - not json")
				: completion(
						JSON.stringify({
							enrichments: factIds.map((id) => enrichmentWire(id, `value ${id}`)),
						}),
					),
		);

		const result = await runAtomicGenericExtractionPass(input(ledgerKey("bisect"), transport));

		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		// Every input fact appears exactly once: no drop (coverage 100%), no duplicate.
		expect(result.records).toHaveLength(40);
		expect(result.records.map((record) => record.claimText).sort()).toEqual(
			facts.map((fact) => fact.fact).sort(),
		);
		// And each record carries ITS OWN id's enrichment value — proving the id-keyed merge held
		// through bisection rather than binding a fact to a neighbour by position.
		for (const record of result.records) {
			const id = /activity number (\d+)$/u.exec(record.claimText)?.[1];
			expect(id, record.claimText).toBeDefined();
			expect(record.value).toBe(`value ${id}`);
		}
		// The oversized batches actually failed and forced extra enrichment calls (capture + the
		// bisected enrichment tree), so the coverage above was earned by bisection, not by one clean
		// batch: 40 facts over an 8-fact ceiling cannot resolve in a single enrichment call.
		const enrichmentCalls = transport.requests.filter((request) =>
			request.prompt.includes(`response_schema: ${JSON.stringify(ATOMIC_ENRICHMENT_RESPONSE_JSON_SCHEMA)}`),
		).length;
		expect(enrichmentCalls).toBeGreaterThan(3);
	});

	// QCG-6 — the produced AtomicExtractionRecord shape is unchanged (DEC-6). Downstream lanes read
	// a fixed field set; a new/removed/renamed field is a contract regression. We drive an ordinary
	// two-lane run and assert the exact key set and field semantics of the projected records.
	it("QCG-6 produces the frozen AtomicExtractionRecord field set and semantics", async () => {
		const facts = [
			{ id: 0, fact: "The user prefers oat milk in coffee" },
			{ id: 1, fact: "The user visited the harbor market" },
		];
		const transport = new TwoLaneTransport(captureReplyJson(facts), (factIds) =>
			completion(
				JSON.stringify({
					enrichments: factIds.map((id) =>
						id === 0
							? enrichmentWire(0, "oat milk", {
									kind: "standing",
									attribute: "preference.food",
									importance: "high",
								})
							: enrichmentWire(1, "the harbor market", { kind: "occurrence" }),
					),
				}),
			),
		);

		const result = await runAtomicGenericExtractionPass(input(ledgerKey("shape"), transport));

		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		expect(result.records).toHaveLength(2);

		// The exact projected field set. Optional keys (refusedAttribute, atomicSanitizerMatches) are
		// absent for a clean, in-dictionary record with no sanitizer rewrites, so the shape is these
		// 20 fields exactly.
		const EXPECTED_KEYS = [
			"kind", "claimText", "subject", "subjectKind", "attribute", "value", "temporalPhrase",
			"time", "endedTime", "resolvedTime", "endsCurrent", "endedAtPhrase", "endedAt",
			"importance", "changesCurrentState", "todo", "closeReason", "sourceSpan", "relations",
			"singleClaim",
		].sort();
		for (const record of result.records) {
			expect(Object.keys(record).sort()).toEqual(EXPECTED_KEYS);
		}

		const standing = result.records[0];
		const occurrence = result.records[1];
		// Standing record: lane-1 fields carried by code, lane-2 fields merged by id.
		expect(standing).toMatchObject({
			kind: "standing",
			claimText: "The user prefers oat milk in coffee",
			subject: "the user",
			subjectKind: "user",
			attribute: "preference.food",
			value: "oat milk",
			temporalPhrase: null,
			endsCurrent: false,
			endedAtPhrase: null,
			endedAt: null,
			resolvedTime: null,
			importance: "high",
			changesCurrentState: false,
			todo: "none",
			closeReason: null,
			relations: [],
			singleClaim: true,
		});
		expect(standing?.time).toEqual({ kind: "none" });
		expect(standing?.endedTime).toEqual({ kind: "none" });
		expect(standing?.sourceSpan).toEqual({ turnIndex: 1, quote: "The user prefers oat milk in coffee" });
		// Occurrence record with no keyable attribute stays null (not a refused key, since the model
		// offered null): the field is present and typed, shape unchanged.
		expect(occurrence).toMatchObject({
			kind: "occurrence",
			claimText: "The user visited the harbor market",
			attribute: null,
			value: "the harbor market",
			todo: "none",
		});
	});
});

// QCG-5b — a single fact that never enriches still yields ONE complete record, written through the
// real store and read back from the store's normal read path. The whole pipeline runs
// (runAtomicMemoryExtraction: capture -> enrichment -> gauntlet -> keying -> guard -> resolve ->
// store write), driven by stub transports and a REAL encrypted SQLite store. Lane 2 returns
// unparseable on every attempt even for the 1-fact batch, so bisection dead-ends into the defined
// minimal fallback record. Counter-metric (PRD QCG-5b): the fallback fact missing from the store
// read-back, or a record that fails validation, fails this test.
describe("two-lane atomic extraction — single-fact fallback persists and reads back", () => {
	let fixture: TestDb;
	let store: MemoryStore;
	let now: number;

	beforeEach(() => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		now = 0;
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	// A quote that is a real substring of the user turn, so the record keeps subject "user" through
	// the gauntlet rather than being subject-nulled for an unlocatable quote.
	const TURNS_5B: AtomicExtractionTurn[] = [
		{ role: "system", content: "System line." },
		{ role: "user", content: "I adopted a dog named Rex." },
		{ role: "assistant", content: "Congratulations!" },
	];
	const FACT_5B = "The user adopted a dog named Rex";
	const capture5bReply = JSON.stringify({
		claims_found: [FACT_5B],
		decisions: [{ turn_index: 1, progress_only: false }],
		facts: [
			{
				id: 0,
				fact: FACT_5B,
				subject: "the user",
				subject_kind: "user",
				temporal_phrase: null,
				ended_at_phrase: null,
				source_span: { turn_index: 1, quote: "adopted a dog named Rex" },
			},
		],
	});

	// The three non-generic stages never touch this occurrence/user record (verified: resplit only
	// runs on compound suspects, keying only on profile records, the guard only on active profile
	// records), so a null reply is never exercised — but the stubs must still exist and be safe.
	const nullResplit: AtomicResplitTransport = { async resplit() { return null; } };
	const nullProfileKeying: AtomicProfileKeyingTransport = { async keyTurn() { return null; } };
	const nullSubjectGuard: AtomicSubjectGuardTransport = {
		async repairMissingHalf() { return null; },
		async guardUserSubjects() { return null; },
	};

	it("QCG-5b writes the fallback record and reads it back from the store's normal read path", async () => {
		const projectId = `fallback-${Date.now()}`;
		// Capture returns one fact; lane 2 returns unparseable garbage on every attempt, so the
		// 1-fact batch cannot enrich and falls to fallbackAtomicCapturedFact.
		const generic = new TwoLaneTransport(capture5bReply, () => completion("garbage - not json"));
		const transports: AtomicMemoryExtractionTransports = {
			generic,
			resplit: nullResplit,
			profileKeying: nullProfileKeying,
			subjectGuard: nullSubjectGuard,
		};

		const result = await runAtomicMemoryExtraction({
			store,
			projectId,
			ledgerKey: {
				conversationId: `${projectId}-conversation`,
				chunkHash: `${projectId}-chunk`,
				pipelineVersion: "atomic-fallback-test",
			},
			turns: TURNS_5B,
			rawChunk: TURNS_5B.map(({ role, content }) => `${role}: ${content}`).join("\n"),
			routingSnapshotId: `${projectId}-routing`,
			runParameters: RUN_PARAMETERS,
			estimatedInputTokens: 100,
			extractorVersion: "atomic-fallback-test",
			locale: "en",
			sessionDateTime: "2026-09-02T12:00:00-07:00",
			sessionTimestampMs: Date.parse("2026-09-02T12:00:00-07:00"),
			sessionTimezone: "America/Los_Angeles",
			transports,
			nowMs: () => {
				now += 1;
				return now;
			},
		});

		// The returned record is the complete minimal fallback: one record, retrievable defaults.
		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		expect(result.records).toHaveLength(1);
		const [record] = result.records;
		expect(record?.kind).toBe("occurrence");
		expect(record?.value).toBe(FACT_5B);
		expect(record?.claimText).toBe(FACT_5B);
		expect(record?.todo).toBe("none");
		expect(record?.attribute).toBeNull();
		expect(record?.time.kind).toBe("unresolved");
		expect(result.write.createdCount).toBe(1);

		// The load-bearing part: read the row back through the store's normal list() read path — not
		// from the return value — and confirm it is present with non-empty text and valid enums.
		const rows = await store.list({ projectId });
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.text).toBe(FACT_5B); // claimText persisted, non-empty
		expect(row?.lane).toBe("active"); // present — not parked, quarantined, or dropped
		expect((row?.text.length ?? 0)).toBeGreaterThan(0);
		const meta = JSON.parse(row?.metadata ?? "{}") as { value?: string; todo?: string; kind?: string };
		expect(meta.value).toBe(FACT_5B); // non-empty value = the lane-1 fact text
		expect(meta.todo).toBe("none"); // valid enum
		expect(meta.kind).toBe("episodic"); // occurrence projects to the episodic store category
	});
});
