/** Real store, real SQLite, real embedder. No mocking. */

/**
 * `content_hash` must identify the CONTENT, and write identity must be asked separately.
 *
 * Until 2026-08-30 `hashInputForEntry` short-circuited on `metadata.idempotency_key` and
 * returned a hash of that key alone, so the stored `content_hash` carried no trace of the
 * text. The key is built per write from session key + extraction trace + payload fingerprint
 * (`buildExtractionIdempotencyKey`), so the same sentence written from two chunks, two
 * sessions or two producers hashed differently and the UNIQUE index on
 * (project_id, content_hash, category) could not collapse it. Measured 2026-08-29 on a
 * 127-row store from one Agent E2E run: 10 groups of byte-identical text, 0 groups of
 * identical hash, 12 redundant rows.
 *
 * Both questions still have to be answered, so both are proved here:
 *  1. same text + same category + same scope, DIFFERENT write keys  -> one row.
 *  2. same text + same write key (an ordinary retry)                -> one row.
 *  3. same write key + different text (the retry contract)          -> one row, first text kept.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

const SCOPE = "global";
const SHARED_TEXT =
	"For Project Prism the saved handoff code is PRISM-7741 and the status color is amber.";

interface StoredRow {
	id: string;
	text: string;
	category: string;
	contentHash: string;
	metadata: string;
}

function dumpRows(store: MemoryStore, label: string): StoredRow[] {
	const rows = (
		store as unknown as {
			sqlite: { prepare: (sql: string) => { all: (...p: unknown[]) => unknown } };
		}
	).sqlite
		.prepare(
			"SELECT id, text, category, content_hash AS contentHash, metadata FROM nodix_memories WHERE project_id = ? ORDER BY timestamp",
		)
		.all(SCOPE) as StoredRow[];
	console.log(`\n[${label}] ${rows.length} row(s) in scope '${SCOPE}':`);
	for (const row of rows) {
		console.log(
			`  id=${row.id.slice(0, 8)} category=${row.category} hash=${row.contentHash.slice(0, 12)} text=${JSON.stringify(row.text.slice(0, 80))}`,
		);
		console.log(`    metadata=${row.metadata}`);
	}
	return rows;
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("content_hash identifies content, idempotency key identifies the write", () => {
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
	});

	afterEach(async () => {
		await store.close();
		cleanup();
	});

	it("collapses byte-identical text written under two different write keys", async () => {
		const first = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ idempotency_key: "a".repeat(64) }),
		});
		const second = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ idempotency_key: "b".repeat(64) }),
		});

		const rows = dumpRows(store, "two write keys, one sentence");
		console.log(
			`  first.id=${first.id.slice(0, 8)} second.id=${second.id.slice(0, 8)} sameHash=${first.contentHash === second.contentHash}`,
		);
		expect(rows).toHaveLength(1);
		expect(second.id).toBe(first.id);
		expect(second.contentHash).toBe(first.contentHash);
	});

	it("collapses an ordinary retry of the same write", async () => {
		const key = JSON.stringify({ idempotency_key: "c".repeat(64) });
		const first = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: key,
		});
		const retry = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: key,
		});

		const rows = dumpRows(store, "same write, retried");
		expect(rows).toHaveLength(1);
		expect(retry.id).toBe(first.id);
	});

	it("keeps the first text when the same write key returns with different text", async () => {
		const key = JSON.stringify({ idempotency_key: "d".repeat(64) });
		const first = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: key,
		});
		const reworded = await store.store({
			text: "For Project Prism the handoff code is PRISM-7741; status color amber.",
			category: "episodic",
			projectId: SCOPE,
			metadata: key,
		});

		const rows = dumpRows(store, "same write key, reworded text");
		expect(rows).toHaveLength(1);
		expect(reworded.id).toBe(first.id);
		expect(rows[0]?.text).toBe(SHARED_TEXT);
	});

	it("keeps two genuinely different sentences apart", async () => {
		await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ idempotency_key: "e".repeat(64) }),
		});
		await store.store({
			text: "For Project Prism the on-call pager rotation starts on Monday.",
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ idempotency_key: "f".repeat(64) }),
		});

		const rows = dumpRows(store, "two different sentences");
		expect(rows).toHaveLength(2);
	});
});
