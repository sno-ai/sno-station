/**
 * session.activity from a Codex rollout file (Codex 0.160 record shapes: session_meta first, an
 * event_msg item_completed UserMessage for each typed prompt, the same prompt again as a
 * response_item with role user next to the injected AGENTS.md and skill text, and compacted
 * records that re-list earlier user messages). The plugin's own reader runs on rollout files in a
 * Codex home and writes the observe ledger as the Stop hook does.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityCursor } from "@snoai/memory/coding-skin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexRecord, reportSessionActivity } from "../../../apps/mem-codex/src/session-activity.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 7, 8, 0, 0);
const SESSION = "01a1142e-d0b9-7622-b703-a6cb1a6ae323";
const RING = "REACH-RING Guide: /home/u/.local/lib/sno-reach/releases/2.0.4/guide/agent-reach.md. State: /home/u/.local/state/sno-reach. Seat: hand.x@gpt1. 354e30cd typed by the mail transport, not by the owner. You have unanswered mail as 'hand.x@gpt1'. Read Message-ID <abc@gpt1> now.";

const stamp = (minutes: number): string => new Date(T0 + minutes * MIN).toISOString();
const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
const meta = (source: unknown): string => line({
	timestamp: stamp(0), type: "session_meta",
	payload: { id: SESSION, source, originator: source === "cli" ? "codex-tui" : "codex_exec", base_instructions: { text: "x".repeat(20_000) } },
});
const userMessage = (minutes: number, text: string): string => line({
	timestamp: stamp(minutes), type: "event_msg",
	payload: { type: "item_completed", item: { type: "UserMessage", id: "u", content: [{ type: "text", text }] } },
}) + line({
	timestamp: stamp(minutes), type: "response_item",
	payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});
const injected = (minutes: number): string => line({
	timestamp: stamp(minutes), type: "response_item",
	payload: { type: "message", role: "user", content: [
		{ type: "input_text", text: "# AGENTS.md instructions for /home/u/code/x\n\n<INSTRUCTIONS>..." },
		{ type: "input_text", text: "<environment_context>\n  <current_date>2026-10-07</current_date>" },
	] },
}) + line({
	timestamp: stamp(minutes), type: "response_item",
	payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skill>\n<name>less-is-more</name>\n<path>/home/u/.agents/skills/less-is-more/SKILL.md</path>" }] },
});
const work = (minutes: number): string => line({ timestamp: stamp(minutes), type: "event_msg", payload: { type: "token_count", info: null } });
const compacted = (minutes: number): string => line({
	timestamp: stamp(minutes), type: "compacted",
	payload: { message: "", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "an earlier typed prompt" }] }] },
});

let root: string;
let rollout: string;
let previous: Record<string, string | undefined>;

function ledger(): { event_type: string; lane: string; payload: Record<string, unknown> }[] {
	const path = join(root, "observe", "ledger.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(row => JSON.parse(row)) : [];
}
const stop = (cursor?: ActivityCursor): Promise<ActivityCursor> => reportSessionActivity(cursor, { session_id: SESSION, cwd: join(root, "work") });

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mem-codex-activity-"));
	mkdirSync(join(root, "work"));
	const directory = join(root, "codex", "sessions", "2026", "10", "07");
	mkdirSync(directory, { recursive: true });
	rollout = join(directory, `rollout-2026-10-07T08-00-00-${SESSION}.jsonl`);
	previous = { SNO_PROFILE_DIR: process.env.SNO_PROFILE_DIR, CODEX_HOME: process.env.CODEX_HOME };
	process.env.SNO_PROFILE_DIR = root;
	process.env.CODEX_HOME = join(root, "codex");
});
afterEach(() => {
	for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	rmSync(root, { recursive: true, force: true });
});

describe("Codex session.activity", () => {
	it("counts a typed prompt once, not its response_item twin, the injected text, or the compacted history", () => {
		const incoming = (entry: string, agentStarted = false) => entry.split("\n").filter(Boolean).map(row => codexRecord(row, agentStarted)?.incoming);
		expect(incoming(userMessage(1, "好，那现在 PRD 还有什么东西需要再做 review？"))).toEqual(["human", undefined]);
		expect(incoming(userMessage(1, RING))).toEqual(["agent", undefined]);
		expect(incoming(userMessage(1, "Run the review"), true)).toEqual(["agent", undefined]);
		expect(incoming(injected(1))).toEqual([undefined, undefined]);
		expect(incoming(compacted(1))).toEqual([undefined]);
		expect(incoming(work(1))).toEqual([undefined]);
		expect(codexRecord(line({ type: "session_meta", payload: {} }), false)).toBeUndefined();
	});

	it("writes one row with every field right for an interactive session", async () => {
		writeFileSync(rollout, meta("cli") + injected(0) + userMessage(1, "start") + work(3) + userMessage(4, RING) + work(10)
			+ compacted(11) + work(12) + userMessage(13, "ok") + work(16) + work(33) + work(34));
		const cursor = await stop();
		const rows = ledger();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ agent_id: "codex", event_type: "session.activity", lane: "memory", payload: {
			harness: "codex", window_start_ms: T0, window_end_ms: T0 + 34 * MIN,
			// Gaps of 1 (0-1) + 2 + 1 + 6 + 1 + 1 + 1 + 3 minutes; the 17-minute gap before minute 33 ends the run.
			active_ms: 16 * MIN + 1 * MIN,
			// The ring at minute 4 until the person types at 13.
			team_driven_ms: 9 * MIN,
			runs_over_12h: 0,
			// The run from 0 to 16 is the longest; the one from 33 to 34 is still open.
			longest_run_ms: 16 * MIN,
			human_messages: 2,
		} });
		expect(cursor).toMatchObject({ lastTs: T0 + 34 * MIN, runStart: T0 + 33 * MIN, path: rollout, offset: readFileSync(rollout).length });
	});

	it("reads a session whose first line is far longer than any fixed buffer", async () => {
		const huge = line({
			timestamp: stamp(0), type: "session_meta",
			payload: { id: SESSION, source: "exec", originator: "codex_exec", base_instructions: { text: "x".repeat(3_000_000) } },
		});
		writeFileSync(rollout, huge + userMessage(1, "Use the user-level Codex skill $ts-coder.") + work(5));
		await stop();
		expect(ledger()[0]?.payload).toMatchObject({ team_driven_ms: 4 * MIN, human_messages: 0 });
	});

	it("appends no row when the cursor cannot be saved, so the next send does not count the window twice", async () => {
		writeFileSync(rollout, meta("cli") + userMessage(1, "hi") + work(5) + work(9));
		const input = { session_id: SESSION, cwd: join(root, "work") };
		await expect(reportSessionActivity(undefined, input, async () => { throw new Error("session-state-busy"); })).rejects.toThrow("session-state-busy");
		expect(ledger()).toHaveLength(0);
		await reportSessionActivity(undefined, input);
		expect(ledger()).toHaveLength(1);
		expect(ledger()[0]?.payload).toMatchObject({ active_ms: 9 * MIN, human_messages: 1 });
	});

	it("treats every prompt of a codex exec session as another agent's, and its time as team-driven", async () => {
		writeFileSync(rollout, meta("exec") + userMessage(1, "Use the user-level Codex skill $ts-coder.") + work(5) + work(9));
		await stop();
		expect(ledger()[0]?.payload).toMatchObject({ active_ms: 9 * MIN, team_driven_ms: 8 * MIN, human_messages: 0 });
		rmSync(rollout);
		writeFileSync(rollout, meta({ subagent: { thread_spawn: { parent_thread_id: "p" } } }) + userMessage(1, "Translate this") + work(5));
		rmSync(join(root, "observe"), { recursive: true });
		await stop();
		expect(ledger()[0]?.payload).toMatchObject({ team_driven_ms: 4 * MIN, human_messages: 0 });
	});

	it("counts a 13-hour run split over Stop hooks once, in the send where it passes 12 hours", async () => {
		let first = meta("cli") + userMessage(0, "overnight job");
		for (let minute = 10; minute <= 7 * 60; minute += 10) first += work(minute);
		writeFileSync(rollout, first);
		const cursor = await stop();
		expect(ledger()[0]?.payload).toMatchObject({ runs_over_12h: 0, longest_run_ms: 7 * HOUR, active_ms: 7 * HOUR });

		let second = "";
		for (let minute = 7 * 60 + 10; minute <= 13 * 60; minute += 10) second += work(minute);
		appendFileSync(rollout, second);
		const middle = await stop(cursor);
		// Still open at 13 hours, and counted now: it passed 12 hours inside this send.
		expect(ledger()[1]?.payload).toMatchObject({ runs_over_12h: 1, longest_run_ms: 13 * HOUR, window_start_ms: T0 + 7 * HOUR, active_ms: 6 * HOUR });

		// The next turn comes an hour later; the 13-hour run ended before it.
		appendFileSync(rollout, userMessage(13 * 60 + 60, "next day") + work(13 * 60 + 65));
		await stop(middle);
		const rows = ledger();
		expect(rows).toHaveLength(3);
		expect(rows[2]?.payload).toMatchObject({ runs_over_12h: 0, longest_run_ms: 13 * HOUR, active_ms: 5 * MIN, human_messages: 1 });
		expect(rows.reduce((sum, row) => sum + Number(row.payload.runs_over_12h), 0)).toBe(1);
		expect(rows.reduce((sum, row) => sum + Number(row.payload.active_ms), 0)).toBe(13 * HOUR + 5 * MIN);
	});

	it("sends nothing for a Stop with no new records", async () => {
		writeFileSync(rollout, meta("cli") + userMessage(1, "hi") + work(2));
		const cursor = await stop();
		await stop(cursor);
		expect(ledger()).toHaveLength(1);
	});

	it("fails with a plain reason when the rollout file does not exist", async () => {
		await expect(stop()).rejects.toThrow("rollout-missing");
	});
});
