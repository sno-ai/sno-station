import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_SKIN_CAPTURE_QUIET_MS } from "@snoai/memory/coding-skin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endedSessionPath, spoolDirectory } from "../../../apps/mem-codex/src/paths.js";
import { stop, userPromptSubmit } from "../../../apps/mem-codex/src/hooks.js";
import { markSessionEnded } from "../../../apps/mem-codex/src/session-state.js";
import { hasActionableSpool, nextCapture } from "../../../apps/mem-codex/src/worker.js";
import { writeSettingsFixture } from "../../packages/memory/fixtures/settings-file-fixture";

const now = 10 * CODING_SKIN_CAPTURE_QUIET_MS;
// About 2,000 estimated tokens: two of these do not fit one capture's input budget together.
const long = "The migration notes list every table the release touches and its owner. ".repeat(85);
let root: string;
let previous: string | undefined;

function entry(turnId: string, fields: Record<string, unknown>) {
	return { path: `/spool/${turnId}.json`, record: { turnId, project: "/repo", childCwd: "/repo", user: `user ${turnId}`, assistant: "ok", attempts: 0, state: "pending" as const, ...fields } };
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "mem-codex-capture-order-"));
	previous = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = root;
});

afterEach(async () => {
	if (previous === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previous;
	await rm(root, { recursive: true, force: true });
});

describe("mem-codex capture timing", () => {
	it("queues ordinary session turns including a later marked prompt, but no turns from a session whose first prompt is marked", async () => {
		await mkdir(join(homedir(), ".cache"), { recursive: true });
		const workspace = await mkdtemp(join(homedir(), ".cache", "mem-codex-marked-capture-"));
		const command = process.argv[1];
		try {
			// Keep the real spool observable without launching its detached consumer.
			process.argv[1] = "";
			writeSettingsFixture(root, { recall: { auto: false }, memoryPackage: { path: join(root, "no-memory-package") } });
			const base = { session_id: "ordinary-capture", cwd: workspace };
			const spool = join(root, "sno-mem-codex", "spool");
			const queued = async () => existsSync(spool) ? Promise.all((await readdir(spool)).map(async name => {
				const row = JSON.parse(await readFile(join(spool, name), "utf8"));
				return { user: row.user, assistant: row.assistant };
			})) : [];
			await userPromptSubmit({ ...base, turn_id: "ordinary", prompt: "Keep invoices in cents." });
			await stop({ ...base, turn_id: "ordinary", last_assistant_message: "Recorded." });
			expect(await queued()).toEqual([{ user: "Keep invoices in cents.", assistant: "Recorded." }]);
			await userPromptSubmit({ ...base, turn_id: "marked", prompt: "[sno-oneshot] Station one-shot run, not a user session.\nKeep invoices in dollars." });
			await stop({ ...base, turn_id: "marked", last_assistant_message: "Recorded the automated instruction." });
			expect(await queued()).toHaveLength(2);
			expect(await queued()).toContainEqual({ user: "Keep invoices in cents.", assistant: "Recorded." });
			expect(await queued()).toContainEqual({ user: "[sno-oneshot] Station one-shot run, not a user session.\nKeep invoices in dollars.", assistant: "Recorded the automated instruction." });
			const marked = { session_id: "marked-capture", cwd: workspace };
			await userPromptSubmit({ ...marked, turn_id: "first", prompt: "[sno-oneshot] Station one-shot run, not a user session.\nKeep invoices in euros." });
			await stop({ ...marked, turn_id: "first", last_assistant_message: "Recorded euros." });
			expect(await queued()).toHaveLength(2);
			await userPromptSubmit({ ...marked, turn_id: "second", prompt: "Keep invoices in pounds." });
			await stop({ ...marked, turn_id: "second", last_assistant_message: "Recorded pounds." });
			expect(await queued()).toHaveLength(2);
		} finally {
			process.argv[1] = command ?? "";
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

	it("packs consecutive import blocks up to the input budget, after every due session", () => {
		const block = (turnId: string, user: string) => entry(turnId, { sessionId: "import-notes", kind: "import", user, at: 1 });
		const small = [block("i1", "Service one deploys on Tuesdays."), block("i2", "Service two deploys on Fridays."), block("i3", "Service three never deploys.")];
		const due = entry("d1", { sessionId: "due", at: now - CODING_SKIN_CAPTURE_QUIET_MS });
		expect(nextCapture([...small, due], new Set(), now).batch.map(({ record }) => record.turnId)).toEqual(["d1"]);
		expect(nextCapture(small, new Set(), now).batch.map(({ record }) => record.turnId)).toEqual(["i1", "i2", "i3"]);
		const big = [block("b1", long), block("b2", long)];
		expect(nextCapture(big, new Set(), now).batch.map(({ record }) => record.turnId)).toEqual(["b1"]);
	});

	it("wakes a worker for every queued session, which it captures when ended or quiet", async () => {
		await mkdir(spoolDirectory(), { recursive: true });
		const spool = (name: string, sessionId: string, at: number) => writeFile(join(spoolDirectory(), name),
			JSON.stringify({ sessionId, turnId: name, project: "/repo", childCwd: "/repo", user: "Keep the parser strict.", assistant: "Kept.", at, attempts: 0, state: "pending" }));
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
