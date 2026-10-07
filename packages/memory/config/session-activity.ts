import { createReadStream } from "node:fs";
import { z } from "zod";

/** A gap between two records of at most this long is working time; a longer one ends the run. */
const ACTIVITY_GAP_MS = 15 * 60_000;
/** A run counts in runs_over_12h once, in the send where it reaches this length, ended or not. */
const ACTIVITY_LONG_RUN_MS = 12 * 3_600_000;

/**
 * Text markers of messages the person did not write, seen in real transcripts on the owner's
 * machine (Claude Code 2.1.247 and Codex 0.160, 2026-08 to 2026-10). Heuristics, matched on text.
 */
/** Reach's ring and mailbox doorbell, typed into the agent's terminal (apps/reach/lib/reach-ring line 426); recorded as a human prompt by Claude Code and Codex. */
const REACH_RING_MARKER = "typed by the mail transport, not by the owner";
/** A heartbeat tick line, "<UTC time> [label] tick=N ..." (apps/heartbeat/bin/heartbeat line 507); Claude Code delivers it inside a Monitor <task-notification>. */
const HEARTBEAT_TICK = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \[[^\]\n]+\] tick=\d+/;

/** The first prompt Reach gives a seat it starts in a terminal (apps/reach/lib/reach-spawn line 19). */
const REACH_SEAT_START_MARKER = "No work is assigned by this startup message";

/** True when the text of a user message came from another agent's tooling: a Reach ring or seat start, or a heartbeat wake. */
export function isAgentText(text: string): boolean {
	return text.includes(REACH_RING_MARKER) || text.includes(REACH_SEAT_START_MARKER) || HEARTBEAT_TICK.test(text);
}

/** One transcript record: its time, and who sent the incoming message it carries, if it carries one. */
export interface ActivityRecord {
	ts: number;
	incoming?: "human" | "agent";
}

/** Where the previous send stopped: a byte offset into the transcript and the run still open there. */
export interface ActivityCursor {
	offset: number;
	lastTs: number;
	/** Start of the continuous run still open at lastTs; 0 when no run is open. */
	runStart: number;
	/** The latest incoming message came from another agent. */
	agentDriven: boolean;
	/** The run still open was already counted in runs_over_12h. */
	counted: boolean;
	/** Codex only: the rollout file found by its first send. */
	path?: string;
}
export const activityCursorSchema: z.ZodType<ActivityCursor> = z.object({
	offset: z.number().int().nonnegative(),
	lastTs: z.number().int().nonnegative(),
	runStart: z.number().int().nonnegative(),
	agentDriven: z.boolean(),
	counted: z.boolean(),
	path: z.string().min(1).optional(),
});

export interface SessionActivityPayload {
	window_start_ms: number;
	window_end_ms: number;
	active_ms: number;
	team_driven_ms: number;
	runs_over_12h: number;
	longest_run_ms: number;
	human_messages: number;
}

export const EMPTY_ACTIVITY_CURSOR: ActivityCursor = { offset: 0, lastTs: 0, runStart: 0, agentDriven: false, counted: false };

/**
 * Folds the records after the cursor into one window. A gap belongs to the window of the record
 * that ends it, so splitting a transcript at any line gives the same sums. A run is counted in
 * runs_over_12h once, in the send where it reaches 12 hours, whether or not it has ended. longest_run_ms
 * is the longest run of any length seen in the window, including the length so far of the run still
 * open. `closeRun` ends the run still open at the last record (the session is over); otherwise it
 * stays open in the cursor.
 */
export function foldActivity(
	cursor: ActivityCursor,
	records: readonly ActivityRecord[],
	closeRun: boolean,
): { payload: SessionActivityPayload | undefined; cursor: ActivityCursor } {
	let { lastTs, runStart, agentDriven, counted } = cursor;
	let windowStart = runStart > 0 ? lastTs : 0;
	let active = 0, team = 0, human = 0, runs = 0, longest = 0;
	const seeRun = (end: number): void => {
		const length = end - runStart;
		longest = Math.max(longest, length);
		if (!counted && length >= ACTIVITY_LONG_RUN_MS) {
			runs++;
			counted = true;
		}
	};
	for (const record of records) {
		if (windowStart === 0) windowStart = record.ts;
		if (runStart === 0) runStart = record.ts;
		else if (record.ts > lastTs) {
			const gap = record.ts - lastTs;
			if (gap <= ACTIVITY_GAP_MS) {
				active += gap;
				if (agentDriven) team += gap;
			} else {
				seeRun(lastTs);
				runStart = record.ts;
				counted = false;
			}
		}
		lastTs = Math.max(lastTs, record.ts);
		if (runStart > 0) seeRun(lastTs);
		if (record.incoming === "human") { human++; agentDriven = false; }
		else if (record.incoming === "agent") agentDriven = true;
	}
	const closing = closeRun && runStart > 0;
	if (closing) { runStart = 0; counted = false; }
	const next = { ...cursor, lastTs, runStart, agentDriven, counted };
	if (records.length === 0 && !closing) return { payload: undefined, cursor: next };
	return {
		payload: {
			window_start_ms: windowStart > 0 ? windowStart : lastTs,
			window_end_ms: lastTs,
			active_ms: active,
			team_driven_ms: team,
			runs_over_12h: runs,
			longest_run_ms: longest,
			human_messages: human,
		},
		cursor: next,
	};
}

/**
 * Calls `onLine` for each complete line from `offset` on and returns the offset after the last
 * complete line, and whether the end of the file was reached. Stops reading once `budgetMs` has passed: real transcripts reach 1.65 GB while a
 * hook has seconds, so a long backlog is taken over several sends instead of failing every time.
 */
export async function readNewLines(
	path: string,
	offset: number,
	budgetMs: number,
	onLine: (line: string) => void,
): Promise<{ offset: number; done: boolean }> {
	const deadline = Date.now() + budgetMs;
	const stream = createReadStream(path, { start: offset });
	let pending: Buffer = Buffer.alloc(0);
	let consumed = offset;
	let done = true;
	try {
		for await (const chunk of stream) {
			pending = pending.length === 0 ? chunk as Buffer : Buffer.concat([pending, chunk as Buffer]);
			let from = 0;
			for (let end = pending.indexOf(10, from); end !== -1; end = pending.indexOf(10, from)) {
				if (end > from) onLine(pending.toString("utf8", from, end));
				from = end + 1;
			}
			consumed += from;
			pending = pending.subarray(from);
			if (Date.now() > deadline) { done = false; break; }
		}
	} finally {
		stream.destroy();
	}
	return { offset: consumed, done };
}
