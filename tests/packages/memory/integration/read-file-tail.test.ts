/** Real fs (mkdtemp + writeFile + open). No mocks. */

/**
 * Regression for codex finding (utils.ts:144-173 / batch-C C3):
 *
 * `readFileTail` reads up to `maxBytes` from the tail of a file. If the
 * file is larger than `maxBytes` it drops the first partial line because
 * the read window almost certainly sliced mid-line. The bug: when the
 * 512KB tail contained NO newline at all (one giant truncated record),
 * the function returned `raw` — a partial JSONL record — which fed the
 * caller a half-line that JSON.parse would reject anyway, but more
 * dangerously could be partially valid and silently wrong.
 *
 * The fix returns "" when no newline is found in the tail window.
 *
 * Three real-fs cases:
 *   (a) Small file (size <= maxBytes): returned verbatim.
 *   (b) Large file (size > maxBytes) with newlines in tail: first
 *       partial line dropped — content starts after first \n.
 *   (c) Large file (size > maxBytes) with NO newline in tail: returns "".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTail } from "../../../../packages/memory/src/engine/shared/utils.ts";

describe("readFileTail (utils.ts) — codex C3 regression", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "mem-claw-readtail-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("(a) small file (size <= maxBytes) is returned verbatim", async () => {
		const filePath = join(tmp, "small.jsonl");
		const content =
			'{"event":"first"}\n{"event":"second"}\n{"event":"third"}\n';
		await writeFile(filePath, content, "utf8");

		// Use an explicit maxBytes well above file size.
		const out = await readFileTail(filePath, 4096);
		expect(out).toBe(content);
	});

	it("(b) large file with newlines in tail drops the first partial line", async () => {
		const filePath = join(tmp, "large-with-newlines.jsonl");

		// Produce a file > maxBytes (we use 1KB cap) where the tail window
		// contains at least one full newline. Each "record" is ~30 bytes;
		// 200 records = ~6KB total, comfortably > 1024.
		const records: string[] = [];
		for (let i = 0; i < 200; i++) {
			records.push(`{"i":${i},"v":"record-${i}"}`);
		}
		const fullContent = `${records.join("\n")}\n`;
		await writeFile(filePath, fullContent, "utf8");

		const maxBytes = 1024;
		const out = await readFileTail(filePath, maxBytes);

		// Length must be < maxBytes (we dropped at least the first partial
		// record), and the result must NOT start in the middle of a record.
		expect(out.length).toBeGreaterThan(0);
		expect(out.length).toBeLessThan(maxBytes);

		// Every newline-delimited line must parse as JSON — i.e. there is no
		// dangling partial record at the head.
		const lines = out.split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}

		// Sanity: the LAST record in the file is in the result (tail probe).
		expect(out).toContain('"i":199');
	});

	it("(c) large file with NO newline in tail returns empty string (regression)", async () => {
		const filePath = join(tmp, "large-no-newline.jsonl");

		// One enormous record with no newline, larger than our maxBytes cap.
		// Use plain text rather than JSON so the check is purely about the
		// newline-scan behavior (the function does no JSON parsing).
		const giant = "A".repeat(8192);
		await writeFile(filePath, giant, "utf8");

		const maxBytes = 1024;
		const out = await readFileTail(filePath, maxBytes);

		// The bug returned the 1024-byte tail of A's. The fix returns "".
		expect(out).toBe("");
	});

	it("(c-bis) large file whose only newline sits BEFORE the tail window also returns empty string", async () => {
		// File has a single newline very early on; the rest is a giant record
		// that overflows the tail window. The newline is *outside* the window
		// the function reads, so `firstNewline === -1` inside readFileTail and
		// it must return "".
		const filePath = join(tmp, "large-newline-before-window.jsonl");

		const head = "early\n"; // 6 bytes incl. newline
		const giant = "B".repeat(8192); // 8KB, no newlines
		await writeFile(filePath, head + giant, "utf8");

		const maxBytes = 1024;
		const out = await readFileTail(filePath, maxBytes);
		expect(out).toBe("");
	});
});
