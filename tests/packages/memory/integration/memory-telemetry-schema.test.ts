import { readFileSync } from "node:fs";
import { join } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

interface TableInfoRow {
	name: string;
	notnull: 0 | 1;
}

interface IndexRow {
	name: string;
}

interface SqlRow {
	sql: string | null;
}

function tableInfo(testDb: TestDb, tableName: string): Map<string, TableInfoRow> {
	const rows = testDb.sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
	return new Map(rows.map((row) => [row.name, row]));
}

function indexNames(testDb: TestDb, tableName: string): string[] {
	const rows = testDb.sqlite.prepare(`PRAGMA index_list(${tableName})`).all() as IndexRow[];
	return rows.map((row) => row.name);
}

function schemaSql(testDb: TestDb, objectName: string): string {
	const row = testDb.sqlite
		.prepare("SELECT sql FROM sqlite_master WHERE name = ?")
		.get(objectName) as SqlRow | undefined;
	return row?.sql ?? "";
}

function runMigration(sqlite: DatabaseConstructor.Database, sql: string): void {
	for (const statement of sql.split("--> statement-breakpoint")) {
		const trimmed = statement.trim();
		if (trimmed) sqlite.exec(trimmed);
	}
}

describe("memory telemetry schema", () => {
	let testDb: TestDb | undefined;

	afterEach(() => {
		testDb?.cleanup();
		testDb = undefined;
	});

	function openDb(): TestDb {
		testDb = createTestDb();
		return testDb;
	}

	it("creates the PRD nodix_memory_events table, indexes, and append-only triggers", () => {
		const db = openDb();
		const columns = tableInfo(db, "nodix_memory_events");

		expect([...columns.keys()]).toEqual([
			"id",
			"event_type",
			"fact_id",
			"memory_kind",
			"timestamp_ms",
			"session_uuid",
			"turn_id",
			"agent_id",
			"project_id",
			"tenant_id",
			"source_event_id",
			"derived_from",
			"consolidation_epoch_id",
			"content_hash",
			"receipt_hmac",
			"key_version",
			"retrieval_rank",
			"retrieval_score",
			"query_tenant_id",
			"result_tenant_id",
			"metadata_json",
		]);
		expect(columns.get("event_type")?.notnull).toBe(1);
		expect(columns.get("timestamp_ms")?.notnull).toBe(1);
		expect(columns.get("agent_id")?.notnull).toBe(1);
		expect(columns.get("tenant_id")?.notnull).toBe(0);
		expect(columns.get("query_tenant_id")?.notnull).toBe(0);
		expect(columns.get("result_tenant_id")?.notnull).toBe(0);

		// Migration 0011 trims write-amplifying indexes (type/session/tenant/kind are
		// unqueried or covered elsewhere) and adds the retention-shaped partial index.
		const eventIndexes = indexNames(db, "nodix_memory_events");
		expect(eventIndexes).toEqual(
			expect.arrayContaining(["nodix_idx_memory_events_fact", "nodix_idx_memory_events_epoch", "nodix_idx_memory_events_project", "nodix_idx_memory_events_turn", "nodix_idx_memory_events_usage_retention"]),
		);
		expect(eventIndexes).not.toEqual(
			expect.arrayContaining(["nodix_idx_memory_events_type", "nodix_idx_memory_events_session", "nodix_idx_memory_events_tenant", "nodix_idx_memory_events_kind"]),
		);

		expect(schemaSql(db, "memory_events_no_update")).toContain("nodix_memory_events is append-only");
		expect(schemaSql(db, "memory_events_lifecycle_delete_guard")).toContain(
			"nodix_memory_events lifecycle rows are append-only",
		);
	});

	it("enforces the closed event enum, fact id rule, and epoch exception", () => {
		const db = openDb();
		const insertEvent = db.sqlite.prepare(
			`INSERT INTO nodix_memory_events(event_type, fact_id, timestamp_ms, agent_id)
			 VALUES (?, ?, ?, ?)`,
		);

		expect(() => insertEvent.run("write", "fact-1", 1_700_000_000_000, "agent-a")).toThrow();
		expect(() => insertEvent.run("forget", "fact-1", 1_700_000_000_000, "agent-a")).toThrow();
		expect(() => insertEvent.run("evict", "fact-1", 1_700_000_000_000, "agent-a")).toThrow();
		expect(() => insertEvent.run("unknown", "fact-1", 1_700_000_000_000, "agent-a")).toThrow();
		expect(() => insertEvent.run("create", null, 1_700_000_000_000, "agent-a")).toThrow();
		expect(() => insertEvent.run("epoch_boundary", null, 1_700_000_000_000, "agent-a")).not.toThrow();
	});

	it("keeps lifecycle events append-only while usage events stay deletable", () => {
		const db = openDb();
		const insert = db.sqlite.prepare(
			`INSERT INTO nodix_memory_events(event_type, fact_id, timestamp_ms, agent_id)
			 VALUES (?, ?, 1700000000000, 'agent-a')`,
		);
		const deleteByFact = db.sqlite.prepare("DELETE FROM nodix_memory_events WHERE fact_id = ?");

		insert.run("create", "fact-1");
		expect(() =>
			db.sqlite.prepare("UPDATE nodix_memory_events SET event_type = 'delete' WHERE fact_id = ?").run("fact-1"),
		).toThrow(/append-only/);

		// The guarded trigger from migration 0011 blocks every lifecycle event type at
		// the database level; only 'recall'/'inject' usage rows are deletable (retention).
		for (const lifecycleType of ["update", "supersede", "delete", "purge"]) {
			insert.run(lifecycleType, `fact-${lifecycleType}`);
			expect(() => deleteByFact.run(`fact-${lifecycleType}`)).toThrow(/append-only/);
		}
		expect(() => deleteByFact.run("fact-1")).toThrow(/append-only/);

		for (const usageType of ["recall", "inject"]) {
			insert.run(usageType, `fact-${usageType}`);
			expect(deleteByFact.run(`fact-${usageType}`).changes).toBe(1);
		}
	});

	it("adds fact identity columns and rejects future null fact ids", () => {
		const db = openDb();
		const columns = tableInfo(db, "nodix_memories");

		expect([...columns.keys()]).toEqual(
			expect.arrayContaining(["fact_id", "derived_from", "consolidation_epoch_id", "confidence_source"]),
		);

		db.sqlite
			.prepare(
				`INSERT INTO nodix_memories
				 (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id)
				 VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?)`,
			)
			.run(
				"memory-1",
				"schema test memory",
				"lesson",
				"global",
				0.7,
				1_700_000_000_000,
				"{}",
				"hash-1",
				"fact-1",
			);
		const factRow = db.sqlite
			.prepare("SELECT fact_id FROM nodix_memories WHERE id = ?")
			.get("memory-1") as { fact_id: string };
		expect(factRow.fact_id).toBe("fact-1");

		expect(() =>
			db.sqlite
				.prepare(
					`INSERT INTO nodix_memories
					 (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash)
					 VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?)`,
				)
				.run("memory-2", "bad fact id", "lesson", "global", 0.7, 1_700_000_000_001, "{}", "hash-2"),
		).toThrow(/fact_id/);
		expect(() =>
			db.sqlite.prepare("UPDATE nodix_memories SET fact_id = NULL WHERE id = ?").run("memory-1"),
		).toThrow(/fact_id/);
	});

	it("backfills existing rows when the migration runs on an old database", () => {
		const sqlite = new DatabaseConstructor(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE nodix_memories (
					id TEXT PRIMARY KEY,
					text TEXT NOT NULL,
					category TEXT NOT NULL,
					project_id TEXT NOT NULL DEFAULT 'global',
					importance REAL NOT NULL DEFAULT 0.7,
					timestamp INTEGER NOT NULL,
					metadata TEXT DEFAULT '{}',
					content_hash TEXT NOT NULL
				);
				INSERT INTO nodix_memories
				(id, text, category, project_id, importance, timestamp, metadata, content_hash)
				VALUES ('legacy-1', 'old text', 'lesson', 'global', 0.7, 1700000000000, '{}', 'hash-legacy');
			`);

			const sql = readFileSync(join(process.cwd(), "drizzle/0009_memory_telemetry.sql"), "utf8");
			runMigration(sqlite, sql);

			const row = sqlite
				.prepare("SELECT fact_id, derived_from, consolidation_epoch_id, confidence_source FROM nodix_memories")
				.get() as {
				fact_id: string;
				derived_from: string | null;
				consolidation_epoch_id: string | null;
				confidence_source: string | null;
			};
			expect(row).toEqual({
				fact_id: "legacy-1",
				derived_from: null,
				consolidation_epoch_id: null,
				confidence_source: null,
			});
			const nullCount = sqlite
				.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE fact_id IS NULL")
				.get() as { count: number };
			expect(nullCount.count).toBe(0);
		} finally {
			sqlite.close();
		}
	});

	it("creates helper tables with bounded states and nullable tenant fields", () => {
		const db = openDb();

		expect([...tableInfo(db, "nodix_memory_usage_outbox").keys()]).toEqual([
			"id",
			"event_type",
			"payload_json",
			"accepted_at_ms",
			"status",
			"attempt_count",
			"last_error",
			"next_attempt_ms",
		]);
		expect([...tableInfo(db, "nodix_memory_telemetry_incidents").keys()]).toEqual([
			"id",
			"incident_type",
			"severity",
			"message",
			"payload_json",
			"created_at_ms",
		]);
		expect([...tableInfo(db, "nodix_memory_telemetry_sync_state").keys()]).toEqual([
			"sink",
			"last_event_id",
			"updated_at_ms",
		]);

		const insertOutbox = db.sqlite.prepare(
			`INSERT INTO nodix_memory_usage_outbox(event_type, payload_json, accepted_at_ms, status)
			 VALUES (?, ?, ?, ?)`,
			);
			expect(() => insertOutbox.run("recall", "{}", 1_700_000_000_000, "pending")).not.toThrow();
			expect(() => insertOutbox.run("inject", "{}", 1_700_000_000_001, "failed")).not.toThrow();
			expect(() => insertOutbox.run("recall", "{}", 1_700_000_000_002, "flushing")).not.toThrow();
			expect(() => insertOutbox.run("recall", "{}", 1_700_000_000_003, "quarantined")).not.toThrow();
			expect(() => insertOutbox.run("recall", "{}", 1_700_000_000_004, "claimed")).toThrow();
		});
	});
