import { describe, expect, test } from "vitest";
import { parseInsightMetadata } from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";
import {
	MEMORY_KINDS_FOUNDATION_MARKER,
	runMemoryKindsCutoverMigration,
} from "../../../../packages/memory/src/store/memory-kinds-cutover-migrator.ts";
import type { MemoryCategory } from "../../../../packages/memory/src/engine/shared/types.ts";
import { openSqliteDatabase } from "../../../../packages/memory/src/store/sqlite-runtime.ts";
import { createTestDb, type TestSqliteDatabase } from "../helpers/test-db.ts";
import { assertLiveAgentE2EEnabled, numberEnv } from "./helpers/config";

const SCOPE = "phase96-offline-cutover-migrator";
const TIMESTAMP = Date.parse("2026-06-13T10:00:00.000Z");
const FOUNDATION_CATEGORIES = new Set<string>([
	"episodic",
	"lesson",
	"persona",
	"profile",
	"summary",
]);

assertLiveAgentE2EEnabled();

describe("Agent 1:1 phase 96 offline cutover migrator", () => {
	test(
		"rewrites a real pre-cutover SQLite store to five-kind foundation rows",
		() => {
			const testDb = createTestDb();
			try {
				insertLegacyRow(testDb.sqlite, {
					category: "identity",
					id: "phase96-identity",
					metadata: { memory_category: "identity" },
					text: "The user lives in Portland.",
				});
				insertLegacyRow(testDb.sqlite, {
					category: "preference",
					id: "phase96-preference",
					metadata: { memory_category: "preference", topic: "editor" },
					text: "The user prefers Zed for quick eval edits.",
				});
				insertLegacyRow(testDb.sqlite, {
					category: "entity",
					id: "phase96-entity",
					metadata: { entity_id: "project-atlas", memory_category: "entity" },
					text: "Project Atlas is the current launch project.",
				});
				insertLegacyRow(testDb.sqlite, {
					category: "event",
					id: "phase96-event",
					metadata: {
						event_at: "2026-06-13T10:00:00.000Z",
						memory_category: "event",
					},
					text: "The user finished the archive preflight on June 13.",
				});
				testDb.sqlite.close();

				const result = runMemoryKindsCutoverMigration({
					dbPath: testDb.dbPath,
					now: TIMESTAMP,
				});
				expect(result).toMatchObject({
					checkedRows: 4,
					rewrittenRows: 4,
					status: "migrated",
				});

				const handle = openSqliteDatabase(testDb.dbPath);
				try {
					const rows = handle.db
						.prepare(
							"SELECT id, text, category, timestamp, metadata FROM nodix_memories ORDER BY id ASC",
						)
						.all() as Array<{
						category: string;
						id: string;
						metadata: string;
						text: string;
						timestamp: number;
					}>;
					const byId = new Map(rows.map((row) => [row.id, row]));
					expect(new Set(rows.map((row) => row.category))).toEqual(
						new Set(["episodic", "profile"]),
					);
					expect(
						handle.db
							.prepare("SELECT name FROM nodix_memory_migration_markers WHERE name = ?")
							.get(MEMORY_KINDS_FOUNDATION_MARKER),
					).toBeTruthy();

					const identity = requireRow(byId, "phase96-identity");
					expect(identity.category).toBe("profile");
					expect(parseRowMetadata(identity).section_name).toBe("identity");

					const preference = requireRow(byId, "phase96-preference");
					expect(preference.category).toBe("profile");
					expect(parseRowMetadata(preference).section_name).toBe("preferences.editor");

					const entity = requireRow(byId, "phase96-entity");
					expect(entity.category).toBe("profile");
					expect(parseRowMetadata(entity).section_name).toBe("entities.project-atlas");

					const event = requireRow(byId, "phase96-event");
					expect(event.category).toBe("episodic");
					expect(parseRowMetadata(event).event_at).toBe("2026-06-13T10:00:00.000Z");
				} finally {
					handle.db.close();
				}
			} finally {
				testDb.cleanup();
			}
		},
		numberEnv("SNO_AGENT_E2E_PHASE_TIMEOUT_MS", 120_000),
	);
});

function insertLegacyRow(
	sqlite: TestSqliteDatabase,
	input: {
		category: string;
		id: string;
		metadata: Record<string, unknown>;
		text: string;
	},
): void {
	sqlite
		.prepare(
			"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, metadata, content_hash, fact_id, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UTC')",
		)
		.run(
			input.id,
			input.text,
			input.category,
			SCOPE,
			0.7,
			TIMESTAMP,
			JSON.stringify(input.metadata),
			`legacy-hash-${input.id}`,
			`legacy-fact-${input.id}`,
		);
}

function requireRow<T>(rows: Map<string, T>, id: string): T {
	const row = rows.get(id);
	if (!row) throw new Error(`missing row ${id}`);
	return row;
}

function parseRowMetadata(row: {
	category: string;
	metadata: string;
	text: string;
	timestamp: number;
}) {
	if (!isMemoryCategory(row.category)) {
		throw new Error(`unexpected migrated category: ${row.category}`);
	}
	return parseInsightMetadata(row.metadata, {
		category: row.category,
		text: row.text,
		timestamp: row.timestamp,
	});
}

function isMemoryCategory(value: string): value is MemoryCategory {
	return FOUNDATION_CATEGORIES.has(value);
}
