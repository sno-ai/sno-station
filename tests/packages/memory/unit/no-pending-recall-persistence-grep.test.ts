/**
 * Phase 0 §20.8 preservation test.
 *
 * `pendingRecall` is a transient in-session-memory artifact, not a persisted
 * field. Asserts that no `.ts` file under `apps/mem-claw/src/storage/` and no
 * Drizzle schema declaration mentions `pendingRecall` or its snake_case
 * equivalent.
 *
 * Scope is intentionally narrow:
 *   - storage modules: where any `pendingRecall` reference would imply DB persistence;
 *   - schema.ts: any column with that name would imply migration-level persistence.
 *
 * Out-of-scope by design: in-memory session-state modules (e.g.
 * `openclaw-session-state.ts`) which can legitimately hold transient
 * `pendingRecall` per Phase 0 §8.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const STORAGE_ROOT = path.resolve(
	import.meta.dirname,
	"../../../../apps/mem-claw/src/storage",
);
const SCHEMA_FILE = path.join(STORAGE_ROOT, "schema.ts");

const FORBIDDEN_NAMES: ReadonlyArray<string> = ["pendingRecall", "pending_recall"];

interface Hit {
	file: string;
	line: number;
	needle: string;
	text: string;
}

function walkTsFiles(root: string): string[] {
	const out: string[] = [];
	function visit(dir: string): void {
		for (const entry of readdirSync(dir)) {
			const full = path.join(dir, entry);
			const st = statSync(full);
			if (st.isDirectory()) {
				visit(full);
				continue;
			}
			if (st.isFile() && full.endsWith(".ts")) {
				out.push(full);
			}
		}
	}
	visit(root);
	return out;
}

function findHits(files: ReadonlyArray<string>, needles: ReadonlyArray<string>): Hit[] {
	const hits: Hit[] = [];
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;
			for (const needle of needles) {
				if (line.includes(needle)) {
					hits.push({ file, line: i + 1, needle, text: line.trim() });
				}
			}
		}
	}
	return hits;
}

describe("Phase 0 §20.8 — no pendingRecall persistence in storage or schema", () => {
	it("zero occurrences of pendingRecall/pending_recall under storage/", () => {
		const files = walkTsFiles(STORAGE_ROOT);
		// Sanity guard: if the walker yields zero files the test is meaningless.
		expect(files.length).toBeGreaterThan(0);

		const hits = findHits(files, FORBIDDEN_NAMES);
		expect(
			hits,
			`found persisted pendingRecall references in storage/:\n${hits
				.map(
					(h) =>
						`  ${path.relative(STORAGE_ROOT, h.file)}:${h.line}  [${h.needle}]  ${h.text}`,
				)
				.join("\n")}`,
		).toEqual([]);
	});

	it("schema.ts declares no pendingRecall column", () => {
		// Targeted check: Drizzle columns appear via `text("…")` / `integer("…")` /
		// `blob("…")` calls. A field with that name in any form must not exist.
		const text = readFileSync(SCHEMA_FILE, "utf8");
		for (const needle of FORBIDDEN_NAMES) {
			expect(text.includes(needle), `schema.ts references '${needle}'`).toBe(false);
		}
	});
});
