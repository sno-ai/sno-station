import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldTranscript, readTurns, userQuery } from "../../../apps/mem-cursor/src/transcript.ts";

// Row shapes from Cursor IDE 3.24.9 and CLI 2026.10.01 agent transcripts (PRD §4.3 evidence).
const user = (query: string) => JSON.stringify({ role: "user", message: { content: [{ type: "text",
	text: `<timestamp>Friday, Oct 9, 2026, 3:45 PM (UTC-7)</timestamp>\n<user_query>\n${query}\n</user_query>` }] } });
const assistant = (...texts: string[]) => JSON.stringify({ role: "assistant", message: { content: [
	...texts.map(text => ({ type: "text", text })),
	{ type: "tool_use", name: "Shell", input: { command: "echo ok" } },
] } });
const ended = (status: string) => JSON.stringify(status === "success" ? { type: "turn_ended", status } : { type: "turn_ended", status, error: "You've hit your usage limit" });
const EMPTY = { offset: 0, users: 0 };

describe("Cursor transcript rows to captured turns", () => {
	it("takes only the text inside user_query, never the timestamp wrapper", () => {
		expect(userQuery("<timestamp>Thursday, Oct 8, 2026, 1:57 PM (UTC-7)</timestamp>\n<user_query>\nHi\n</user_query>")).toBe("Hi");
		expect(userQuery("<timestamp>Thursday, Oct 8, 2026</timestamp>\nplain words")).toBe("plain words");
	});

	it("pairs each user row with all assistant text up to turn_ended, skipping tool calls and failed turns", () => {
		const { turns, cursor } = foldTranscript(EMPTY, [
			user("Use pnpm in this repo from now on."),
			assistant("I'll check the lockfile first."),
			assistant("Switched: pnpm-lock.yaml is the lockfile now."),
			ended("success"),
			user("Run the release script."),
			assistant("Starting the release."),
			ended("error"),
		], false);
		expect(turns).toEqual([{ turnId: "u1", user: "Use pnpm in this repo from now on.",
			assistant: "I'll check the lockfile first.\n\nSwitched: pnpm-lock.yaml is the lockfile now." }]);
		expect(cursor).toEqual({ offset: 0, users: 2 });
	});

	it("a next user row ends the previous turn (resumed print runs write no turn_ended)", () => {
		const { turns } = foldTranscript(EMPTY, [user("Reply with the single word: one"), assistant("one"), user("What did you reply?"), assistant("one"), ended("success")], false);
		expect(turns.map(turn => [turn.turnId, turn.user, turn.assistant])).toEqual([["u1", "Reply with the single word: one", "one"], ["u2", "What did you reply?", "one"]]);
	});

	it("keeps an open turn pending until the conversation ends, then takes it", () => {
		const open = foldTranscript(EMPTY, [user("Explain the cache layer"), assistant("The cache sits in front of the store.")], false);
		expect(open.turns).toEqual([]);
		expect(open.cursor.pending).toEqual({ turnId: "u1", user: "Explain the cache layer", assistant: "The cache sits in front of the store." });
		expect(foldTranscript(open.cursor, [], true).turns).toEqual([open.cursor.pending]);
		expect(foldTranscript(EMPTY, [user("no answer yet")], true).turns).toEqual([]);
	});

	it("skips an unparsable row and keeps going", () => {
		const { turns } = foldTranscript(EMPTY, ["{not json", user("Pin node 24"), assistant("Pinned in .nvmrc."), ended("success")], false);
		expect(turns).toHaveLength(1);
	});
});

describe("reading a transcript file from the saved cursor", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mem-cursor-transcript-")); });
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("captures each turn once across reads and numbers turns stably", async () => {
		const path = join(root, "conversation.jsonl");
		writeFileSync(path, `${[user("First decision: tabs."), assistant("Noted, tabs."), ended("success"), user("Second: no default exports.")].join("\n")}\n`);
		const first = await readTurns(path, EMPTY, 1_000, false);
		expect(first.turns.map(turn => turn.turnId)).toEqual(["u1"]);
		appendFileSync(path, `${[assistant("Understood, named exports only."), ended("success")].join("\n")}\n`);
		const second = await readTurns(path, first.cursor, 1_000, false);
		expect(second.turns).toEqual([{ turnId: "u2", user: "Second: no default exports.", assistant: "Understood, named exports only." }]);
		const third = await readTurns(path, second.cursor, 1_000, true);
		expect(third.turns).toEqual([]);
		// A re-read from an older cursor (its save failed) repeats the same ids, so the sidecar deduplicates.
		expect((await readTurns(path, first.cursor, 1_000, false)).turns[0]?.turnId).toBe("u2");
	});
});
