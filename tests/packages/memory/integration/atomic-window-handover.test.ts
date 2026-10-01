/** @file atomic-window-handover.test.ts
 * @purpose Proves a claim its own window returned nothing for is kept when the next window returns one.
 * @boundary The real distiller and its real window split over real encrypted SQLite; the model is the only substitute.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import {
	AtomicInsightDistiller,
	type AtomicMemoryExtractionTransports,
} from "../../../../packages/memory/src/engine/extraction/atomic-memory-extraction";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db";

const PROJECT_ID = "atomic-window-handover";

/**
 * Cut from the dictated email in Memora session 30. `atomicConversationWindows` cuts a
 * conversation into slices and gives each turn to exactly one of them, but a slice always reaches
 * back over the previous slice's turns — so the window AFTER the one that owns a turn reads it too.
 *
 * Measured 2026-09-04 on the real route: the window owning the key-points turn returned nothing,
 * the next window returned TWO records for that same turn, and every one of them was discarded for
 * not belonging to that window. The field was extracted and thrown away, and the question that
 * asked for it lost half its score.
 */
const CONVERSATION = [
	"user: Hey there, can you help me organize an email?",
	"assistant: Of course. What is the purpose of this email?",
	"user: It introduces optimized content workflow strategies to fashion clients.",
	"assistant: What about the recipient list?",
	"user: It goes to our Creative Directors.",
	"assistant: What are the key points to cover?",
	"user: A case study and an invitation to a complimentary strategy session.",
	"assistant: What action do you want them to take?",
	"user: Schedule a personalized consultation within two weeks.",
	"assistant: I have everything I need.",
].join("\n");

/** One model-returned record (the shape lane 1 splits into a capture fact and a lane-2 enrichment). */
function keyPointsRecord(turnIndex: number, quote: string): Record<string, unknown> {
	return {
		kind: "occurrence",
		claim_text: "The email's key points are a case study and a strategy session.",
		subject: "user",
		subject_kind: "user",
		attribute: null,
		value: "a case study and a strategy session",
		temporal_phrase: null,
		resolved_time: null,
		importance: "medium",
		changes_current_state: false,
		ends_current: false,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: turnIndex, quote },
		relations: [],
		single_claim: true,
	};
}

// --- Two-lane reply plumbing shared by both stub transports ---
// A window is now two model calls: a capture reply (claims_found + per-user-turn decisions + facts)
// then one enrichment reply keyed by id. These helpers turn the same model-record templates the
// tests already declare into that two-lane sequence, so the produced records are unchanged.

/** The `<take>` payload of a labelled section (a prompt has several: preceding/following/transcript/facts). */
function sectionTake(prompt: string, label: string): string {
	const after = prompt.split(`${label}:\n`)[1] ?? "";
	return after.split("<take>\n")[1]?.split("\n</take>")[0] ?? "";
}

function captureTurns(prompt: string): Array<{ turn_index: number; role: string; content: string }> {
	const block = sectionTake(prompt, "transcript");
	return block ? (JSON.parse(block) as Array<{ turn_index: number; role: string; content: string }>) : [];
}

function enrichmentFacts(prompt: string): Array<{ id: number; fact: string }> {
	const block = sectionTake(prompt, "facts");
	return block ? (JSON.parse(block) as Array<{ id: number; fact: string }>) : [];
}

/** The lane-2 fields of a model record, defaulting time to the same values the old projection did. */
function enrichmentOf(record: Record<string, unknown>): Record<string, unknown> {
	return {
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
		time: record.time ?? { kind: "unresolved" },
		ended_time: record.ended_time ?? (record.ends_current ? { kind: "unresolved" } : { kind: "none" }),
	};
}

/** Capture reply: decisions cover every user turn of the window; one fact per record. */
function captureReplyFor(
	records: ReadonlyArray<Record<string, unknown>>,
	turns: ReadonlyArray<{ turn_index: number; role: string }>,
): string {
	return JSON.stringify({
		claims_found: records.map((record) => record.claim_text),
		decisions: turns
			.filter((turn) => turn.role === "user")
			.map((turn) => ({ turn_index: turn.turn_index, progress_only: false })),
		facts: records.map((record, id) => ({
			id,
			fact: record.claim_text,
			subject: record.subject,
			subject_kind: record.subject_kind,
			temporal_phrase: record.temporal_phrase ?? null,
			ended_at_phrase: record.ended_at_phrase ?? null,
			source_span: record.source_span,
		})),
	});
}

/** Enrichment reply: one entry per requested fact id, looked up by its claim text. */
function enrichmentReplyFor(
	facts: ReadonlyArray<{ id: number; fact: string }>,
	byClaim: Map<string, Record<string, unknown>>,
): string {
	return JSON.stringify({
		enrichments: facts.map(({ id, fact }) => {
			const enrichment = byClaim.get(fact);
			if (enrichment === undefined) throw new Error(`no enrichment registered for captured fact "${fact}"`);
			return { id, ...enrichment };
		}),
	});
}

const KEY_POINTS_TEXT = "A case study and an invitation to a complimentary strategy session.";
/** First turn of the slice belonging to the window that OWNS the key-points turn. */
const OWNING_WINDOW_FIRST_TURN = "It goes to our Creative Directors.";

/**
 * Stands in for the model only. It answers each window from the transcript that window was really
 * given, and it is silent for the window that OWNS the key-points turn — reproducing the measured
 * skip — while still answering for the next window, which reads that same turn.
 * `neighbourTruncatedCalls`: how many times the window AFTER the owner (the one that starts with
 * the key-points turn) answers with a truncated reply first, which the ledger records as pending.
 */
function transports(
	silentWindow: boolean,
	neighbourTruncatedCalls = 0,
	/** The words the reply quotes for the key-points claim; a paraphrase is not in the turn. */
	quote = KEY_POINTS_TEXT,
): AtomicMemoryExtractionTransports {
	let truncatedLeft = neighbourTruncatedCalls;
	const byClaim = new Map<string, Record<string, unknown>>();
	return {
		generic: {
			async complete({ prompt }) {
				// Lane 2: enrich the requested facts by the claim text captured for them.
				if (prompt.includes("facts:\n")) {
					return { text: enrichmentReplyFor(enrichmentFacts(prompt), byClaim), truncated: false };
				}
				// Lane 1 (capture).
				const turns = captureTurns(prompt);
				const owns = turns[0]?.content === OWNING_WINDOW_FIRST_TURN;
				if (turns[0]?.content === KEY_POINTS_TEXT && truncatedLeft > 0) {
					truncatedLeft -= 1;
					return { text: '{"claims_found": [', truncated: true };
				}
				const keyPoints = turns.find(({ content }) => content === KEY_POINTS_TEXT);
				const records =
					keyPoints === undefined || (silentWindow && owns)
						? []
						: [keyPointsRecord(keyPoints.turn_index, quote)];
				for (const record of records) byClaim.set(record.claim_text as string, enrichmentOf(record));
				return { text: captureReplyFor(records, turns), truncated: false };
			},
		},
		profileKeying: { async keyTurn() { return null; } },
		resplit: { async resplit() { return null; } },
		subjectGuard: {
			async repairMissingHalf() { return null; },
			async guardUserSubjects({ records }) { return records.map(() => true); },
		},
	} as unknown as AtomicMemoryExtractionTransports;
}

/**
 * A turn that carries TWO claims. Measured 2026-09-06 on Memora session 111 of the management
 * consultant: the window owning this turn returned only the second clause, the next window
 * returned both, and the ending was discarded as "already claimed" — the turn was the unit of
 * claim. The quote is the unit now: words nobody quoted yet are a different claim.
 */
const TWO_CLAIM_TURN =
	"Speaking of individual styles, I used to really like Duke Ellington, but lately I'm much more into Yo-Yo Ma's cello works.";
const TWO_CLAIM_CONVERSATION = [
	"user: Do you think a manager's style is mostly innate?",
	"assistant: Partly. Style shows up in small habits.",
	`user: ${TWO_CLAIM_TURN}`,
	"assistant: Cello works are a big change from big band.",
	"user: They are. Anyway, thanks for the chat.",
	"assistant: Any time.",
].join("\n");
const ELLINGTON_QUOTE = "I used to really like Duke Ellington";
const YO_YO_MA_QUOTE = "I'm much more into Yo-Yo Ma's cello works.";
/** Overlaps the owner's Yo-Yo Ma quote: a restatement of the same claim, not a new one. */
const YO_YO_MA_WIDER_QUOTE = "lately I'm much more into Yo-Yo Ma's cello works.";

function musicRecord(claimText: string, value: string, quote: string, turnIndex: number, endsCurrent: boolean) {
	return {
		kind: "standing",
		claim_text: claimText,
		subject: "user",
		subject_kind: "user",
		attribute: "preference.music",
		value,
		temporal_phrase: null,
		resolved_time: null,
		importance: "medium",
		changes_current_state: endsCurrent,
		ends_current: endsCurrent,
		todo: "none",
		close_reason: null,
		source_span: { turn_index: turnIndex, quote },
		relations: [],
		single_claim: true,
	};
}

/**
 * The owner of the two-claim turn (its slice starts at the innate-style question) returns only the
 * Yo-Yo Ma claim; the next window (its slice starts at the two-claim turn) returns both, or the
 * same Yo-Yo Ma claim again under a wider quote when `neighbourRestates` is set.
 */
function twoClaimTransports(neighbourRestates: boolean): AtomicMemoryExtractionTransports {
	const byClaim = new Map<string, Record<string, unknown>>();
	return {
		generic: {
			async complete({ prompt }) {
				if (prompt.includes("facts:\n")) {
					return { text: enrichmentReplyFor(enrichmentFacts(prompt), byClaim), truncated: false };
				}
				const turns = captureTurns(prompt);
				const twoClaim = turns.find(({ content }) => content === TWO_CLAIM_TURN);
				let records: Array<Record<string, unknown>> = [];
				if (twoClaim !== undefined) {
					const owns = turns[0]?.content !== TWO_CLAIM_TURN;
					const yoYoMa = musicRecord(
						"The user is much more into Yo-Yo Ma's cello works.",
						"Yo-Yo Ma's cello works",
						owns || !neighbourRestates ? YO_YO_MA_QUOTE : YO_YO_MA_WIDER_QUOTE,
						twoClaim.turn_index,
						false,
					);
					const ending = musicRecord(
						"The user no longer likes Duke Ellington; used to like him.",
						"Duke Ellington",
						ELLINGTON_QUOTE,
						twoClaim.turn_index,
						true,
					);
					records = owns ? [yoYoMa] : neighbourRestates ? [yoYoMa] : [yoYoMa, ending];
				}
				for (const record of records) byClaim.set(record.claim_text as string, enrichmentOf(record));
				return { text: captureReplyFor(records, turns), truncated: false };
			},
		},
		profileKeying: { async keyTurn() { return null; } },
		resplit: { async resplit() { return null; } },
		subjectGuard: {
			async repairMissingHalf() { return null; },
			async guardUserSubjects({ records }) { return records.map(() => true); },
		},
	} as unknown as AtomicMemoryExtractionTransports;
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic window handover", () => {
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;

	afterEach(async () => {
		await store?.close();
		fixture?.cleanup();
		store = undefined;
		fixture = undefined;
	});

	async function storedTexts(silentWindow: boolean, quote = KEY_POINTS_TEXT): Promise<string[]> {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const distiller = new AtomicInsightDistiller(store, transports(silentWindow, 0, quote), {
			defaultScope: PROJECT_ID,
			locale: "en",
		});
		await distiller.extractAndPersist(CONVERSATION, "handover-session", {
			sessionDateTime: "2026-06-02T12:00:00Z",
			sessionTimezone: "UTC",
		});
		return (
			store.sqlite
				.prepare("SELECT text FROM nodix_memories WHERE project_id = ?")
				.all(PROJECT_ID) as { text: string }[]
		).map(({ text }) => text);
	}

	it("keeps the claim when the owning window returns nothing for its turn", async () => {
		const texts = await storedTexts(true);
		expect(texts.filter((text) => text.includes("key points"))).toHaveLength(1);
	});

	it("keeps a claim whose quote is a paraphrase the turn does not contain", async () => {
		// The gauntlet cannot place a reworded quote, so the record carries no resolved span. It
		// used to be dropped at admission with no row and no reason (19 records of one six-persona
		// run); it is written once now, unkeyed as the gauntlet leaves it, and the neighbour's copy
		// is still merged into that one row.
		await storedTexts(false, "a case study plus an invite to a free strategy session");
		if (store === undefined) throw new Error("store not opened");
		const rows = (
			store.sqlite
				.prepare(
					"SELECT text, lane, subject, attribute FROM nodix_memories WHERE project_id = ? AND text LIKE '%key points%'",
				)
				.all(PROJECT_ID) as { text: string; lane: string; subject: string | null; attribute: string | null }[]
		);
		const evidence = JSON.stringify(rows);
		expect(rows, evidence).toHaveLength(1);
		// Unplaceable words cannot key a fact: no attribute, and no subject to file it under.
		expect(rows[0]?.attribute, evidence).toBeNull();
		expect(rows[0]?.subject, evidence).toBeNull();
	});

	it("stores the claim exactly once when the session is re-sent with more turns", async () => {
		// Every agent end re-sends the whole session. The window that owns the key-points turn is
		// then skipped by the ledger, and the last window, grown by the new turns, reads that turn
		// again and answers for it. The skipped owner must still hold its claim.
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const distiller = new AtomicInsightDistiller(store, transports(false), {
			defaultScope: PROJECT_ID,
			locale: "en",
		});
		const options = { sessionDateTime: "2026-06-02T12:00:00Z", sessionTimezone: "UTC" };
		await distiller.extractAndPersist(CONVERSATION, "resend-session", options);
		const grown = [
			CONVERSATION,
			"assistant: Anything else for the email?",
			"user: No, that is everything, thanks.",
		].join("\n");
		await distiller.extractAndPersist(grown, "resend-session", options);
		const texts = (
			store.sqlite
				.prepare("SELECT text FROM nodix_memories WHERE project_id = ?")
				.all(PROJECT_ID) as { text: string }[]
		).map(({ text }) => text);
		expect(texts.filter((text) => text.includes("key points"))).toHaveLength(1);
	});

	it("keeps the neighbour's claim on a re-run after its first attempt failed", async () => {
		// The owner returns nothing for the key-points turn, and the neighbour's first attempt is
		// truncated twice, so its chunk is left pending. On the re-send the owner is skipped by the
		// ledger and must not claim a turn it never wrote; the neighbour's re-run keeps the record.
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const distiller = new AtomicInsightDistiller(store, transports(true, 2), {
			defaultScope: PROJECT_ID,
			locale: "en",
		});
		const options = { sessionDateTime: "2026-06-02T12:00:00Z", sessionTimezone: "UTC" };
		const first = await distiller.extractAndPersist(CONVERSATION, "retry-session", options);
		expect(first.llmFailures).toBe(1);
		await distiller.extractAndPersist(CONVERSATION, "retry-session", options);
		const texts = (
			store.sqlite
				.prepare("SELECT text FROM nodix_memories WHERE project_id = ?")
				.all(PROJECT_ID) as { text: string }[]
		).map(({ text }) => text);
		expect(texts.filter((text) => text.includes("key points"))).toHaveLength(1);
	});

	async function twoClaimTexts(neighbourRestates: boolean): Promise<string[]> {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const distiller = new AtomicInsightDistiller(store, twoClaimTransports(neighbourRestates), {
			defaultScope: PROJECT_ID,
			locale: "en",
		});
		await distiller.extractAndPersist(TWO_CLAIM_CONVERSATION, "two-claim-session", {
			sessionDateTime: "2026-06-05T12:00:00Z",
			sessionTimezone: "UTC",
		});
		return (
			store.sqlite
				.prepare("SELECT text FROM nodix_memories WHERE project_id = ?")
				.all(PROJECT_ID) as { text: string }[]
		).map(({ text }) => text);
	}

	it("keeps the neighbour's other claim on a turn the owner only half wrote", async () => {
		const texts = await twoClaimTexts(false);
		expect(texts.filter((text) => text.includes("Yo-Yo Ma"))).toHaveLength(1);
		expect(texts.filter((text) => text.includes("Duke Ellington"))).toHaveLength(1);
	});

	it("drops the neighbour's restatement whose quote overlaps the owner's", async () => {
		const texts = await twoClaimTexts(true);
		expect(texts.filter((text) => text.includes("Yo-Yo Ma"))).toHaveLength(1);
		expect(texts).toHaveLength(1);
	});

	it("stores the claim exactly once when both windows return it", async () => {
		// Nothing is silenced, so the owning window and the next one both answer about the turn.
		// The owning window claims it first, so the neighbour's copy is discarded as before.
		const texts = await storedTexts(false);
		expect(texts.filter((text) => text.includes("key points"))).toHaveLength(1);
	});
});
