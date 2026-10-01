/** Real ONNX embedder + real encrypted SQLite + real plugin runtime. No mocking. */

/**
 * Phase 0 §20.9 preservation test.
 *
 * `register()` MUST NOT issue any `UPDATE … SET suppressed_until_ms = …` at
 * startup — that field is a per-recall metadata column, never touched at
 * plugin boot.
 *
 * Two complementary checks:
 *   (a) Static: no `.ts` under `apps/mem-claw/src/plugin/` contains an SQL or
 *       JSON-patch shape that writes `suppressed_until_ms`. Plugin/ is the
 *       complete surface that `register()` can reach at startup; the only
 *       legitimate writer lives under `retrieval/` and is exercised by the
 *       per-recall hook chain, not register().
 *   (b) Behavioral: seed a memory with a known `suppressed_until_ms`, run
 *       `register(harness)` against the same DB, then re-read the metadata
 *       and assert the value is byte-identical. Catches any indirect mutation
 *       a static check could miss (transitive SQL, JSON merges, etc.).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { memClawPlugin } from "../../../../apps/mem-claw/src/install/openclaw-plugin-runtime.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { OpenClawPluginApiHarness } from "../helpers/openclaw-harness.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const PLUGIN_ROOT = path.resolve(
	import.meta.dirname,
	"../../../../packages/memory/src/engine/bindings",
);

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

/**
 * Plugin-side writes can only reach `suppressed_until_ms` via JS object-patch
 * shapes passed to `updateMetadata` / `applyMetadataDelta` — raw SQL writes
 * live exclusively in `storage/`. Detect both `:` (object literal) and `=`
 * (property assignment) shapes.
 */
const PATCH_ASSIGN_SUPPRESSED = /suppressed_until_ms\s*[:=]/;

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("Phase 0 §20.9 (a) — no startup-time suppression backfill in plugin/", () => {
	it("zero plugin/ files write suppressed_until_ms", () => {
		const files = [...walkTsFiles(PLUGIN_ROOT), ...walkTsFiles(path.resolve(import.meta.dirname, "../../../../apps/mem-claw/src"))];
		// Sanity guard: empty walk would make the check vacuous.
		expect(files.length).toBeGreaterThan(0);

		interface Hit {
			file: string;
			line: number;
			text: string;
		}
		const hits: Hit[] = [];

		for (const file of files) {
			const text = readFileSync(file, "utf8");
			if (!PATCH_ASSIGN_SUPPRESSED.test(text)) continue;
			// Drop benign read-only occurrences: comments, type-field declarations,
			// and the explicit `suppressed_until_ms: undefined` strip in
			// memory-recall-tool.ts (Phase 0 §7.4 — manual recall ALWAYS clears,
			// flag-agnostic; documented behavior, not a startup backfill).
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (line === undefined) continue;
				if (!PATCH_ASSIGN_SUPPRESSED.test(line)) continue;
				const trimmed = line.trim();
				if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
				if (trimmed.includes("suppressed_until_ms?:")) continue; // type field
				if (trimmed.includes("suppressed_until_ms: undefined")) continue; // §7.4 strip
				hits.push({
					file,
					line: i + 1,
					text: trimmed,
				});
			}
		}

		expect(
			hits,
			`found suppressed_until_ms writers in plugin/:\n${hits
				.map((h) => `  ${path.relative(PLUGIN_ROOT, h.file)}:${h.line}  ${h.text}`)
				.join("\n")}`,
		).toEqual([]);
	});
});

describe("Phase 0 §20.9 (b) — register() preserves pre-existing suppressed_until_ms", () => {
	interface Fixture {
		harness: OpenClawPluginApiHarness;
		store: MemoryStore;
		memoryId: string;
		seeded: { suppressed_until_ms: number; bad_recall_count: number };
		cleanup: () => Promise<void>;
	}

	let fixture: Fixture | undefined;

	beforeEach(() => {
		fixture = undefined;
	});

	afterEach(async () => {
		if (fixture) await fixture.cleanup();
	});

	async function buildAndSeed(): Promise<Fixture> {
		const stateDir = mkdtempSync(path.join(tmpdir(), "mem-claw-startup-suppr-"));
		const prevStateDir = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = stateDir;

		const testDb = createTestDb();

		// Seed BEFORE register(): write a memory with a known suppressed_until_ms.
		const seedStore = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
		const stored = await seedStore.store({
			text: "The user uses tabs for indentation across all projects.",
			category: "episodic",
			projectId: "global",
			importance: 0.5,
		});
		const SEED_SUPPRESSED = 9_999_999_999_999; // year ~2286, well past any clock
		const SEED_BAD_COUNT = 3;
		await seedStore.updateMetadata(stored.id, {
			suppressed_until_ms: SEED_SUPPRESSED,
			bad_recall_count: SEED_BAD_COUNT,
		});
		seedStore.closeSync();

		// Now run register() against the same DB.
		const harness = new OpenClawPluginApiHarness(
			{
				embedding: { dimensions: 1024 },
				dbPath: testDb.dbPath,
				ambientLearning: false,
				autoRecall: false,
				sessionStrategy: "none",
			},
			{ runtimeAgentId: "startup-suppression-agent" },
		);
		await memClawPlugin.register(harness);

		// Re-open the store to read what register() left behind.
		const store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });

		async function cleanup(): Promise<void> {
			try {
				store.closeSync();
			} catch {
				// already closed
			}
			testDb.cleanup();
			try {
				rmSync(stateDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
			if (prevStateDir === undefined) delete process.env.SNO_PROFILE_DIR;
			else process.env.SNO_PROFILE_DIR = prevStateDir;
		}

		return {
			harness,
			store,
			memoryId: stored.id,
			seeded: { suppressed_until_ms: SEED_SUPPRESSED, bad_recall_count: SEED_BAD_COUNT },
			cleanup,
		};
	}

	it("seeded suppressed_until_ms is byte-identical after register()", async () => {
		fixture = await buildAndSeed();
		const { store, memoryId, seeded } = fixture;

		const entry = store.getById(memoryId);
		expect(entry, `memory ${memoryId} disappeared`).toBeDefined();
		// `MemoryEntry.metadata` is the raw JSON string from the row, not a
		// parsed object — parse it here at the assertion boundary.
		const raw = entry?.metadata ?? "{}";
		const meta = JSON.parse(raw) as {
			suppressed_until_ms?: number;
			bad_recall_count?: number;
		};

		expect(meta.suppressed_until_ms).toBe(seeded.suppressed_until_ms);
		expect(meta.bad_recall_count).toBe(seeded.bad_recall_count);
	});
});
