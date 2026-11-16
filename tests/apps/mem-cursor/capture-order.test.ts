import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_SKIN_CAPTURE_QUIET_MS } from "@snoai/memory/coding-skin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endedSessionPath, spoolDirectory } from "../../../apps/mem-cursor/src/paths.js";
import { afterAgentResponse, stop, userPromptSubmit } from "../../../apps/mem-cursor/src/hooks.ts";
import { markSessionEnded } from "../../../apps/mem-cursor/src/session-state.js";
import { hasActionableSpool, nextCapture } from "../../../apps/mem-cursor/src/worker.js";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const now = 10 * CODING_SKIN_CAPTURE_QUIET_MS;
// About 2,000 estimated tokens: two of these do not fit one capture's input budget together.
const long = "The migration notes list every table the release touches and its owner. ".repeat(85);
let root: string;
let previous: string | undefined;

function entry(turnId: string, fields: Record<string, unknown>) {
	return { path: `/spool/${turnId}.json`, record: { turnId, project: "/repo", user: `user ${turnId}`, assistant: "ok", attempts: 0, state: "pending" as const, ...fields } };
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "mem-cursor-capture-order-"));
	previous = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = root;
});

afterEach(async () => {
	if (previous === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previous;
	await rm(root, { recursive: true, force: true });
});

describe("mem-cursor capture timing", () => {
	it.each(["ide", "cli"].flatMap(surface => [
		{ surface, preceding: "no keep-alive", keepAlive: false },
		{ surface, preceding: "keep-alive before the first real prompt", keepAlive: true },
	]))("$surface with $preceding: captures ordinary sessions including later marked prompts, but excludes sessions whose first real prompt is marked", async ({ surface, keepAlive }) => {
		await mkdir(join(homedir(), ".cache"), { recursive: true });
		const workspace = await mkdtemp(join(homedir(), ".cache", "mem-cursor-marked-capture-"));
		const command = process.argv[1];
		const invokedAs = process.env.CURSOR_INVOKED_AS;
		try {
			execFileSync("git", ["init", "-q", workspace]);
			if (surface === "cli") process.env.CURSOR_INVOKED_AS = "cursor-agent";
			else delete process.env.CURSOR_INVOKED_AS;
			// Keep the real spool observable without launching its detached consumer.
			process.argv[1] = "";
			writeSettingsFixture(root, { recall: { auto: false }, memoryPackage: { path: join(root, "no-memory-package") } });
			const transcripts: Record<string, string[]> = { "ordinary-capture": [], "marked-capture": [] };
			const base = { workspace_roots: [workspace], model: "default" };
			const spool = join(root, "sno-mem-cursor", "spool");
			const queued = async () => existsSync(spool) ? Promise.all((await readdir(spool)).map(async name => {
				const row = JSON.parse(await readFile(join(spool, name), "utf8"));
				return { user: row.user, assistant: row.assistant };
			})) : [];
			const turn = async (session: string, generation: string, prompt: string, reply: string) => {
				const transcript = join(root, `${session}.jsonl`);
				const input = { ...base, conversation_id: session, transcript_path: surface === "cli" ? transcript : null, generation_id: generation };
				await userPromptSubmit({ ...input, prompt });
				if (surface === "ide") await afterAgentResponse({ ...input, text: reply });
				else {
					const transcriptRows = transcripts[session];
					transcriptRows.push(
						JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `<user_query>\n${prompt}\n</user_query>` }] } }),
						JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: reply }] } }),
						JSON.stringify({ type: "turn_ended", status: "success" }),
					);
					await writeFile(transcript, `${transcriptRows.join("\n")}\n`);
				}
				await stop({ ...input, status: "completed" });
			};
			if (keepAlive) {
				await turn("ordinary-capture", "keep-alive", "[Sno Reach keep-alive]\nRemain available for Reach messages.", "Available.");
				expect(await queued()).toEqual([]);
			}
			await turn("ordinary-capture", "ordinary", "Keep invoices in cents.", "Recorded.");
			expect(await queued()).toEqual([{ user: "Keep invoices in cents.", assistant: "Recorded." }]);
			await turn("ordinary-capture", "marked", "[sno-oneshot] Station one-shot run, not a user session.\nKeep invoices in dollars.", "Recorded the automated instruction.");
			expect(await queued()).toHaveLength(2);
			expect(await queued()).toContainEqual({ user: "Keep invoices in cents.", assistant: "Recorded." });
			expect(await queued()).toContainEqual({ user: "[sno-oneshot] Station one-shot run, not a user session.\nKeep invoices in dollars.", assistant: "Recorded the automated instruction." });
			if (keepAlive) {
				await turn("marked-capture", "keep-alive", "[Sno Reach keep-alive]\nRemain available for Reach messages.", "Available.");
				expect(await queued()).toHaveLength(2);
			}
			await turn("marked-capture", "first", "[sno-oneshot] Station one-shot run, not a user session.\nKeep invoices in euros.", "Recorded euros.");
			expect(await queued()).toHaveLength(2);
			await turn("marked-capture", "second", "Keep invoices in pounds.", "Recorded pounds.");
			expect(await queued()).toHaveLength(2);
		} finally {
			process.argv[1] = command ?? "";
			if (invokedAs === undefined) delete process.env.CURSOR_INVOKED_AS;
			else process.env.CURSOR_INVOKED_AS = invokedAs;
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("waits for a session to be quiet or ended, then takes all its turns within the input budget", () => {
		const quiet = now - CODING_SKIN_CAPTURE_QUIET_MS;
		const entries = [
			entry("q1", { sessionId: "quiet", at: quiet - 1_000 }),
			entry("t1", { sessionId: "talking", at: now - 60_000 }),
			entry("q2", { sessionId: "quiet", at: quiet }),
		];
		expect(nextCapture(entries, new Set(), now)).toEqual({ batch: [entries[0], entries[2]], nextDueAt: now - 60_000 + CODING_SKIN_CAPTURE_QUIET_MS });
		// One millisecond short of the window, nothing is due.
		expect(nextCapture(entries, new Set(), now - 1).batch).toEqual([]);
		expect(nextCapture([entries[1]], new Set(), now).batch).toEqual([]);
		expect(nextCapture([entries[1]], new Set(["talking"]), now).batch).toEqual([entries[1]]);
		const split = [entry("l1", { sessionId: "long", user: long, at: 1 }), entry("l2", { sessionId: "long", user: long, at: 2 })];
		expect(nextCapture(split, new Set(), now).batch).toEqual([split[0]]);
	});

	it("wakes a worker for every queued session, which it captures when ended or quiet", async () => {
		await mkdir(spoolDirectory(), { recursive: true });
		const spool = (name: string, sessionId: string, at: number) => writeFile(join(spoolDirectory(), name),
			JSON.stringify({ sessionId, turnId: name, project: "/repo", user: "Keep the parser strict.", assistant: "Kept.", at, attempts: 0, state: "pending" }));
		expect(await hasActionableSpool(now)).toBe(false);
		// A session still talking is waited for, so the worker is there when its quiet window ends.
		await spool("0001.json", "talking", now);
		expect(await hasActionableSpool(now)).toBe(true);
		await markSessionEnded("talking");
		expect(await hasActionableSpool(now)).toBe(true);
		await rm(join(spoolDirectory(), "0001.json"));
		await spool("0002.json", "resting", now - 25 * 60_000);
		expect(await hasActionableSpool(now)).toBe(true);
		// The scan drops the marker of a session with nothing left in the spool.
		expect(existsSync(endedSessionPath("talking"))).toBe(false);
	});
});
