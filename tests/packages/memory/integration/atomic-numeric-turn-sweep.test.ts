/** @file atomic-numeric-turn-sweep.test.ts
 * @purpose Proves the second look at a skipped figure asks about the right turns and only about those.
 * @boundary The real sweep and the real prompt builder; the model is the only substitute.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AtomicExtractionRecord,
	AtomicExtractionTurn,
} from "../../../../packages/memory/src/engine/extraction/atomic-extraction-reply";
import {
	type AtomicGenericExtractionRequest,
	type AtomicGenericExtractionTransport,
	runAtomicNumericTurnSweep,
} from "../../../../packages/memory/src/engine/extraction/atomic-generic-extractor";
import type { AtomicExtractionLedgerKey, MemoryStore } from "../../../../packages/memory/src/store/store";

/**
 * Cut down from Memora session 92, whose extraction returned nothing at all on two replays out of
 * three: a long conversation about something else with ONE stated figure near the end. A turn
 * reaches exactly one extraction window, so a figure the first pass skips is lost for good.
 */
const TURNS: AtomicExtractionTurn[] = [
	{ role: "assistant", content: "Hello there! How can I help you today?" },
	{ role: "user", content: "Hi there! What kind of things can you do?" },
	{ role: "assistant", content: "I can help with a wide range of tasks." },
	{ role: "user", content: "I'm interested in new technologies and scientific discoveries." },
	{ role: "assistant", content: "One fascinating area is quantum computing." },
	{ role: "user", content: "Speaking of powerful, I've walked 4,471 steps today!" },
	{ role: "assistant", content: "That's an impressive number of steps!" },
	{ role: "user", content: "Yes, it was! I should probably call it a day." },
];
const STEPS_TURN = 5;

const LEDGER_KEY: AtomicExtractionLedgerKey = {
	conversationId: "sweep-conversation",
	chunkHash: "sweep-chunk",
	pipelineVersion: "sweep-test",
};

/** The sweep touches the store for one thing only: recording that a model call happened. */
function callCountingStore(): { store: MemoryStore; calls: number[] } {
	const calls: number[] = [];
	const store = {
		recordAtomicExtractionCalls(_key: AtomicExtractionLedgerKey, nowMs: number) {
			calls.push(nowMs);
		},
	} as unknown as MemoryStore;
	return { store, calls };
}

function record(turnIndex: number, quote: string): AtomicExtractionRecord {
	return {
		kind: "occurrence",
		claimText: "A claim the first pass already made.",
		subject: "user",
		subjectKind: "user",
		attribute: null,
		value: "something",
		temporalPhrase: null,
		resolvedTime: null,
		importance: "medium",
		changesCurrentState: false,
		todo: "none",
		closeReason: null,
		sourceSpan: { turnIndex, quote },
		relations: [],
		singleClaim: true,
	} as AtomicExtractionRecord;
}

function reply(records: readonly { turnIndex: number; claimText: string }[]): string {
	return JSON.stringify({
		records: records.map(({ turnIndex, claimText }) => ({
			kind: "occurrence",
			claim_text: claimText,
			subject: "user",
			subject_kind: "user",
			attribute: null,
			value: "4,471 steps",
			temporal_phrase: "today",
			resolved_time: { year: 2026, month: 6, day: 4 },
			importance: "medium",
			changes_current_state: false,
			ends_current: false,
			todo: "none",
			close_reason: null,
			source_span: { turn_index: turnIndex, quote: TURNS[turnIndex]?.content ?? "" },
			relations: [],
			single_claim: true,
		})),
	});
}

function transportReturning(text: string | null): {
	transport: AtomicGenericExtractionTransport;
	prompts: string[];
} {
	const prompts: string[] = [];
	const transport: AtomicGenericExtractionTransport = {
		async complete(request: AtomicGenericExtractionRequest) {
			prompts.push(request.prompt);
			return text === null ? null : { text, truncated: false };
		},
	};
	return { transport, prompts };
}

const BASE = {
	ledgerKey: LEDGER_KEY,
	turns: TURNS,
	sessionDateTime: "2026-06-04T12:00:00Z",
	outputTokenBudget: 2_000,
	locale: "en" as const,
};

describe("atomic numeric turn sweep", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** The repo logger writes every line to stderr; capture that, not the logger internals. */
	function captureStderr(): string[] {
		const lines: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);
		return lines;
	}

	it("logs the sweep outcome, and warns when a returned record cites an unswept turn", async () => {
		// Measured 2026-09-04: a figure the sweep was eligible for vanished with no sweep line in
		// the log at all, so nobody could say whether the model never returned it or the turn
		// filter dropped it. The outcome line is what makes that loss attributable.
		const lines = captureStderr();
		const { store } = callCountingStore();
		const { transport } = transportReturning(
			reply([
				{ turnIndex: STEPS_TURN, claimText: "The user walked 4,471 steps on 2026-06-04." },
				{ turnIndex: 3, claimText: "The user is interested in new technologies." },
			]),
		);
		const swept = await runAtomicNumericTurnSweep({
			...BASE,
			store,
			records: [],
			transport,
			nowMs: () => 1_000,
		});
		expect(swept.map((r) => r.sourceSpan.turnIndex)).toEqual([STEPS_TURN]);
		const outcome = lines.filter((line) => line.includes("atomic numeric turn sweep"));
		expect(outcome).toHaveLength(1);
		expect(outcome[0]).toContain("WARN");
		expect(outcome[0]).toContain("dropped records outside the swept turns");
		expect(outcome[0]).toContain('"returnedRecordCount":2');
		expect(outcome[0]).toContain('"keptRecordCount":1');
		expect(outcome[0]).toContain('"droppedTurnIndexes":[3]');
		expect(outcome[0]).toContain(`"recoveredTurnIndexes":[${STEPS_TURN}]`);
		expect(outcome[0]).toContain('"unrecoveredTurnIndexes":[]');
	});

	it("keeps only what quotes the figure, not the rest of the swept turn", async () => {
		// The sweep is given the whole transcript and asked again about a turn whose figures are
		// uncited, so the model answers with everything that turn states. Only the figure was
		// missing. Measured 2026-09-20 on a 66-session replay where a session is one turn: one
		// uncaptured figure made the turn uncited, the sweep returned the session again, and 310
		// records were added on top of 1,217 captured facts while 2% of stored rows quote a figure.
		const { store } = callCountingStore();
		const turn = TURNS[STEPS_TURN]?.content ?? "";
		const withFigure = turn;
		const withoutFigure = "Speaking of powerful";
		const { transport } = transportReturning(JSON.stringify({
			records: [withFigure, withoutFigure].map((quote, index) => ({
				kind: "occurrence",
				claim_text: index === 0 ? "The user walked 4,471 steps today." : "The user finds something powerful.",
				subject: "user", subject_kind: "user", attribute: null,
				value: index === 0 ? "4,471 steps" : "powerful",
				temporal_phrase: "today", resolved_time: { year: 2026, month: 6, day: 4 },
				importance: "medium", changes_current_state: false, ends_current: false,
				todo: "none", close_reason: null,
				source_span: { turn_index: STEPS_TURN, quote },
				relations: [], single_claim: true,
			})),
		}));
		const swept = await runAtomicNumericTurnSweep({
			...BASE, store, records: [], transport, nowMs: () => 1_000,
		});
		expect(swept.map((r) => r.sourceSpan.quote)).toEqual([withFigure]);
	});

	it("names the swept turns when the model call throws, then rethrows", async () => {
		const lines = captureStderr();
		const { store } = callCountingStore();
		const transport: AtomicGenericExtractionTransport = {
			async complete() {
				throw new Error("endpoint unreachable");
			},
		};
		await expect(
			runAtomicNumericTurnSweep({ ...BASE, store, records: [], transport, nowMs: () => 1_000 }),
		).rejects.toThrow("endpoint unreachable");
		const outcome = lines.filter((line) => line.includes("atomic numeric turn sweep"));
		expect(outcome).toHaveLength(1);
		expect(outcome[0]).toContain("sweep call threw");
		expect(outcome[0]).toContain(`"sweptTurnIndexes":[${STEPS_TURN}]`);
	});

	it("logs a completed sweep at info when nothing was dropped", async () => {
		// An unconfigured logger runs at "info"; the service sets `settings.logging.level`.
		const lines = captureStderr();
		const { store } = callCountingStore();
		const { transport } = transportReturning(
			reply([{ turnIndex: STEPS_TURN, claimText: "The user walked 4,471 steps on 2026-06-04." }]),
		);
		await runAtomicNumericTurnSweep({
			...BASE,
			store,
			records: [],
			transport,
			nowMs: () => 1_000,
		});
		const outcome = lines.filter((line) => line.includes("atomic numeric turn sweep"));
		expect(outcome).toHaveLength(1);
		expect(outcome[0]).toContain("INFO");
		expect(outcome[0]).toContain("sweep completed");
		expect(outcome[0]).toContain(`"sweptTurnIndexes":[${STEPS_TURN}]`);
		expect(outcome[0]).toContain('"keptRecordCount":1');
		expect(outcome[0]).toContain('"droppedTurnIndexes":[]');
		expect(outcome[0]).toContain('"unrecoveredTurnIndexes":[]');
	});

	it("asks again about a stated figure no record cites, and names that turn", async () => {
		const { store, calls } = callCountingStore();
		const { transport, prompts } = transportReturning(
			reply([{ turnIndex: STEPS_TURN, claimText: "The user walked 4,471 steps on 2026-06-04." }]),
		);
		const swept = await runAtomicNumericTurnSweep({
			...BASE,
			store,
			records: [],
			transport,
			nowMs: () => 1_000,
		});

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(`turn_indexes_to_account_for: [${STEPS_TURN}]`);
		expect(swept).toHaveLength(1);
		expect(swept[0]?.claimText).toBe("The user walked 4,471 steps on 2026-06-04.");
		expect(calls, "the extra model call is recorded, not hidden").toEqual([1_000]);
	});

	it("drops both copies of a first-pass fact and keeps only the new backfill fact", async () => {
		const { store } = callCountingStore();
		const { transport } = transportReturning(JSON.stringify({
			records: [
				{ claim: "The user spent $5 on coffee.", value: "$5", quote: "$5 on coffee" },
				{ claim: "The user spent $5 on coffee.", value: "$5", quote: "$5 on coffee" },
				{ claim: "The user spent $8 on parking.", value: "$8", quote: "$8 on parking" },
			].map(({ claim, value, quote }) => ({
				kind: "occurrence", claim_text: claim, subject: "user", subject_kind: "user",
				attribute: null, value, temporal_phrase: null, time: { kind: "none" },
				ended_time: { kind: "none" }, ends_current: false, importance: "medium",
				changes_current_state: false, todo: "none", close_reason: null,
				source_span: { turn_index: 0, quote }, relations: [], single_claim: true,
			})),
		}));
		const swept = await runAtomicNumericTurnSweep({
			...BASE, store, transport, nowMs: () => 1_000,
			turns: [{ role: "user", content: "I spent $5 on coffee and $8 on parking." }],
			records: [{
				...record(0, "$5 on coffee"), claimText: "The user spent $5 on coffee.", value: "$5",
			}],
		});
		expect(swept.map((entry) => ({
			claim: entry.claimText, value: entry.value, source: entry.sourceSpan,
		}))).toEqual([{
			claim: "The user spent $8 on parking.", value: "$8",
			source: { turnIndex: 0, quote: "$8 on parking" },
		}]);
	});

	it("keeps different same-amount spends quoted from the whole sentence", async () => {
		const { store } = callCountingStore();
		const { transport } = transportReturning(JSON.stringify({
			records: ["The user spent $5 on coffee.", "The user spent $5 on parking."].map((claim) => ({
				kind: "occurrence", claim_text: claim, subject: "user", subject_kind: "user",
				attribute: null, value: "5", temporal_phrase: null, time: { kind: "none" },
				ended_time: { kind: "none" }, ends_current: false, importance: "medium",
				changes_current_state: false, todo: "none", close_reason: null,
				source_span: { turn_index: 0, quote: "I spent $5 on coffee and $5 on parking." },
				relations: [], single_claim: true,
			})),
		}));
		const swept = await runAtomicNumericTurnSweep({
			...BASE, store, transport, nowMs: () => 1_000,
			turns: [{ role: "user", content: "I spent $5 on coffee and $5 on parking." }],
			records: [],
		});
		expect(swept.map((entry) => ({
			claim: entry.claimText, value: entry.value, source: entry.sourceSpan,
		}))).toEqual([
			{
				claim: "The user spent $5 on coffee.", value: "5",
				source: { turnIndex: 0, quote: "I spent $5 on coffee and $5 on parking." },
			},
			{
				claim: "The user spent $5 on parking.", value: "5",
				source: { turnIndex: 0, quote: "I spent $5 on coffee and $5 on parking." },
			},
		]);
	});

	it("costs nothing when the first pass already cited the figure", async () => {
		const { store, calls } = callCountingStore();
		const { transport, prompts } = transportReturning(reply([]));
		const swept = await runAtomicNumericTurnSweep({
			...BASE,
			store,
			// A parked record cites its turn too: the claim was rejected, not the turn skipped.
			records: [record(STEPS_TURN, TURNS[STEPS_TURN]?.content ?? "")],
			transport,
			nowMs: () => 1_000,
		});
		expect(prompts).toEqual([]);
		expect(swept).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("asks again when a record cites the turn but not the figure in it", async () => {
		// Measured 2026-09-04 across three persona stores: 4 of 84 stated figures never reached the
		// store, and every one sat in a turn the conversation was not otherwise about. The first
		// pass can take the OTHER half of such a turn — "speaking of powerful", the small talk
		// around the number — and cite it. Citing the turn is not capturing the figure, and today
		// one citation of any kind buys the whole turn an exemption from the sweep, so the number
		// is lost for good. An aggregation question is graded on the exact total, so one lost
		// figure zeroes it outright.
		const { store, calls } = callCountingStore();
		const { transport, prompts } = transportReturning(
			reply([{ turnIndex: STEPS_TURN, claimText: "The user walked 4,471 steps on 2026-06-04." }]),
		);
		const swept = await runAtomicNumericTurnSweep({
			...BASE,
			store,
			// The record cites the turn, and carries none of the turn's digits.
			records: [record(STEPS_TURN, "Speaking of powerful,")],
			transport,
			nowMs: () => 1_000,
		});
		expect(prompts.length, "the figure was never re-asked about").toBe(1);
		expect(
			swept.map((swept) => swept.claimText),
			"the swept figure did not come back",
		).toEqual(["The user walked 4,471 steps on 2026-06-04."]);
		expect(calls).toEqual([1_000]);
	});

	it("leaves alone the turns another window owns", async () => {
		const { store } = callCountingStore();
		const { transport, prompts } = transportReturning(reply([]));
		await runAtomicNumericTurnSweep({
			...BASE,
			store,
			records: [],
			// This window owns turns 0-3, so the figure at turn 5 is not its to re-ask.
			eligibleTurnIndexes: new Set([0, 1, 2, 3]),
			transport,
			nowMs: () => 1_000,
		});
		expect(prompts).toEqual([]);
	});

	it("keeps only records for the turns it swept", async () => {
		const { store } = callCountingStore();
		// The transcript goes in whole so the model can resolve "today", which also lets it answer
		// about turns nobody asked about. A second copy of a claim the first pass already made
		// would be written twice, so anything outside the swept turns is dropped.
		const { transport } = transportReturning(
			reply([
				{ turnIndex: STEPS_TURN, claimText: "The user walked 4,471 steps on 2026-06-04." },
				{ turnIndex: 3, claimText: "The user is interested in new technologies." },
			]),
		);
		const swept = await runAtomicNumericTurnSweep({
			...BASE,
			store,
			records: [],
			transport,
			nowMs: () => 1_000,
		});
		expect(swept.map((r) => r.sourceSpan.turnIndex)).toEqual([STEPS_TURN]);
	});

	it("re-asks about a small number too, not only a three-digit one", async () => {
		// "I bought 12 coffees" is a fact a weekly total depends on exactly as much as a step
		// count is. A three-digit rule reads it as ordinary chat and drops it for good.
		const { store } = callCountingStore();
		const { transport, prompts } = transportReturning(reply([]));
		const turns = [
			{ role: "assistant" as const, content: "How was your week?" },
			{ role: "user" as const, content: "Busy. I bought 12 coffees and ran 5 km." },
		];
		await runAtomicNumericTurnSweep({
			...BASE,
			turns,
			store,
			records: [],
			transport,
			nowMs: () => 1_000,
		});
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("turn_indexes_to_account_for: [1]");
	});

	it("counts a truncated reply as the call it was", async () => {
		// The call happened and cost what it cost. Leaving it out of the ledger understates the
		// run's own call volume, which is the number a cost report reads.
		const { store, calls } = callCountingStore();
		const transport: AtomicGenericExtractionTransport = {
			async complete() {
				return { text: "{\"records\": [", truncated: true };
			},
		};
		const swept = await runAtomicNumericTurnSweep({
			...BASE,
			store,
			records: [],
			transport,
			nowMs: () => 2_000,
		});
		expect(swept).toEqual([]);
		expect(calls).toEqual([2_000]);
	});

	it("invents nothing when the model answers with no record or not at all", async () => {
		const { store } = callCountingStore();
		for (const text of [reply([]), null]) {
			const { transport } = transportReturning(text);
			const swept = await runAtomicNumericTurnSweep({
				...BASE,
				store,
				records: [],
				transport,
				nowMs: () => 1_000,
			});
			expect(swept).toEqual([]);
		}
	});
});
