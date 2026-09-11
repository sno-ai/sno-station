/**
 * Fresh-database acceptance for the Nodix SQLite namespace.
 * Uses the real encrypted database, FTS5 extension, and sqlite-vec extension.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../../../../packages/sno-station-mem/src/store/connection";
import { initSqliteRuntimeSync, type SqliteDatabaseLike } from "../../../../packages/sno-station-mem/src/store/sqlite-runtime";

const VECTOR_DIM = 3;

const NODIX_TABLES = [
	"nodix_active_task_evidence",
	"nodix_active_task_instances",
	"nodix_active_task_migration_evidence",
	"nodix_active_task_migration_manifests",
	"nodix_active_task_revisions",
	"nodix_active_task_transitions",
	"nodix_memories",
	"nodix_memory_chunk_vectors",
	"nodix_memory_chunks",
	"nodix_memory_chunks_fts",
	"nodix_memory_extraction_timestamps",
	"nodix_profile_recovery_entries",
	"nodix_provider_agent_mappings",
	"nodix_provider_project_agents",
	"nodix_provider_project_mappings",
	"nodix_task_lifecycle_commands",
	"nodix_unplaced_memory_candidates",
] as const;

function vectorBytes(values: readonly number[]): Uint8Array {
	return new Uint8Array(new Float32Array(values).buffer);
}

function insertMemoryAndChunk(database: SqliteDatabaseLike): void {
	const now = 1_700_000_000_000;
	database
		.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id
			) VALUES (?, ?, 'episodic', ?, 0.8, ?, 'UTC', '{}', ?, ?)`,
		)
		.run("memory-1", "Nodix stores agent memory at the edge.", "project-1", now, "hash-1", "fact-1");
	database
		.prepare(
			`INSERT INTO nodix_memory_chunks(
				chunk_id, memory_id, chunk_index, chunk_text, dense_payload, summary, entities, tags,
				source, start_offset, end_offset, token_count, content_type, chunking_version,
				embedder_provider, embedder_model, embedder_dim, created_at, updated_at, facet
			) VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, 0, ?, 8, 'prose', 'test-v1',
				'test', 'test-3d', ?, ?, ?, 'current')`,
		)
		.run(
			"chunk-1",
			"memory-1",
			"Nodix stores agent memory at the edge.",
			"Nodix stores agent memory at the edge.",
			42,
			VECTOR_DIM,
			now,
			now,
		);
	database
		.prepare(
			"INSERT INTO nodix_memory_chunk_vectors(id, project_id, embedding) VALUES (?, ?, vec_f32(?))",
		)
		.run("chunk-1", "project-1", vectorBytes([1, 0, 0]));
}

describe("Nodix SQLite schema cutover", () => {
	let temporaryDirectory: string;
	let databasePath: string;

	beforeEach(() => {
		initSqliteRuntimeSync();
		temporaryDirectory = mkdtempSync(join(tmpdir(), "nodix-schema-cutover-"));
		databasePath = join(temporaryDirectory, "memory.sqlite");
	});

	afterEach(() => {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it("creates the complete fresh schema without an OpenClaw database name", () => {
		const database = initDb(databasePath, VECTOR_DIM);
		try {
			const objects = database.$client
				.prepare(
					"SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master ORDER BY type, name",
				)
				.all() as Array<{
				type: string;
				name: string;
				tableName: string;
				sql: string | null;
			}>;
			const serialized = JSON.stringify(objects).toLowerCase();
			expect(serialized).not.toContain("mem_claw");
			expect(serialized).not.toContain("vec_mem_claw");
			expect(serialized).not.toContain("nodix_simple_tokenizer_smoke");

			const tableNames = objects
				.filter(({ type }) => type === "table")
				.map(({ name }) => name);
			expect(tableNames).toEqual(expect.arrayContaining(NODIX_TABLES));
			expect(
				tableNames.filter(
					(name) =>
						!name.startsWith("nodix_") &&
						!name.startsWith("sqlite_") &&
						name !== "__drizzle_migrations" &&
						name !== "_sno_station_core_canary",
				),
			).toEqual([]);
			expect(database.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(database.$client.prepare("PRAGMA integrity_check").get()).toEqual({
				integrity_check: "ok",
			});
		} finally {
			closeDb(database);
		}
	});

	it("persists and searches memory through raw SQLite tables", () => {
		const database = initDb(databasePath, VECTOR_DIM);
		try {
			insertMemoryAndChunk(database.$client);

			expect(
				database.$client
					.prepare("SELECT text FROM nodix_memories WHERE id = ?")
					.get("memory-1"),
			).toEqual({ text: "Nodix stores agent memory at the edge." });
			expect(
				database.$client
					.prepare(
						`SELECT c.chunk_id AS id
						 FROM nodix_memory_chunks_fts f
						 JOIN nodix_memory_chunks c ON c.rowid = f.rowid
						 WHERE nodix_memory_chunks_fts MATCH ?`,
					)
					.all("agent memory"),
			).toEqual([{ id: "chunk-1" }]);
			expect(
				database.$client
					.prepare(
						"SELECT id FROM nodix_memory_chunk_vectors WHERE embedding MATCH vec_f32(?) AND project_id = ? AND k = 1",
					)
					.all(vectorBytes([1, 0, 0]), "project-1"),
			).toEqual([{ id: "chunk-1" }]);

			database.$client
				.prepare("UPDATE nodix_memories SET text = ?, content_hash = ? WHERE id = ?")
				.run("Nodix keeps updated agent memory at the edge.", "hash-2", "memory-1");
			expect(
				database.$client
					.prepare("SELECT text FROM nodix_rem_memory_facets WHERE memory_id = ? AND facet = 'current'")
					.get("memory-1"),
			).toEqual({ text: "Nodix keeps updated agent memory at the edge." });

			database.$client.prepare("DELETE FROM nodix_memory_chunk_vectors WHERE id = ?").run("chunk-1");
			database.$client.prepare("DELETE FROM nodix_memories WHERE id = ?").run("memory-1");
			expect(
				database.$client.prepare("SELECT id FROM nodix_memories WHERE id = ?").get("memory-1"),
			).toBeUndefined();
			expect(
				database.$client
					.prepare("SELECT chunk_id FROM nodix_memory_chunks WHERE memory_id = ?")
					.all("memory-1"),
			).toEqual([]);
		} finally {
			closeDb(database);
		}
	});
});
