/**
 * session.activity arithmetic: gaps, continuous runs, team-driven time and human messages are
 * folded from transcript records, and a transcript read in several sends gives the same sums as
 * one read. Real files for the line reader; the records are the shapes both harness readers return.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ActivityRecord,
	EMPTY_ACTIVITY_CURSOR,
	foldActivity,
	isAgentText,
	readNewLines,
	type SessionActivityPayload,
} from "../../../../packages/memory/config/session-activity.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 7, 8, 0, 0);

const rec = (minutes: number, incoming?: "human" | "agent"): ActivityRecord =>
	incoming ? { ts: T0 + minutes * MIN, incoming } : { ts: T0 + minutes * MIN };

describe("foldActivity", () => {
	it("counts a gap of exactly 15 minutes and ends the run on 16", () => {
		const { payload, cursor } = foldActivity(EMPTY_ACTIVITY_CURSOR, [rec(0), rec(5), rec(20), rec(36)], false);
		expect(payload).toEqual({
			window_start_ms: T0, window_end_ms: T0 + 36 * MIN,
			active_ms: 20 * MIN, team_driven_ms: 0, runs_over_12h: 0, longest_run_ms: 20 * MIN, human_messages: 0,
		});
		// The run that began at minute 36 is still open.
		expect(cursor).toMatchObject({ lastTs: T0 + 36 * MIN, runStart: T0 + 36 * MIN });
	});

	it("counts a run that reaches 12 hours once; longest_run_ms is the longest run of any length", () => {
		const run = (hours: number, minutes = 0): ActivityRecord[] => {
			const end = hours * 60 + minutes;
			return Array.from({ length: Math.floor(end / 10) + 1 }, (_, i) => rec(i * 10)).concat(end % 10 ? [rec(end)] : []);
		};
		const thirteen = foldActivity(EMPTY_ACTIVITY_CURSOR, run(13), true).payload;
		expect(thirteen).toMatchObject({ runs_over_12h: 1, longest_run_ms: 13 * HOUR, active_ms: 13 * HOUR });
		expect(foldActivity(EMPTY_ACTIVITY_CURSOR, run(12), true).payload).toMatchObject({ runs_over_12h: 1, longest_run_ms: 12 * HOUR });
		expect(foldActivity(EMPTY_ACTIVITY_CURSOR, run(11, 59), true).payload).toMatchObject({ runs_over_12h: 0, longest_run_ms: 11 * HOUR + 59 * MIN });
		expect(foldActivity(EMPTY_ACTIVITY_CURSOR, run(5), true).payload).toMatchObject({ runs_over_12h: 0, longest_run_ms: 5 * HOUR, active_ms: 5 * HOUR });
	});

	it("keeps an open run in the cursor and counts it once, in the send where it passes 12 hours", () => {
		const records = Array.from({ length: 80 }, (_, i) => rec(i * 10)); // 0 .. 13h10m
		const first = foldActivity(EMPTY_ACTIVITY_CURSOR, records.slice(0, 40), false);
		expect(first.payload).toMatchObject({ runs_over_12h: 0, longest_run_ms: 39 * 10 * MIN });
		const second = foldActivity(first.cursor, records.slice(40), true);
		expect(second.payload).toMatchObject({
			window_start_ms: records[39]?.ts, runs_over_12h: 1, longest_run_ms: 79 * 10 * MIN,
		});
		expect((first.payload?.active_ms ?? 0) + (second.payload?.active_ms ?? 0)).toBe(79 * 10 * MIN);
	});

	it("gives the same runs_over_12h and longest_run_ms whether a transcript is sent once or in 200 pieces", () => {
		// A 14-hour run, a 30-minute pause, then a 5-hour run that never reaches 12 hours.
		const records = [
			...Array.from({ length: 85 }, (_, i) => rec(i * 10)), // 0 .. 14h
			...Array.from({ length: 31 }, (_, i) => rec(14 * 60 + 30 + i * 10)), // 14h30 .. 19h30
		];
		const once = foldActivity(EMPTY_ACTIVITY_CURSOR, records, true).payload;
		expect(once).toMatchObject({ runs_over_12h: 1, longest_run_ms: 14 * HOUR });
		for (const closeLast of [true, false]) {
			let cursor = EMPTY_ACTIVITY_CURSOR;
			let runs = 0, longest = 0;
			const size = Math.ceil(records.length / 200);
			for (let at = 0; at < records.length; at += size) {
				const last = at + size >= records.length;
				const sent = foldActivity(cursor, records.slice(at, at + size), closeLast && last);
				cursor = sent.cursor;
				runs += sent.payload?.runs_over_12h ?? 0;
				longest = Math.max(longest, sent.payload?.longest_run_ms ?? 0);
			}
			expect({ runs, longest }).toEqual({ runs: 1, longest: 14 * HOUR });
		}
		// One record per piece is the worst case: every send leaves the run open.
		let cursor = EMPTY_ACTIVITY_CURSOR;
		let runs = 0, longest = 0;
		for (const record of records) {
			const sent = foldActivity(cursor, [record], false);
			cursor = sent.cursor;
			runs += sent.payload?.runs_over_12h ?? 0;
			longest = Math.max(longest, sent.payload?.longest_run_ms ?? 0);
		}
		expect({ runs, longest }).toEqual({ runs: 1, longest: 14 * HOUR });
	});

	it("attributes time to the agent until the person types, and counts only the person's messages", () => {
		const { payload } = foldActivity(EMPTY_ACTIVITY_CURSOR, [
			rec(0, "human"), rec(2), rec(4, "agent"), rec(10), rec(14, "agent"), rec(20, "human"), rec(23),
		], true);
		// Gaps: 0-2 human 2, 2-4 human 2, 4-10 agent 6, 10-14 agent 4, 14-20 agent 6, 20-23 human 3.
		expect(payload).toMatchObject({ active_ms: 23 * MIN, team_driven_ms: 16 * MIN, human_messages: 2 });
	});

	it("sends nothing for no new records, but closing an open run still counts it", () => {
		const open = foldActivity(EMPTY_ACTIVITY_CURSOR, [rec(0), rec(60)], false).cursor;
		expect(foldActivity(open, [], false).payload).toBeUndefined();
		expect(foldActivity(open, [], true).payload).toMatchObject({ active_ms: 0, longest_run_ms: 0, window_start_ms: T0 + 60 * MIN });
		const closed = foldActivity(open, [], true).cursor;
		expect(foldActivity(closed, [], true).payload).toBeUndefined();
	});

	it("ignores a record older than one already seen for time, not for messages", () => {
		const { payload } = foldActivity(EMPTY_ACTIVITY_CURSOR, [rec(10), rec(5, "human"), rec(12)], true);
		expect(payload).toMatchObject({ active_ms: 2 * MIN, human_messages: 1 });
	});

	// Splitting a transcript at any record must not change what the sends add up to.
	const sample: ActivityRecord[] = [
		rec(0, "human"), rec(3), rec(9, "agent"), rec(15), rec(40), rec(41, "agent"), rec(50, "human"), rec(52),
		rec(300), rec(310, "agent"), rec(320), ...Array.from({ length: 80 }, (_, i) => rec(330 + i * 10, i === 40 ? "human" : undefined)),
		rec(2000), rec(2003, "human"),
	];
	it("gives the same sums at every split point", () => {
		const sum = (a: SessionActivityPayload | undefined, b: SessionActivityPayload | undefined) => ({
			active_ms: (a?.active_ms ?? 0) + (b?.active_ms ?? 0),
			team_driven_ms: (a?.team_driven_ms ?? 0) + (b?.team_driven_ms ?? 0),
			runs_over_12h: (a?.runs_over_12h ?? 0) + (b?.runs_over_12h ?? 0),
			longest_run_ms: Math.max(a?.longest_run_ms ?? 0, b?.longest_run_ms ?? 0),
			human_messages: (a?.human_messages ?? 0) + (b?.human_messages ?? 0),
		});
		const whole = foldActivity(EMPTY_ACTIVITY_CURSOR, sample, true).payload;
		expect(whole).toMatchObject({ runs_over_12h: 1, longest_run_ms: 820 * MIN, human_messages: 4 });
		const { window_start_ms, window_end_ms, ...wholeSums } = whole as SessionActivityPayload;
		expect(window_start_ms).toBe(sample[0]?.ts);
		expect(window_end_ms).toBe(sample.at(-1)?.ts);
		for (let split = 1; split < sample.length; split++) {
			const first = foldActivity(EMPTY_ACTIVITY_CURSOR, sample.slice(0, split), false);
			const second = foldActivity(first.cursor, sample.slice(split), true);
			expect(sum(first.payload, second.payload), `split at ${split}`).toEqual(wholeSums);
			expect(second.payload?.window_start_ms, `split at ${split}`).toBe(sample[split - 1]?.ts);
		}
	});
});

describe("readNewLines", () => {
	let directory: string;
	beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "session-activity-")); });
	afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

	it("stops before a half-written last line and picks it up once it is complete", async () => {
		const path = join(directory, "t.jsonl");
		writeFileSync(path, '{"a":1}\n{"a":2}\n{"a":');
		const lines: string[] = [];
		const first = await readNewLines(path, 0, 1000, line => lines.push(line));
		expect(first).toEqual({ offset: 16, done: true });
		appendFileSync(path, "3}\n");
		const second = await readNewLines(path, first.offset, 1000, line => lines.push(line));
		expect(lines).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);
		expect(second).toEqual({ offset: 24, done: true });
	});

	it("reads a backlog larger than its budget over several calls without losing or repeating a line", async () => {
		const path = join(directory, "big.jsonl");
		const all = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ i, pad: "é".repeat(60) }));
		writeFileSync(path, `${all.join("\n")}\n`);
		const seen: string[] = [];
		let offset = 0, calls = 0;
		for (;;) {
			const read = await readNewLines(path, offset, -1, line => seen.push(line)); // budget already spent: one chunk per call
			offset = read.offset; calls++;
			if (read.done) break;
		}
		expect(calls).toBeGreaterThan(2);
		expect(seen).toEqual(all);
	});
});

describe("isAgentText", () => {
	it("recognises the Reach ring, the Reach seat start and a heartbeat tick, from their real wording", () => {
		expect(isAgentText("REACH-RING Guide: /home/lh/.local/lib/sno-reach/releases/2.0.4/guide/agent-reach.md. State: /home/lh/.local/state/sno-reach. Seat: hand.sno-cli-core-2@gpt1. 354e30cd typed by the mail transport, not by the owner. You have unanswered mail as 'hand.sno-cli-core-2@gpt1'. Read Message-ID <dcd8e7fe@gpt1> now.")).toBe(true);
		expect(isAgentText("[MAILBOX-DOORBELL 09753524] typed by the mail transport, not by the owner. You have unanswered mail as 'worker.stage0b-claude@gpt1'.")).toBe(true);
		expect(isAgentText("You are the seat worker.x@gpt1. Your state root is /r. Read the installed guide /g before using Reach. No work is assigned by this startup message. After reading the guide, finish this turn.")).toBe(true);
		expect(isAgentText('<task-notification>\n<summary>Monitor event: "alive"</summary>\n<event>2026-10-04T07:59:19Z [codex-mab] tick=1 ok newest=a.log</event>')).toBe(true);
	});

	it("leaves a person's sentence alone, including one that mentions heartbeat or Reach", () => {
		expect(isAgentText("set a heartbeat every 10 minutes and tell Reach to ring the reviewer")).toBe(false);
		expect(isAgentText("继续，没问题。")).toBe(false);
	});
});
