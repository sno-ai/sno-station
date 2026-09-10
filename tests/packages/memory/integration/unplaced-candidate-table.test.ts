/**
 * Slice-1 freeze contract for the deprecated unplaced-candidate path.
 * Real encrypted SQLite, no mocked storage.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../../apps/mem-claw/src/storage/migrations.ts";
import { openSqliteDatabase } from "../../../../apps/mem-claw/src/storage/sqlite-runtime.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";

let embedder: Awaited<ReturnType<typeof createTestEmbedder>> | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterAll(() => {
	embedder?.dispose?.();
});

interface Fixture {
	store: MemoryStore;
	testDb: TestDb;
}

const SCOPE = "unplaced-candidate-freeze";

describe("unplaced candidate freeze", () => {
	let fixture: Fixture | undefined;

	beforeEach(() => {
		if (!embedder) throw new Error("embedder not initialised");
		const testDb = createTestDb();
		fixture = { store: new MemoryStore({ dbPath: testDb.dbPath, embedder }), testDb };
	});

	afterEach(() => {
		fixture?.store.close();
		fixture?.testDb.cleanup();
		fixture = undefined;
	});

	function store(): MemoryStore {
		if (!fixture) throw new Error("fixture not initialised");
		return fixture.store;
	}

	it("rejects direct non-active memory writes without pointing at another writer", async () => {
		await expect(
			store().store({
				text: "The user only reads tragedy now.",
				category: "profile",
				projectId: SCOPE,
				vector: new Float32Array(),
				importance: 0.85,
				timestamp: Date.now(),
				metadata: "{}",
				lane: "quarantined",
				rawCandidateJson: "{}",
				dispositionReason: "some_reason",
				dispositionedAt: Date.now(),
			}),
		).rejects.toThrow(/accepts only the active memory table/);
	});

	it("freezes the unplaced writer while retaining the historical reader", () => {
		expect(() =>
			store().recordUnplacedCandidate({
				projectId: SCOPE,
				category: "profile",
				text: "The user only reads tragedy now.",
				rawCandidateJson: '{"source":"test"}',
				dispositionReason: "profile_missing_section_name",
				dispositionedAtMs: 1_700_000_000_000,
			}),
		).toThrow(/recordUnplacedCandidate\(\) is frozen/);
		expect(store().listUnplacedCandidates({ projectId: SCOPE })).toEqual([]);
	});

	it("reads historical unplaced rows without creating or moving them", () => {
		if (!fixture) throw new Error("fixture not initialised");
		fixture.testDb.sqlite
			.prepare(
				"INSERT INTO nodix_unplaced_memory_candidates (id, project_id, category, text, raw_candidate_json, disposition_reason, dispositioned_at_ms, session_key, dedupe_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"historical-unplaced",
				SCOPE,
				"profile",
				"Historical rejected candidate.",
				'{"source":"historical"}',
				"subject_not_user",
				1_700_000_000_000,
				"historical-session",
				"historical-dedupe",
			);

		expect(store().listUnplacedCandidates({ projectId: SCOPE })).toEqual([
			{
				id: "historical-unplaced",
				projectId: SCOPE,
				category: "profile",
				text: "Historical rejected candidate.",
				rawCandidateJson: '{"source":"historical"}',
				dispositionReason: "subject_not_user",
				dispositionedAtMs: 1_700_000_000_000,
				sessionKey: "historical-session",
			},
		]);
	});

	it("moves legacy non-active memory rows during migration startup", () => {
		if (!fixture) throw new Error("fixture not initialised");
		const marker = "legacy-row-must-not-move";
		const migrationDbPath = fixture.testDb.dbPath.replace(/test\.sqlite$/, "migration.sqlite");
		runMigrations(migrationDbPath);
		const migrationDb = openSqliteDatabase(migrationDbPath);
		migrationDb.db
			.prepare(
				"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"legacy-non-active",
				marker,
				"profile",
				SCOPE,
				0.85,
				1_700_000_000_000,
				"{}",
				"legacy-hash",
				"legacy-fact",
				"quarantined",
				JSON.stringify({ marker }),
				"subject_not_user",
				1_700_000_000_000,
			);
		migrationDb.db.close();

		if (!embedder) throw new Error("embedder not initialised");
		const migratedStore = new MemoryStore({ dbPath: migrationDbPath, embedder });
		migratedStore.close();
		const reopened = openSqliteDatabase(migrationDbPath);

		expect(
			reopened.db
				.prepare("SELECT lane FROM nodix_memories WHERE id = ?")
				.get("legacy-non-active"),
		).toBeUndefined();
		expect(
			reopened.db
				.prepare("SELECT COUNT(*) AS n FROM nodix_unplaced_memory_candidates")
				.get(),
		).toEqual({ n: 1 });
		reopened.db.close();
	});

	it("rejects a non-active lane at every create entry point", async () => {
		const create = {
			text: "The user only reads tragedy now.",
			category: "episodic" as const,
			projectId: SCOPE,
			vector: new Float32Array(),
			metadata: "{}",
			lane: "quarantined" as const,
			rawCandidateJson: "{}",
			dispositionReason: "some_reason",
			dispositionedAt: 1_700_000_000_000,
		};

		await expect(store().supersede({ create, closes: [] })).rejects.toThrow(
			/accepts only the active memory table/,
		);
		await expect(
			store().createEventAndSupersede({
				event: create,
				replacement: create,
				closeExisting: [],
			}),
		).rejects.toThrow(/accepts only the active memory table/);
		await expect(
			store().createMergeWithRawLineage({
				rawSource: create,
				merged: create,
				closeExisting: [],
				buildRawSourceMetadata: () => "{}",
			}),
		).rejects.toThrow(/accepts only the active memory table/);
		expect(await store().list({ projectId: SCOPE, limit: 20 })).toEqual([]);
	});
});
