import { readFileSync } from "node:fs";
import { join } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { formatRelevantMemoriesContext } from "../../../../apps/mem-claw/src/extraction/capture-policy-detector.ts";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { f32ToBytes } from "../../../../apps/mem-claw/src/shared/utils.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";

function runMigration(sqlite: DatabaseConstructor.Database, sql: string): void {
	for (const statement of sql.split("--> statement-breakpoint")) {
		const trimmed = statement.trim();
		if (trimmed) sqlite.exec(trimmed);
	}
}

describe("B-profile lane persistence and retrieval exclusion", () => {
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;
	let embedder: Embedder;

	beforeAll(async () => {
		embedder = await createTestEmbedder();
	});

	afterEach(async () => {
		await store?.close();
		fixture?.cleanup();
	});

	it("backfills legacy rows as active and rejects unknown lane values", () => {
		const sqlite = new DatabaseConstructor(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE nodix_memories (
					id TEXT PRIMARY KEY,
					text TEXT NOT NULL,
					category TEXT NOT NULL,
					project_id TEXT NOT NULL,
					importance REAL NOT NULL DEFAULT 0.7,
					timestamp INTEGER NOT NULL,
					metadata TEXT DEFAULT '{}',
					content_hash TEXT NOT NULL
				);
				INSERT INTO nodix_memories
					(id, text, category, project_id, timestamp, content_hash)
				VALUES ('legacy-row', 'legacy taste', 'profile', 'legacy', 1, 'legacy-hash');
			`);
			const sql = readFileSync(join(process.cwd(), "drizzle/0012_b_profile_lanes.sql"), "utf8");
			runMigration(sqlite, sql);

			const row = sqlite
				.prepare(
					"SELECT lane, raw_candidate_json, disposition_reason, dispositioned_at_ms FROM nodix_memories WHERE id = 'legacy-row'",
				)
				.get();
			expect(row).toEqual({
				lane: "active",
				raw_candidate_json: null,
				disposition_reason: null,
				dispositioned_at_ms: null,
			});
			expect(() =>
				sqlite.prepare("UPDATE nodix_memories SET lane = 'unknown'").run(),
			).toThrow(/CHECK constraint/);
		} finally {
			sqlite.close();
		}
	});

	it("freezes rejected-candidate writes while active rows remain retrievable", async () => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const marker = "ultraviolet-harpsichord-taste";
		const metadata = stringifyInsightMetadata(
			buildInsightMetadata(
				{ text: marker, category: "profile", timestamp: 1_753_200_000_000 },
				{ section_name: "preferences.music" },
			),
		);

		await store.store({
			text: `${marker} active`,
			category: "profile",
			projectId: "lane-test",
			metadata,
			trusted: true,
		});
		for (const reason of ["entity_capability_parked", "subject_not_user"] as const) {
			expect(() =>
				store?.recordUnplacedCandidate({
					projectId: "lane-test",
					category: "profile",
					text: `${marker} ${reason}`,
					rawCandidateJson: JSON.stringify({ marker, reason }),
					dispositionReason: reason,
					dispositionedAtMs: 1_753_200_000_000,
				}),
			).toThrow(/recordUnplacedCandidate\(\) is frozen/);
		}
		expect(store.listUnplacedCandidates({ projectId: "lane-test" })).toEqual([]);
		for (const lane of ["parked", "quarantined"] as const) {
			expect(await store.list({ projectId: "lane-test", lane })).toEqual([]);
		}
		const search = await store.searchKeyword(marker, {
			projectIdFilter: ["lane-test"],
			category: "profile",
			limit: 10,
		});
		expect(search.map((result) => result.entry.text)).toEqual([`${marker} active`]);
		const profileRows = await store.list({ projectId: "lane-test", category: "profile" });
		expect(profileRows.map((entry) => entry.text)).toEqual([`${marker} active`]);
		const context = formatRelevantMemoriesContext(profileRows);
		expect(context).toContain(`${marker} active`);
		expect(context).not.toContain("entity_capability_parked");
		expect(context).not.toContain("subject_not_user");
	});

	it("lets an active profile row write without an unplaced side channel", async () => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const metadata = stringifyInsightMetadata(
			buildInsightMetadata(
				{ text: "music preference", category: "profile", timestamp: 1_753_200_000_000 },
				{ section_name: "preferences.music" },
			),
		);

		await expect(
			store.supersede({
				create: {
					text: "The user likes indie folk.",
					category: "profile",
					projectId: "lane-collision",
					metadata,
					trusted: true,
				},
				closes: [],
				activeFactGuard: {
					factKey: "profile:preferences.music",
					expectedId: null,
				},
			}),
		).resolves.toMatchObject({ lane: "active" });
		expect(await store.list({ projectId: "lane-collision" })).toHaveLength(1);
		expect(store.listUnplacedCandidates({ projectId: "lane-collision" })).toEqual([]);
	});

	it("widens unscoped semantic search until an active row survives lane filtering", async () => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const insert = (id: string, lane: "active" | "quarantined", offset: number) => {
			const chunkId = `${id}:chunk:0`;
			const now = 1_753_200_000_000;
			fixture?.sqlite
				.prepare(
					"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id, lane, raw_candidate_json, disposition_reason, dispositioned_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					id,
					"profile",
					"semantic-lane-test",
					0.7,
					now,
					"{}",
					`hash:${id}`,
					`fact:${id}`,
					lane,
					lane === "active" ? null : JSON.stringify({ id }),
					lane === "active" ? null : "subject_not_user",
					lane === "active" ? null : now,
				);
			fixture?.sqlite
				.prepare(
					"INSERT INTO nodix_memory_chunks (chunk_id, memory_id, chunk_index, chunk_text, dense_payload, summary, entities, tags, source, start_offset, end_offset, token_count, content_type, chunking_version, embedder_provider, embedder_model, embedder_dim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					chunkId,
					id,
					0,
					id,
					id,
					null,
					null,
					null,
					null,
					0,
					id.length,
					1,
					"prose",
					"test",
					"test",
					"test",
					1024,
					now,
					now,
				);
			const vector = new Float32Array(1024);
			vector[0] = 1;
			vector[1] = offset;
			fixture?.sqlite
				.prepare(
					"INSERT INTO nodix_memory_chunk_vectors(id, project_id, embedding) VALUES (?, ?, vec_f32(?))",
				)
				.run(chunkId, "semantic-lane-test", f32ToBytes(vector));
		};
		for (let index = 0; index < 70; index++) insert(`quarantined-${index}`, "quarantined", 0);
		insert("active-target", "active", 0.1);
		const query = new Float32Array(1024);
		query[0] = 1;

		const results = await store.searchChunksSemantic(query, { limit: 1, minScore: 0 });

		expect(results).toHaveLength(1);
		expect(results[0]?.parentMemoryId).toBe("active-target");
	});
});
