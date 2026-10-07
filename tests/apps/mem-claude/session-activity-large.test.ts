/**
 * The SessionEnd hook runs under CODING_SKIN_HOOKS.SessionEnd.timeout. The session.activity step of
 * a 490 MB transcript (3 million records, one per second, the person typing every 1000th) reads
 * only the records after its cursor, and a first send over the whole file stops at its read budget
 * on a line boundary; later sends finish the rest with every record counted once. The step may use
 * at most half of the hook's timeout.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActivityCursor, CODING_SKIN_HOOKS } from "@snoai/memory/coding-skin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reportSessionActivity } from "../../../apps/mem-claude/src/session-activity.ts";
import { writeLargeTranscript } from "../fixtures/large-transcript.ts";

const HALF_TIMEOUT_MS = CODING_SKIN_HOOKS.SessionEnd.timeout * 1000 / 2;
const RECORDS = 3_000_000;
const T0 = Date.UTC(2026, 9, 7, 8, 0, 0);
const PAD = "x".repeat(40);
const lineAt = (i: number): string => i % 1000 === 0
	? `{"type":"user","timestamp":"${new Date(T0 + i * 1000).toISOString()}","entrypoint":"cli","origin":{"kind":"human"},"message":{"role":"user","content":"${PAD}"}}\n`
	: `{"type":"assistant","timestamp":"${new Date(T0 + i * 1000).toISOString()}","entrypoint":"cli","message":{"role":"assistant","content":"${PAD}"}}\n`;

let root: string;
let transcript: string;
let size: number;
let tailOffset: number;
let previous: string | undefined;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "mem-claude-large-"));
	mkdirSync(join(root, "work"));
	transcript = join(root, "big.jsonl");
	({ size, tailOffset } = writeLargeTranscript(transcript, "", RECORDS, lineAt, 50));
	previous = process.env.SNO_PROFILE_DIR;
	process.env.SNO_PROFILE_DIR = root;
}, 120_000);
afterAll(() => {
	if (previous === undefined) delete process.env.SNO_PROFILE_DIR; else process.env.SNO_PROFILE_DIR = previous;
	rmSync(root, { recursive: true, force: true });
});

const send = (cursor?: ActivityCursor) => reportSessionActivity(cursor, { session_id: "s", cwd: join(root, "work"), transcript_path: transcript }, "SessionEnd");
function rows(): Record<string, number>[] {
	const path = join(root, "observe", "ledger.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(row => JSON.parse(row).payload) : [];
}
function byteBefore(offset: number): string {
	const fd = openSync(transcript, "r");
	try { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, offset - 1); return b.toString(); } finally { closeSync(fd); }
}

describe("Claude Code session.activity on a large transcript", () => {
	it("is a few hundred MB, so the tests mean something", () => {
		expect(size).toBeGreaterThan(200_000_000);
		expect(statSync(transcript).size).toBe(size);
	});

	it("reads only the records after a cursor near the end, in well under a second", async () => {
		const tail = RECORDS - 50;
		const cursor: ActivityCursor = { offset: tailOffset, lastTs: T0 + (tail - 1) * 1000, runStart: T0, agentDriven: false, counted: false };
		const started = performance.now();
		const next = await send(cursor);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(1000);
		expect(elapsed).toBeLessThanOrEqual(HALF_TIMEOUT_MS);
		expect(next.offset).toBe(size);
		// 50 new records a second apart, joined to the cursor's last record: 50 gaps, and none of them is a typed one (those are every 1000th).
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({ window_start_ms: T0 + (tail - 1) * 1000, window_end_ms: T0 + (RECORDS - 1) * 1000, active_ms: 50 * 1000, human_messages: 0 });
	});

	it("takes a first send over the whole file within its budget, then finishes it over later sends with every record counted once", async () => {
		const ledgerBefore = rows().length;
		let cursor: ActivityCursor | undefined;
		let sends = 0;
		for (;;) {
			const started = performance.now();
			cursor = await send(cursor);
			expect(performance.now() - started, `send ${sends + 1}`).toBeLessThanOrEqual(HALF_TIMEOUT_MS);
			sends++;
			if (sends === 1) {
				// The whole file did not fit the budget: the cursor stopped part-way, on a line boundary.
				expect(cursor.offset).toBeGreaterThan(0);
				expect(cursor.offset).toBeLessThan(size);
				expect(byteBefore(cursor.offset)).toBe("\n");
			}
			if (cursor.offset === size) break;
			expect(sends).toBeLessThan(40);
		}
		expect(sends).toBeGreaterThan(1);
		const sent = rows().slice(ledgerBefore);
		const sum = (key: string): number => sent.reduce((total, row) => total + (row[key] ?? 0), 0);
		expect(sum("active_ms")).toBe((RECORDS - 1) * 1000);
		expect(sum("human_messages")).toBe(RECORDS / 1000);
		// One continuous 35-day run: counted once, when the session end closes it on the last send.
		expect(sum("runs_over_12h")).toBe(1);
		expect(Math.max(...sent.map(row => row.longest_run_ms ?? 0))).toBe((RECORDS - 1) * 1000);
		expect(sent[0]?.window_start_ms).toBe(T0);
		expect(sent.at(-1)?.window_end_ms).toBe(T0 + (RECORDS - 1) * 1000);
	}, 120_000);
});
