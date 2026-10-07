/**
 * session.activity from a Claude Code transcript: each field proven on transcripts written in the
 * real record shapes (Claude Code 2.1.x), read by the plugin's own reader and written to the observe
 * ledger exactly as the SessionEnd hook does. The kinds of message are the ones seen in real
 * transcripts: typed prompts, injected skill text, a Reach ring typed by the mail transport, a
 * heartbeat Monitor tick, another session's teammate message, and the compaction summary.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityCursor } from "@snoai/memory/coding-skin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeRecord, reportSessionActivity } from "../../../apps/mem-claude/src/session-activity.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 7, 8, 0, 0);
const RING = "REACH-RING Guide: /home/u/.local/lib/sno-reach/releases/2.0.4/guide/agent-reach.md. State: /home/u/.local/state/sno-reach. Seat: hand.x@gpt1. 354e30cd typed by the mail transport, not by the owner. You have unanswered mail as 'hand.x@gpt1'. Read Message-ID <abc@gpt1> now.";
const TICK = '<task-notification>\n<task-id>b87ojo7ya</task-id>\n<summary>Monitor event: "alive check"</summary>\n<event>2026-10-07T08:11:19Z [codex-mab] tick=2 ok newest=a.log</event>\n</task-notification>';
const FINISHED = '<task-notification>\n<task-id>a047bc51b11</task-id>\n<summary>Agent "Write tests" finished</summary>\n</task-notification>';
const TEAMMATE = 'Another Claude session sent a message:\n<teammate-message teammate_id="code-fixes" color="blue">done</teammate-message>';

type Extra = Record<string, unknown>;
const stamp = (minutes: number): string => new Date(T0 + minutes * MIN).toISOString();
const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
const base = (minutes: number, entrypoint = "cli"): Extra => ({ timestamp: stamp(minutes), entrypoint, sessionId: "s", isSidechain: false });
const typed = (minutes: number, text: string, extra: Extra = {}, entrypoint = "cli"): string => line({
	type: "user", ...base(minutes, entrypoint), origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: text }, ...extra,
});
const assistant = (minutes: number, entrypoint = "cli"): string => line({
	type: "assistant", ...base(minutes, entrypoint), message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
});
const toolResult = (minutes: number): string => line({
	type: "user", ...base(minutes), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
});
const notice = (minutes: number, text: string): string => line({
	type: "user", ...base(minutes), origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", message: { role: "user", content: text },
});

let root: string;
let transcript: string;
let previous: string | undefined;

function ledger(): { event_type: string; lane: string; ts_ms: number; payload: Record<string, unknown> }[] {
	const path = join(root, "observe", "ledger.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(row => JSON.parse(row)) : [];
}
const send = (cursor?: ActivityCursor): Promise<ActivityCursor> =>
	reportSessionActivity(cursor, { session_id: "s", cwd: root, transcript_path: transcript });

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mem-claude-activity-"));
	mkdirSync(join(root, "work"));
	transcript = join(root, "s.jsonl");
	previous = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = root;
});
afterEach(() => {
	if (previous === undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR = previous;
	rmSync(root, { recursive: true, force: true });
});

describe("Claude Code session.activity", () => {
	it("classifies each kind of user entry", () => {
		const kind = (entry: string) => claudeRecord(entry)?.incoming;
		expect(kind(typed(0, "继续，没问题。"))).toBe("human");
		expect(kind(typed(0, "<command-name>/prd-discover</command-name>"))).toBe("human");
		expect(kind(typed(0, "written by an older version", { origin: undefined, promptSource: undefined }))).toBe("human");
		expect(kind(typed(0, "Base directory for this skill: /home/u/.claude/skills/x", { isMeta: true, origin: undefined }))).toBeUndefined();
		expect(kind(typed(0, "This session is being continued from a previous conversation.", { isCompactSummary: true }))).toBeUndefined();
		expect(kind(toolResult(0))).toBeUndefined();
		expect(kind(typed(0, "<local-command-stdout>Goodbye!</local-command-stdout>"))).toBeUndefined();
		expect(kind(typed(0, "<bash-input> gh secret set X</bash-input>"))).toBeUndefined();
		expect(kind(typed(0, "[Request interrupted by user]"))).toBeUndefined();
		expect(kind(typed(0, RING))).toBe("agent");
		expect(kind(typed(0, "[MAILBOX-DOORBELL 09753524] typed by the mail transport, not by the owner. Read Message-ID <a@b> now."))).toBe("agent");
		expect(kind(notice(0, TICK))).toBe("agent");
		expect(kind(notice(0, FINISHED))).toBeUndefined();
		expect(kind(typed(0, TEAMMATE, { origin: undefined }))).toBe("agent");
		expect(kind(typed(0, "Write a pull-request description", { promptSource: "sdk", origin: undefined }, "sdk-cli"))).toBe("agent");
		expect(kind(assistant(0))).toBeUndefined();
		expect(claudeRecord(line({ type: "last-prompt", lastPrompt: "x" }))).toBeUndefined();
	});

	it("writes one session.activity row with every field right for a mixed session", async () => {
		writeFileSync(transcript,
			typed(0, "start") + assistant(1) + typed(2, "Base directory for this skill: /x", { isMeta: true, origin: undefined })
			+ toolResult(3) + typed(4, RING) + assistant(10) + notice(11, TICK) + notice(12, FINISHED)
			+ typed(13, "ok") + typed(14, "This session is being continued from a previous conversation.", { isCompactSummary: true })
			+ typed(15, "<local-command-stdout>x</local-command-stdout>") + typed(16, "<bash-input> ls</bash-input>")
			+ assistant(17) + assistant(34) + typed(35, TEAMMATE, { origin: undefined }));
		await send();
		const rows = ledger();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ event_type: "session.activity", lane: "memory", ts_ms: T0 + 35 * MIN, payload: {
			harness: "claude-code", window_start_ms: T0, window_end_ms: T0 + 35 * MIN,
			// Gaps of 1+1+1+1+6+1+1+1+4+1 minutes; the 17-minute gap before minute 34 ends the first run (0..17, under 12 hours, so longest_run_ms stays 0).
			active_ms: 18 * MIN,
			// Minutes 4 to 13 follow the ring and the heartbeat tick, until the person types at 13.
			team_driven_ms: 9 * MIN,
			runs_over_12h: 0, longest_run_ms: 0,
			// Typed at 0 and 13 only: skill text, ring, tick, summary, command output, shell input and teammate message are not the person's.
			human_messages: 2,
		} });
		expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual([
			"active_ms", "harness", "human_messages", "longest_run_ms", "runs_over_12h", "team_driven_ms", "window_end_ms", "window_start_ms",
		]);
	});

	it("counts nothing as the person's in a session another program started, and all of its time as team-driven", async () => {
		writeFileSync(transcript,
			typed(0, "Run exactly one Bash command", { promptSource: "sdk", origin: undefined }, "sdk-cli") + assistant(2, "sdk-cli")
			+ typed(5, "now the second", { promptSource: "sdk", origin: undefined }, "sdk-cli") + assistant(9, "sdk-cli"));
		await send();
		expect(ledger()[0]?.payload).toMatchObject({ active_ms: 9 * MIN, team_driven_ms: 9 * MIN, human_messages: 0 });
	});

	it("counts a 13-hour continuous run once", async () => {
		let text = typed(0, "overnight build");
		for (let minute = 10; minute <= 13 * 60; minute += 10) text += assistant(minute);
		writeFileSync(transcript, text);
		await send();
		expect(ledger()[0]?.payload).toMatchObject({ active_ms: 13 * HOUR, runs_over_12h: 1, longest_run_ms: 13 * HOUR, human_messages: 1 });
	});

	it("covers only new records on the next session end, and a compaction does not count anything twice", async () => {
		writeFileSync(transcript, typed(0, "first") + assistant(5) + typed(8, "second") + assistant(10));
		const cursor = await send();
		const size = readFileSync(transcript).length;
		expect(cursor).toMatchObject({ offset: size, lastTs: T0 + 10 * MIN, runStart: 0 });

		// Nothing was added: a second session end sends nothing.
		await send(cursor);
		expect(ledger()).toHaveLength(1);

		// After an hour the session is resumed; Claude Code compacts, then the person continues.
		appendFileSync(transcript,
			typed(70, "This session is being continued from a previous conversation. Summary: first, second.", { isCompactSummary: true })
			+ typed(71, "third") + assistant(75));
		await send(cursor);
		const rows = ledger();
		expect(rows).toHaveLength(2);
		expect(rows[0]?.payload).toMatchObject({ window_start_ms: T0, window_end_ms: T0 + 10 * MIN, active_ms: 10 * MIN, human_messages: 2 });
		expect(rows[1]?.payload).toMatchObject({ window_start_ms: T0 + 70 * MIN, window_end_ms: T0 + 75 * MIN, active_ms: 5 * MIN, human_messages: 1 });

		// The two sends together are the one-pass result.
		const whole = ledger();
		writeFileSync(join(root, "observe", "ledger.jsonl"), "");
		await send();
		const pass = ledger()[0]?.payload;
		expect(Number(whole[0]?.payload.active_ms) + Number(whole[1]?.payload.active_ms)).toBe(pass?.active_ms);
		expect(Number(whole[0]?.payload.human_messages) + Number(whole[1]?.payload.human_messages)).toBe(pass?.human_messages);
	});

	it("leaves a half-written last line for the next send", async () => {
		writeFileSync(transcript, typed(0, "first") + assistant(3));
		const half = JSON.stringify({ type: "assistant", ...base(6) }).slice(0, 40);
		appendFileSync(transcript, half);
		const cursor = await send();
		expect(cursor.offset).toBe(readFileSync(transcript).length - half.length);
		expect(ledger()[0]?.payload).toMatchObject({ window_end_ms: T0 + 3 * MIN, active_ms: 3 * MIN });
	});
});
