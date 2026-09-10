/** Real encrypted SQLite. No mocks. Missing crypto/storage deps = FAIL. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { parseInsightMetadata } from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";
import {
	getAuditPath,
	getMemClawStateDir,
} from "../../../../apps/mem-claw/src/operations/runtime-audit-log.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import {
	assertMemoryKindsCutoverStartupGuard,
	MEMORY_KINDS_FOUNDATION_MARKER,
	resetMemoryKindsCutoverDatabase,
	runMemoryKindsCutoverMigration,
} from "../../../../apps/mem-claw/src/storage/memory-kinds-cutover-migrator.ts";
import {
	openSqliteDatabase,
} from "../../../../apps/mem-claw/src/storage/sqlite-runtime.ts";
import { createTestDb, createTestEmbedder, type TestSqliteDatabase } from "../helpers/test-db.ts";

const SCOPE = "memory-kinds-cutover";
const BASE_TS = Date.UTC(2026, 4, 25, 9, 0, 0);

let testEmbedder: Embedder;
let auditStateRoot: string;
const previousStateDir = process.env.OPENCLAW_STATE_DIR;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

beforeEach(() => {
	auditStateRoot = mkdtempSync(join(tmpdir(), "memory-kinds-cutover-audit-"));
	process.env.OPENCLAW_STATE_DIR = auditStateRoot;
});

afterEach(() => {
	rmSync(auditStateRoot, { recursive: true, force: true });
	if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
	else process.env.OPENCLAW_STATE_DIR = previousStateDir;
});

function completedAuditOperations(): string[] {
	return completedAuditRecords().map((record) => String(record.details?.["operation"]));
}

function completedAuditRecords(): Array<{ details?: Record<string, unknown> }> {
	return readFileSync(getAuditPath(getMemClawStateDir()), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { details?: Record<string, unknown> })
		.filter((record) => record.details?.["audit_phase"] === "completed");
}

function insertLegacyRow(
	sqlite: TestSqliteDatabase,
	input: {
		id: string;
		text: string;
		category: string;
		metadata?: Record<string, unknown>;
		timestamp?: number;
	},
): void {
	const timestamp = input.timestamp ?? BASE_TS;
	sqlite
		.prepare(
			"INSERT INTO nodix_memories (id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, 'UTC', ?, ?)",
		)
		.run(
			input.id,
			input.id,
			input.text,
			input.category,
			SCOPE,
			0.7,
			timestamp,
			JSON.stringify(input.metadata ?? { memory_category: input.category }),
			`legacy-hash-${input.id}`,
		);
}

function queryRows(dbPath: string): {
	handle: ReturnType<typeof openSqliteDatabase>;
	rows: Array<{ id: string; text: string; category: string; timestamp: number; metadata: string }>;
} {
	const handle = openSqliteDatabase(dbPath);
	const rows = handle.db
		.prepare(
			"SELECT id, text, category, timestamp, metadata FROM nodix_memories ORDER BY id ASC",
		)
		.all() as Array<{ id: string; text: string; category: string; timestamp: number; metadata: string }>;
	return { handle, rows };
}

describe("memory-kinds offline cutover migrator", () => {
	it("rewrites old rows to foundation kinds with required metadata defaults", () => {
		const testDb = createTestDb();
		try {
			insertLegacyRow(testDb.sqlite, {
				id: "entity-durable",
				text: "Entity: Project Glacier is the customer's launch project.",
				category: "entity",
				metadata: {
					memory_category: "entity",
					entity_id: "project-glacier",
					entity_kind: "project",
					source: "legacy",
				},
			});
			insertLegacyRow(testDb.sqlite, {
				id: "entity-one-off",
				text: "Entity note: the blue notebook was on the desk once.",
				category: "entity",
				metadata: {
					memory_category: "entity",
					entity_kind: "object",
					source: "legacy",
				},
			});
			insertLegacyRow(testDb.sqlite, {
				id: "event-row",
				text: "The user visited Seattle on May 25.",
				category: "event",
				metadata: { memory_category: "event", event_at: "2026-05-25T09:00:00.000Z" },
			});
			insertLegacyRow(testDb.sqlite, {
				id: "identity-row",
				text: "The user lives in Seattle.",
				category: "identity",
				metadata: {
					memory_category: "identity",
					confidence: 0.9,
					last_accessed_at: BASE_TS + 90_000_000,
					source: "legacy",
				},
			});
			insertLegacyRow(testDb.sqlite, {
				id: "lesson-row",
				text: "Lesson: verify the working directory before file edits.",
				category: "lesson",
				metadata: {
					memory_category: "lesson",
					anti_pattern_signature: "check-working-directory",
				},
			});
			insertLegacyRow(testDb.sqlite, {
				id: "preference-row",
				text: "The user prefers quiet hotels.",
				category: "preference",
				metadata: {
					memory_category: "preference",
					topic: "travel",
					fact_key: "preference:travel",
				},
			});
			testDb.sqlite.close();

			const result = runMemoryKindsCutoverMigration({ dbPath: testDb.dbPath });
			expect(result.status).toBe("migrated");
			expect(result.rewrittenRows).toBe(6);
			expect(completedAuditOperations()).toContain("runMemoryKindsCutoverMigration");

			const { handle, rows } = queryRows(testDb.dbPath);
			try {
				expect(new Set(rows.map((row) => row.category))).toEqual(
					new Set(["episodic", "lesson", "profile"]),
				);
				const byId = new Map(rows.map((row) => [row.id, row]));

				const identity = parseInsightMetadata(byId.get("identity-row")?.metadata, {
					category: "profile",
					text: byId.get("identity-row")?.text,
					timestamp: byId.get("identity-row")?.timestamp,
				});
				expect(identity.kind).toBe("profile");
				expect(identity.section_name).toBe("identity");
				expect(identity.asserted_at).toBe(BASE_TS);
				expect(identity.last_accessed_at).toBe(BASE_TS);
				expect(identity.source).toBe("ambient-learning");
				expect(identity.migrated_from_source).toBe("legacy");
				expect(identity.injected_count).toBe(0);
				expect(identity.bad_recall_count).toBe(0);
				expect(identity.suppressed_until_turn).toBe(0);
				expect(identity.state).toBe("confirmed");
				expect(identity.memory_layer).toBe("durable");
				expect(identity.tier).toBe("core");

				const preference = parseInsightMetadata(byId.get("preference-row")?.metadata, {
					category: "profile",
					text: byId.get("preference-row")?.text,
					timestamp: byId.get("preference-row")?.timestamp,
				});
				expect(preference.section_name).toBe("preferences.travel");
				expect(preference.fact_key).toBe("profile:preferences.travel");

				const durableEntity = parseInsightMetadata(byId.get("entity-durable")?.metadata, {
					category: "profile",
					text: byId.get("entity-durable")?.text,
					timestamp: byId.get("entity-durable")?.timestamp,
				});
				expect(durableEntity.section_name).toBe("entities.project-glacier");

				const oneOffEntity = parseInsightMetadata(byId.get("entity-one-off")?.metadata, {
					category: "episodic",
					text: byId.get("entity-one-off")?.text,
					timestamp: byId.get("entity-one-off")?.timestamp,
				});
				expect(oneOffEntity.kind).toBe("episodic");
				expect(oneOffEntity.entity_kind).toBe("object");

				const event = parseInsightMetadata(byId.get("event-row")?.metadata, {
					category: "episodic",
					text: byId.get("event-row")?.text,
					timestamp: byId.get("event-row")?.timestamp,
				});
				expect(event.kind).toBe("episodic");
				expect(event.event_at).toBe("2026-05-25T09:00:00.000Z");

				const lesson = parseInsightMetadata(byId.get("lesson-row")?.metadata, {
					category: "lesson",
					text: byId.get("lesson-row")?.text,
					timestamp: byId.get("lesson-row")?.timestamp,
				});
				expect(lesson.anti_pattern_signature).toBe("check-working-directory");

				const marker = handle.db
					.prepare("SELECT name FROM nodix_memory_migration_markers WHERE name = ?")
					.get(MEMORY_KINDS_FOUNDATION_MARKER);
				expect(marker).toBeTruthy();
			} finally {
				handle.db.close();
			}
		} finally {
			testDb.cleanup();
		}
	});

	it("no-ops after marker commit; startup guard is marker-only while the offline migrator still detects drift", () => {
		const testDb = createTestDb();
		try {
			insertLegacyRow(testDb.sqlite, {
				id: "identity-row",
				text: "The user name is Morgan.",
				category: "identity",
			});
			testDb.sqlite.close();

			expect(runMemoryKindsCutoverMigration({ dbPath: testDb.dbPath }).status).toBe("migrated");
			expect(runMemoryKindsCutoverMigration({ dbPath: testDb.dbPath }).status).toBe("noop");

			const handle = openSqliteDatabase(testDb.dbPath);
			try {
				handle.db.prepare("UPDATE nodix_memories SET category = ? WHERE id = ?").run(
					"identity",
					"identity-row",
				);
				// DB-optimization Step 8: the per-boot guard no longer re-reads and
				// re-validates every row (linear boot cost). Marker presence is the
				// steady-state contract; runtime writes stay validated at write time.
				expect(() => assertMemoryKindsCutoverStartupGuard(handle.db)).not.toThrow();
			} finally {
				handle.db.close();
			}
			// Drift detection still exists where it is affordable: the offline
			// migrator's noop path re-validates every row and fails loudly.
			expect(() => runMemoryKindsCutoverMigration({ dbPath: testDb.dbPath })).toThrow(/identity/);
		} finally {
			testDb.cleanup();
		}
	});

	it("rejects unmigrated stores during MemoryStore startup before reads or writes", () => {
		const testDb = createTestDb();
		try {
			insertLegacyRow(testDb.sqlite, {
				id: "identity-row",
				text: "The user lives in Portland.",
				category: "identity",
			});
			testDb.sqlite.close();

			expect(
				() => new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder }),
			).toThrow(/offline migrator/);
		} finally {
			testDb.cleanup();
		}
	});

	it("rolls back on unmappable state and retries from original rows after repair", () => {
		const testDb = createTestDb();
		try {
			insertLegacyRow(testDb.sqlite, {
				id: "identity-row",
				text: "The user likes train travel.",
				category: "identity",
			});
			insertLegacyRow(testDb.sqlite, {
				id: "bad-row",
				text: "Unmappable row",
				category: "mystery",
				metadata: { memory_category: "mystery" },
			});
			testDb.sqlite.close();

			expect(() => runMemoryKindsCutoverMigration({ dbPath: testDb.dbPath })).toThrow(
				/bad-row/,
			);

			let handle = openSqliteDatabase(testDb.dbPath);
			try {
				const rows = handle.db
					.prepare("SELECT id, category, metadata FROM nodix_memories ORDER BY id")
					.all() as Array<{ id: string; category: string; metadata: string }>;
				expect(rows.map((row) => [row.id, row.category])).toEqual([
					["bad-row", "mystery"],
					["identity-row", "identity"],
				]);
				expect(
					handle.db
						.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
						.get("nodix_memory_migration_markers"),
				).toBeUndefined();
				handle.db
					.prepare(
						"UPDATE nodix_memories SET category = ?, metadata = ? WHERE id = ?",
					)
					.run(
						"event",
						JSON.stringify({ memory_category: "event", event_at: "2026-05-25T09:00:00.000Z" }),
						"bad-row",
					);
			} finally {
				handle.db.close();
			}

			expect(runMemoryKindsCutoverMigration({ dbPath: testDb.dbPath }).status).toBe("migrated");

			handle = openSqliteDatabase(testDb.dbPath);
			try {
				const rows = handle.db
					.prepare("SELECT id, category FROM nodix_memories ORDER BY id")
					.all() as Array<{ id: string; category: string }>;
				expect(rows).toEqual([
					{ id: "bad-row", category: "episodic" },
					{ id: "identity-row", category: "profile" },
				]);
			} finally {
				handle.db.close();
			}
		} finally {
			testDb.cleanup();
		}
	});

	it("logs destructive reset target before deleting database files", async () => {
		const testDb = createTestDb();
		const logs: Array<Record<string, unknown>> = [];
		try {
			insertLegacyRow(testDb.sqlite, {
				id: "identity-row",
				text: "The user lives in Denver.",
				category: "identity",
			});
			const dbPath = testDb.dbPath;
			testDb.sqlite.close();
			expect(existsSync(dbPath)).toBe(true);

			const result = resetMemoryKindsCutoverDatabase({
				dbPath,
				projectId: "operator-test",
				args: ["memory-kinds", "reset-db", "--confirm", "--force"],
				log: (record) => logs.push(record),
			});

			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				dbPath,
				projectId: "operator-test",
				args: ["memory-kinds", "reset-db", "--confirm", "--force"],
			});
			expect(typeof logs[0]?.timestamp).toBe("number");
			expect(result.removedFiles).toBeGreaterThanOrEqual(1);
			expect(existsSync(dbPath)).toBe(false);
			const retry = resetMemoryKindsCutoverDatabase({
				dbPath,
				projectId: "operator-test",
				args: ["memory-kinds", "reset-db", "--confirm", "--force"],
			});
			expect(retry.removedFiles).toBe(0);
			const resetAudits = completedAuditRecords().filter(
				(record) => record.details?.["operation"] === "resetMemoryKindsCutoverDatabase",
			);
			expect(resetAudits).toHaveLength(2);
			expect(resetAudits[0]?.details).toEqual(
				expect.objectContaining({
					outcome: "deleted",
					count: 1,
				}),
			);
			expect(resetAudits[1]?.details).toEqual(
				expect.objectContaining({
					outcome: "noop",
					count: 0,
					removed_files: 0,
				}),
			);

			const reopened = new MemoryStore({ dbPath, embedder: testEmbedder });
			try {
				await expect(reopened.list({ projectId: "operator-test" })).resolves.toEqual([]);
			} finally {
				await reopened.close();
			}
		} finally {
			testDb.cleanup();
		}
	});
});
