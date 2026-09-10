/** Real filesystem operations. No mocking. */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findPreviousSessionFile,
	readSessionMessages,
	readSessionContentWithResetFallback,
	sortFileNamesByMtimeDesc,
} from "../../../../apps/mem-claw/src/operations/session-summary-storage.ts";

/**
 * mtime-based session file sorting — integration tests.
 *
 * Validates that sortFileNamesByMtimeDesc, readSessionContentWithResetFallback,
 * and findPreviousSessionFile honour filesystem mtime instead of lexicographic
 * ordering.
 *
 * Spec: openspec/changes/mem-claw-catchup/specs/session-recovery/spec.md
 *   - "mtime-based session file sorting" (scenarios 1-5)
 *   - "Reset fallback uses mtime sorting" (scenarios 1-2)
 */
describe("mtime-based session file sorting", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "mtime-sort-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── sortFileNamesByMtimeDesc ──────────────────────────────────────

	it("sorts files by mtime descending, not by name", async () => {
		// "b.jsonl" is lexicographically later but gets an OLDER mtime.
		// "a.jsonl" gets a NEWER mtime.
		const fileA = "a.jsonl";
		const fileB = "b.jsonl";
		writeFileSync(join(tmpDir, fileA), "a");
		writeFileSync(join(tmpDir, fileB), "b");

		const now = Date.now() / 1000;
		utimesSync(join(tmpDir, fileA), now, now); // newer
		utimesSync(join(tmpDir, fileB), now - 100, now - 100); // older

		const sorted = await sortFileNamesByMtimeDesc(tmpDir, [fileA, fileB]);

		expect(sorted).toEqual([fileA, fileB]);
		// fileA (newer mtime) must come first despite being lexicographically earlier
		expect(sorted[0]).toBe(fileA);
	});

	it("returns a single file unchanged", async () => {
		const file = "only.jsonl";
		writeFileSync(join(tmpDir, file), "x");

		const sorted = await sortFileNamesByMtimeDesc(tmpDir, [file]);

		expect(sorted).toEqual([file]);
	});

	it("returns empty array for empty input", async () => {
		const sorted = await sortFileNamesByMtimeDesc(tmpDir, []);

		expect(sorted).toEqual([]);
	});

	it("sorts three files correctly when middle filename has newest mtime", async () => {
		const files = ["alpha.jsonl", "beta.jsonl", "gamma.jsonl"];
		for (const f of files) {
			writeFileSync(join(tmpDir, f), f);
		}

		const now = Date.now() / 1000;
		utimesSync(join(tmpDir, "alpha.jsonl"), now - 200, now - 200); // oldest
		utimesSync(join(tmpDir, "beta.jsonl"), now, now); // newest
		utimesSync(join(tmpDir, "gamma.jsonl"), now - 100, now - 100); // middle

		const sorted = await sortFileNamesByMtimeDesc(tmpDir, files);

		expect(sorted[0]).toBe("beta.jsonl"); // newest mtime first
		expect(sorted[1]).toBe("gamma.jsonl");
		expect(sorted[2]).toBe("alpha.jsonl"); // oldest mtime last
	});

	it("produces deterministic order for identical mtimes (tiebreaker: b.name.localeCompare(a.name))", async () => {
		const fileX = "x-session.jsonl";
		const fileY = "y-session.jsonl";
		writeFileSync(join(tmpDir, fileX), "x");
		writeFileSync(join(tmpDir, fileY), "y");

		// Set identical mtime
		const fixedTime = Date.now() / 1000;
		utimesSync(join(tmpDir, fileX), fixedTime, fixedTime);
		utimesSync(join(tmpDir, fileY), fixedTime, fixedTime);

		// Run multiple times to confirm determinism
		const results: string[][] = [];
		for (let i = 0; i < 5; i++) {
			results.push(await sortFileNamesByMtimeDesc(tmpDir, [fileX, fileY]));
		}

		// All runs must produce the same order
		const first = results[0];
		if (!first) throw new Error("expected at least one result");
		for (const r of results) {
			expect(r).toEqual(first);
		}

		// Tiebreaker is b.name.localeCompare(a.name) — descending by name,
		// so "y-session.jsonl" > "x-session.jsonl" → y first.
		expect(first).toEqual([fileY, fileX]);
	});

	// ── readSessionContentWithResetFallback ───────────────────────────

	it("reset fallback selects the snapshot with newest mtime", async () => {
		const sessionFile = join(tmpDir, "session.jsonl");
		const resetLexicographicLatest = join(tmpDir, "session.jsonl.reset.1700000001");
		const resetNewestMtime = join(tmpDir, "session.jsonl.reset.1699999999");

		// Primary session has only slash commands — no usable conversation
		writeFileSync(
			sessionFile,
			'{"type":"message","message":{"role":"user","content":"/new topic"}}\n',
		);

		// Older reset snapshot — content we do NOT want
		writeFileSync(
			resetLexicographicLatest,
			'{"type":"message","message":{"role":"user","content":"old snapshot content"}}\n' +
				'{"type":"message","message":{"role":"assistant","content":"old assistant reply"}}\n',
		);

		// Newer reset snapshot — content we DO want
		writeFileSync(
			resetNewestMtime,
			'{"type":"message","message":{"role":"user","content":"newest snapshot content"}}\n' +
				'{"type":"message","message":{"role":"assistant","content":"newest assistant reply"}}\n',
		);

		const now = Date.now() / 1000;
		// Give the lexicographically older filename a newer mtime.
		utimesSync(resetLexicographicLatest, now - 200, now - 200);
		utimesSync(resetNewestMtime, now, now);

		const result = await readSessionContentWithResetFallback(sessionFile);

		expect(result).not.toBeNull();
		expect(result).toContain("newest snapshot content");
		expect(result).not.toContain("old snapshot content");
	});

	it("returns null when session has only slash commands and no reset snapshots", async () => {
		const sessionFile = join(tmpDir, "session.jsonl");

		writeFileSync(
			sessionFile,
			'{"type":"message","message":{"role":"user","content":"/new topic"}}\n' +
				'{"type":"message","message":{"role":"user","content":"/note something"}}\n',
		);

		const result = await readSessionContentWithResetFallback(sessionFile);

		expect(result).toBeNull();
	});

	it("retains only the last eligible messages from a large JSONL session file", async () => {
		const sessionFile = join(tmpDir, "large-session.jsonl");
		const lines = Array.from({ length: 1500 }, (_, index) =>
			JSON.stringify({
				type: "message",
				message: {
					role: index % 2 === 0 ? "user" : "assistant",
					content: `large session message ${index}`,
				},
			}),
		);
		writeFileSync(sessionFile, `${lines.join("\n")}\n`);

		const result = await readSessionMessages(sessionFile, 3);

		expect(result).not.toBeNull();
		expect(result).toContain("large session message 1497");
		expect(result).toContain("large session message 1498");
		expect(result).toContain("large session message 1499");
		expect(result).not.toContain("large session message 1496");
		expect(result).not.toContain("large session message 0");
	});

	it("does not use reset fallback for empty topic session files", async () => {
		const sessionFile = join(tmpDir, "abc-topic-2.jsonl");
		const staleReset = join(tmpDir, "abc-topic-2.jsonl.reset.1700000000");

		writeFileSync(sessionFile, '{"type":"message","message":{"role":"user","content":"/new topic"}}\n');
		writeFileSync(
			staleReset,
			'{"type":"message","message":{"role":"user","content":"stale topic reset content"}}\n',
		);

		const result = await readSessionContentWithResetFallback(sessionFile);
		expect(result).toBeNull();
	});

	it("does not fall back to an unrelated latest non-reset session", async () => {
		const current = "current.jsonl";
		const previous = "previous.jsonl";
		writeFileSync(join(tmpDir, current), "current");
		writeFileSync(join(tmpDir, previous), "previous");

		const now = Date.now() / 1000;
		utimesSync(join(tmpDir, current), now, now);
		utimesSync(join(tmpDir, previous), now - 100, now - 100);

		const result = await findPreviousSessionFile(tmpDir, join(tmpDir, current), "current");
		expect(result).toBeUndefined();
	});

	it("returns undefined when the current non-reset session is the only candidate", async () => {
		const current = "current.jsonl";
		writeFileSync(join(tmpDir, current), "current");

		const result = await findPreviousSessionFile(tmpDir, join(tmpDir, current), "current");
		expect(result).toBeUndefined();
	});

	it("maps a reset snapshot back to its base session file", async () => {
		const base = "session.jsonl";
		const reset = "session.jsonl.reset.1700000000";
		writeFileSync(join(tmpDir, base), "base");
		writeFileSync(join(tmpDir, reset), "reset");

		const result = await findPreviousSessionFile(tmpDir, join(tmpDir, reset), "session");
		expect(result).toBe(join(tmpDir, base));
	});
});
