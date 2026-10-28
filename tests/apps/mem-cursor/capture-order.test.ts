import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_SKIN_CAPTURE_QUIET_MS } from "@snoai/memory/coding-skin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endedSessionPath, spoolDirectory } from "../../../apps/mem-cursor/src/paths.js";
import { markSessionEnded } from "../../../apps/mem-cursor/src/session-state.js";
import { hasActionableSpool, nextCapture } from "../../../apps/mem-cursor/src/worker.js";

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
