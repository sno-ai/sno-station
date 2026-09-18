/** Real store, real SQLite, real embedder. No mocking. */

/**
 * The one-off cleanup over a store written before the content hash identified content.
 *
 * The rows planted here are the three shapes the 2026-08-29 store census found on a real
 * 127-row store: one sentence held two or three times under distinct planted hashes, one of
 * our own extraction prompts stored as if it were a memory, and a row that names a successor
 * but was never marked invalid so recall still serves it as current.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client";
import { cleanStore } from "../../../../packages/sno-station-mem/src/store/store-cleanup-cli";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;
const SCOPE = "global";
const DUPLICATE_TEXT = "For Project Prism the handoff code is PRISM-7741.";
const PROMPT_TEXT =
	"user: You are a memory extraction assistant. Always respond with valid JSON only.\n" +
	"<<<BEGIN_UNTRUSTED[01de3248-62fa-4c06-b715-e0a43510f157]:USER>>>\nUser\n" +
	"<<<END_UNTRUSTED[01de3248-62fa-4c06-b715-e0a43510f157]:USER>>>";

interface Planted {
	id: string;
	text: string;
	hash: string;
	metadata: Record<string, unknown>;
	timestamp: number;
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("store cleanup over a store written under the old content hash", () => {
	let fixture: ReturnType<typeof createTestDb>;
	let store: MemoryStore;

	const plant = (row: Planted): void => {
		(
			fixture.runtime.db as unknown as {
				prepare: (sql: string) => { run: (...p: unknown[]) => unknown };
			}
		)
			.prepare(
				`INSERT INTO nodix_memories(
					id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id
				) VALUES (?, ?, 'episodic', ?, 0.7, ?, 'UTC', ?, ?, ?)`,
			)
			.run(
				row.id,
				row.text,
				SCOPE,
				row.timestamp,
				JSON.stringify(row.metadata),
				row.hash,
				`fact-${row.id}`,
			);
	};

	const readRows = (): Array<{ id: string; text: string; metadata: string }> =>
		(
			fixture.runtime.db as unknown as {
				prepare: (sql: string) => { all: (...p: unknown[]) => unknown };
			}
		)
			.prepare("SELECT id, text, metadata FROM nodix_memories ORDER BY id")
			.all() as Array<{ id: string; text: string; metadata: string }>;

	beforeEach(() => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder: testEmbedder });
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	it("collapses copies, drops a stored prompt, and stamps a superseded row", async () => {
		plant({ id: "copy-a", text: DUPLICATE_TEXT, hash: "a".repeat(64), metadata: {}, timestamp: 1000 });
		plant({ id: "copy-b", text: DUPLICATE_TEXT, hash: "b".repeat(64), metadata: {}, timestamp: 2000 });
		plant({ id: "copy-c", text: DUPLICATE_TEXT, hash: "c".repeat(64), metadata: {}, timestamp: 3000 });
		plant({ id: "prompt-row", text: PROMPT_TEXT, hash: "d".repeat(64), metadata: {}, timestamp: 4000 });
		plant({
			id: "old-position",
			text: "The user's favourite band is Death Cab for Cutie.",
			hash: "e".repeat(64),
			metadata: { superseded_by: "new-position" },
			timestamp: 5000,
		});
		plant({
			id: "new-position",
			text: "The user's favourite band is Big Thief.",
			hash: "f".repeat(64),
			metadata: {},
			timestamp: 6000,
		});
		plant({
			id: "points-at-a-copy",
			text: "An unrelated note that still points at a copy.",
			hash: "0".repeat(64),
			metadata: { superseded_by: "copy-c" },
			timestamp: 7000,
		});

		const result = await cleanStore(store, { apply: true, label: "test store" });
		const rows = readRows();
		for (const row of rows) {
			console.log(`  ${row.id} ${JSON.stringify(row.text.slice(0, 60))} ${row.metadata}`);
		}

		expect(result.promptRows).toBe(1);
		expect(result.redundantCopies).toBe(2);
		expect(rows.map((row) => row.id)).toEqual([
			"copy-a",
			"new-position",
			"old-position",
			"points-at-a-copy",
		]);
		const stamped = rows.find((row) => row.id === "old-position");
		expect(JSON.parse(stamped?.metadata ?? "{}").invalidated_at).toBe(6000);
		const repointed = rows.find((row) => row.id === "points-at-a-copy");
		expect(JSON.parse(repointed?.metadata ?? "{}").superseded_by).toBe("copy-a");
	});

	it("writes nothing without --apply", async () => {
		plant({ id: "copy-a", text: DUPLICATE_TEXT, hash: "a".repeat(64), metadata: {}, timestamp: 1000 });
		plant({ id: "copy-b", text: DUPLICATE_TEXT, hash: "b".repeat(64), metadata: {}, timestamp: 2000 });

		const result = await cleanStore(store, { apply: false, label: "test store" });
		expect(result.redundantCopies).toBe(1);
		expect(readRows()).toHaveLength(2);
	});
});
