/** Real ONNX embedder + real encrypted SQLite. No mocking. Missing deps = FAIL. */

/**
 * Phase D (2026-07-13): `nodix_memory_chunk_vectors` gets `project_id` as a vec0
 * PARTITION KEY so project-scoped KNN queries skip irrelevant partitions
 * instead of a global scan. vec0 virtual tables cannot be ALTERed, and
 * mem-claw has never been npm-published (see apps/mem-claw/CLAUDE.md —
 * nothing is shipped until then), so no installed database has vectors
 * worth migrating in place. `ensureChunkVecTable` fails closed instead: an
 * empty pre-Phase-D table is dropped and recreated for free, and a
 * non-empty one throws, telling the operator to wipe or re-import.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { readChunkVecTableState } from "../../../../apps/mem-claw/src/storage/connection.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

interface Fixture {
	dbPath: string;
	cleanup: () => void;
}

function buildFixture(): Fixture {
	const testDb = createTestDb();
	return { dbPath: testDb.dbPath, cleanup: testDb.cleanup };
}

/** Downgrades a live vec table to the pre-Phase-D shape (no partition key), copying vectors forward as-is. */
function downgradeToLegacyVecTable(store: MemoryStore, dim: number): void {
	const oldRows = store.sqlite
		.prepare("SELECT id, embedding FROM nodix_memory_chunk_vectors")
		.all() as Array<{ id: string; embedding: Buffer }>;
	store.sqlite.exec("DROP TABLE nodix_memory_chunk_vectors");
	store.sqlite.exec(
		`CREATE VIRTUAL TABLE nodix_memory_chunk_vectors USING vec0(id TEXT PRIMARY KEY, embedding float[${dim}])`,
	);
	const insert = store.sqlite.prepare("INSERT INTO nodix_memory_chunk_vectors(id, embedding) VALUES (?, ?)");
	for (const row of oldRows) insert.run(row.id, row.embedding);
}

describe("vec0 project_id partition key (fail-closed, no in-place migration)", () => {
	let fixture: Fixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("recreates an empty pre-Phase-D table with the partition key on next boot", async () => {
		fixture = buildFixture();
		const { dbPath } = fixture;

		let store = new MemoryStore({ dbPath, embedder: testEmbedder });
		downgradeToLegacyVecTable(store, testEmbedder.dimensions);
		expect(readChunkVecTableState(store.sqlite)?.hasPartitionKey).toBe(false);
		store.close();

		store = new MemoryStore({ dbPath, embedder: testEmbedder });
		const state = readChunkVecTableState(store.sqlite);
		expect(state?.hasPartitionKey).toBe(true);
		expect(state?.rowCount).toBe(0);
		store.close();
	});

	it("fails closed on next boot when a non-empty pre-Phase-D table has rows to lose", async () => {
		fixture = buildFixture();
		const { dbPath } = fixture;

		let store = new MemoryStore({ dbPath, embedder: testEmbedder });
		await store.store({
			text: "Kubernetes pod eviction is triggered by memory pressure on the node.",
			category: "episodic",
			projectId: "proj-alpha",
		});
		downgradeToLegacyVecTable(store, testEmbedder.dimensions);
		const downgradedState = readChunkVecTableState(store.sqlite);
		expect(downgradedState?.hasPartitionKey).toBe(false);
		expect(downgradedState?.rowCount).toBe(1);
		store.close();

		expect(() => new MemoryStore({ dbPath, embedder: testEmbedder })).toThrow(
			/does not match the current schema/,
		);
	});
});
