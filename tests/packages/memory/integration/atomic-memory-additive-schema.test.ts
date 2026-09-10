/** @file atomic-memory-additive-schema.test.ts
 * @purpose Proves the dark additive schema and its project wall on real encrypted SQLite.
 * @boundary Migration 0030 plus relation normalization and MemoryStore relation traversal.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, normalizeMemoryRelationPredicate } from "@/storage/store";
import {
	initSqliteRuntimeSync,
	openSqliteDatabase,
	type SqliteDatabaseLike,
	type SqliteRuntimeHandle,
} from "@/storage/sqlite-runtime";
import { createTestDb, createTestEmbedder } from "../helpers/test-db";

const MIGRATION_PATH = fileURLToPath(
	new URL("../../../../apps/mem-claw/drizzle/0030_atomic_memory_additive.sql", import.meta.url),
);
const RELATION_DICTIONARY_PATH = fileURLToPath(
	new URL("../../../../apps/mem-claw/config/relation-dictionary.json", import.meta.url),
);

const ADDITIVE_COLUMNS = [
	{ name: "subject", type: "TEXT" },
	{ name: "attribute", type: "TEXT" },
	{ name: "valid_from", type: "INTEGER" },
	{ name: "valid_until", type: "INTEGER" },
	{ name: "maturity", type: "TEXT" },
	{ name: "source", type: "TEXT" },
	{ name: "extractor_version", type: "TEXT" },
] as const;

const RATIFIED_PREDICATES = [
	"IS_A",
	"WORKS_ON",
	"NEEDS",
	"PREFERS",
	"FORBIDS",
	"USES",
	"DEPENDS_ON",
	"CAUSED",
	"FIXED_BY",
	"DECIDED",
	"SUPERSEDES",
	"GOVERNED_BY",
	"OWNED_BY",
	"MEMBER_OF",
	"LOCATED_AT",
	"HAS_SKILL",
	"INTERESTED_IN",
	"HAS_ACCOUNT",
	"HAS_OCCUPATION",
	"HAS_METRIC",
	"WORKS_AT",
	"ATTENDED",
] as const;

const MEMORY_SELECTOR_INDEXES = {
	nodix_idx_memories_project_subject_attribute: ["project_id", "subject", "attribute"],
	nodix_idx_memories_project_valid_time: ["project_id", "valid_from", "valid_until"],
	nodix_idx_memories_project_maturity: ["project_id", "maturity"],
	nodix_idx_memories_project_source: ["project_id", "source"],
	nodix_idx_memories_project_extractor_version: ["project_id", "extractor_version"],
	nodix_idx_memories_project_derived_from: ["project_id", "derived_from"],
	nodix_idx_memories_project_importance: ["project_id", "importance"],
} as const;

interface ColumnInfo {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

interface RelationDictionary {
	relation_count: number;
	relations: Array<{ type: string; ratified: boolean }>;
}

const INCUMBENT_SCHEMA = `
CREATE TABLE nodix_memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  project_id TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.7,
  timestamp INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  content_hash TEXT NOT NULL,
  fact_id TEXT,
  derived_from TEXT,
  consolidation_epoch_id TEXT,
  confidence_source TEXT,
  lane TEXT NOT NULL DEFAULT 'active' CHECK (lane IN ('active', 'parked', 'quarantined')),
  raw_candidate_json TEXT,
  disposition_reason TEXT,
  dispositioned_at_ms INTEGER
);
CREATE UNIQUE INDEX nodix_idx_memories_project_content_hash
ON nodix_memories(project_id, content_hash, category);
CREATE TRIGGER nodix_memories_fact_id_insert_guard
BEFORE INSERT ON nodix_memories
WHEN NEW.fact_id IS NULL
BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;
CREATE TRIGGER nodix_memories_fact_id_update_guard
BEFORE UPDATE ON nodix_memories
WHEN NEW.fact_id IS NULL
BEGIN SELECT RAISE(ABORT, 'nodix_memories.fact_id is required'); END;
`;

function runMigration(database: SqliteDatabaseLike): void {
	const sql = readFileSync(MIGRATION_PATH, "utf8");
	for (const statement of sql.split("--> statement-breakpoint")) {
		const trimmed = statement.trim();
		if (trimmed) database.exec(trimmed);
	}
}

function tableColumns(database: SqliteDatabaseLike): ColumnInfo[] {
	return database.prepare("PRAGMA table_info(nodix_memories)").all() as ColumnInfo[];
}

function indexColumns(database: SqliteDatabaseLike, indexName: string): string[] {
	return database
		.prepare(`PRAGMA index_info("${indexName}")`)
		.all()
		.map((row) => (row as { name: string }).name);
}

function expectOnlyProject(rows: unknown[], projectId: string): void {
	expect(rows).not.toHaveLength(0);
	for (const row of rows) {
		expect(row).toMatchObject({ project_id: projectId });
	}
}

function insertMemory(
	database: SqliteDatabaseLike,
	input: {
		id: string;
		projectId: string;
		text: string;
		category: string;
		contentHash: string;
		factId: string;
		subject: string | null;
		attribute: string | null;
		derivedFrom?: string | null;
	},
): void {
	database
		.prepare(`
			INSERT INTO nodix_memories(
				id, text, category, project_id, timestamp, timezone, content_hash, fact_id,
				derived_from, subject, attribute
			) VALUES (?, ?, ?, ?, 1700000000000, 'UTC', ?, ?, ?, ?, ?)
		`)
		.run(
			input.id,
			input.text,
			input.category,
			input.projectId,
			input.contentHash,
			input.factId,
			input.derivedFrom ?? null,
			input.subject,
			input.attribute,
		);
}

describe("atomic memory additive schema", () => {
	let directory: string;
	let runtime: SqliteRuntimeHandle;

	beforeEach(() => {
		initSqliteRuntimeSync();
		directory = mkdtempSync(join(tmpdir(), "atomic-memory-additive-"));
		runtime = openSqliteDatabase(join(directory, "memory.sqlite"));
		runtime.db.exec("PRAGMA foreign_keys = ON");
		runtime.db.exec(INCUMBENT_SCHEMA);
	});

	afterEach(() => {
		runtime.db.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it("adds only seven nullable card columns and leaves cutover refusals dark", () => {
		runtime.db.exec(`
			INSERT INTO nodix_memories(
				id, text, category, project_id, timestamp, timezone, content_hash, fact_id, lane
			) VALUES (
				'legacy-summary', 'Incumbent summary.', 'summary', 'project-a', 1,
				'UTC', 'legacy-summary-hash', 'legacy-summary-fact', 'quarantined'
			)
		`);
		const beforeNames = new Set(tableColumns(runtime.db).map(({ name }) => name));

		runMigration(runtime.db);

		const added = tableColumns(runtime.db)
			.filter(({ name }) => !beforeNames.has(name))
			.map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
		expect(added).toEqual(
			ADDITIVE_COLUMNS.map(({ name, type }) => ({
				name,
				type,
				notnull: 0,
				dflt_value: null,
			})),
		);
		expect(
			runtime.db
				.prepare(
					"SELECT subject, attribute, valid_from, valid_until, maturity, source, extractor_version FROM nodix_memories WHERE id = 'legacy-summary'",
				)
				.get(),
		).toEqual({
			subject: null,
			attribute: null,
			valid_from: null,
			valid_until: null,
			maturity: null,
			source: null,
			extractor_version: null,
		});

		expect(() =>
			runtime.db.exec(`
				INSERT INTO nodix_memories(
					id, text, category, project_id, timestamp, timezone, content_hash, fact_id
				) VALUES (
					'incumbent-write', 'Another summary.', 'summary', 'project-a', 2,
					'UTC', 'incumbent-write-hash', 'incumbent-write-fact'
				)
			`),
		).not.toThrow();
		expect(() =>
			runtime.db
				.prepare("UPDATE nodix_memories SET text = ? WHERE id = ?")
				.run("Updated incumbent summary.", "incumbent-write"),
		).not.toThrow();
		expect(() =>
			runtime.db.exec(`
				INSERT INTO nodix_memories(
					id, text, category, project_id, timestamp, timezone, content_hash, fact_id,
					subject, valid_from, valid_until, maturity, source
				) VALUES (
					'matrix-invalid-until-cutover', 'Future claim.', 'foresight', 'project-a', 3,
					'UTC', 'matrix-invalid-hash', 'matrix-invalid-fact', 'agent', 4, 4,
					'compiled', 'edge'
				)
			`),
		).not.toThrow();
	});

	it("constrains relations to the ratified predicates plus MENTIONS", () => {
		runMigration(runtime.db);
		insertMemory(runtime.db, {
			id: "source-card",
			projectId: "project-a",
			text: "The agent works on Atlas.",
			category: "persona",
			contentHash: "source-card-hash",
			factId: "source-card-fact",
			subject: "agent",
			attribute: "persona.work",
		});

		const dictionary = JSON.parse(
			readFileSync(RELATION_DICTIONARY_PATH, "utf8"),
		) as RelationDictionary;
		const ratified = dictionary.relations
			.filter(({ ratified: isRatified }) => isRatified)
			.map(({ type }) => type);
		expect(dictionary.relation_count).toBe(31);
		expect(ratified).toEqual(RATIFIED_PREDICATES);

		const tableSql = runtime.db
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get("nodix_memory_relations") as { sql: string };
		const predicateCheck = tableSql.sql.match(/predicate IN \(([\s\S]*?)\)/u)?.[1];
		expect(predicateCheck).toBeDefined();
		const persistedPredicates = Array.from(predicateCheck?.matchAll(/'([^']+)'/gu) ?? []).map(
			([, predicate]) => predicate,
		);
		expect(persistedPredicates).toEqual([...RATIFIED_PREDICATES, "MENTIONS"]);

		const insert = runtime.db.prepare(`
			INSERT INTO nodix_memory_relations(source_card_id, subject, predicate, object, created_at)
			VALUES ('source-card', 'agent', ?, ?, 1700000000000)
		`);
		for (const predicate of persistedPredicates) insert.run(predicate, `object:${predicate}`);
		for (const { type } of dictionary.relations.filter(({ ratified }) => !ratified)) {
			expect(() => insert.run(type, `object:${type}`)).toThrow(/CHECK constraint failed/u);
		}
		expect(() => insert.run("NOT_IN_DICTIONARY", "object:unknown")).toThrow(
			/CHECK constraint failed/u,
		);
		expect(() => insert.run("WORKS_ON", "object:WORKS_ON")).toThrow(
			/UNIQUE constraint failed/u,
		);
		expect(() =>
			runtime.db
				.prepare(
					"INSERT INTO nodix_memory_relations VALUES ('missing-card', 'agent', 'WORKS_ON', 'Atlas', 1)",
				)
				.run(),
		).toThrow(/FOREIGN KEY constraint failed/u);
		expect(indexColumns(runtime.db, "nodix_idx_memory_relations_subject")).toEqual(["subject"]);
		expect(indexColumns(runtime.db, "nodix_idx_memory_relations_object")).toEqual(["object"]);

		runtime.db.prepare("DELETE FROM nodix_memories WHERE id = ?").run("source-card");
		expect(
			runtime.db.prepare("SELECT COUNT(*) AS count FROM nodix_memory_relations").get(),
		).toEqual({ count: 0 });
	});

	it("admits only key and content suppression shapes with per-project uniqueness", () => {
		runMigration(runtime.db);
		const insert = runtime.db.prepare(`
			INSERT INTO nodix_memory_suppressions(
				project_id, subject, attribute, content_hash, created_at
			) VALUES (?, ?, ?, ?, 1700000000000)
		`);

		insert.run("project-a", "user", "preferences.food", null);
		insert.run("project-a", null, null, "content-hash");
		expect(() => insert.run("project-b", "user", "preferences.food", null)).not.toThrow();
		expect(() => insert.run("project-b", null, null, "content-hash")).not.toThrow();
		expect(() => insert.run("project-a", "user", "preferences.food", null)).toThrow(
			/UNIQUE constraint failed/u,
		);
		expect(() => insert.run("project-a", null, null, "content-hash")).toThrow(
			/UNIQUE constraint failed/u,
		);

		const invalidShapes: Array<[string | null, string | null, string | null]> = [
			[null, null, null],
			["user", null, null],
			[null, "preferences.food", null],
			["user", "preferences.food", "content-hash-2"],
			["user", null, "content-hash-3"],
			[null, "preferences.food", "content-hash-4"],
			["", "preferences.food", null],
			["user", "   ", null],
			[null, null, "   "],
		];
		for (const [subject, attribute, contentHash] of invalidShapes) {
			expect(() =>
				insert.run(`invalid:${subject}:${attribute}:${contentHash}`, subject, attribute, contentHash),
			).toThrow(/CHECK constraint failed/u);
		}
		expect(indexColumns(runtime.db, "nodix_idx_memory_suppressions_key")).toEqual([
			"project_id",
			"subject",
			"attribute",
		]);
		expect(indexColumns(runtime.db, "nodix_idx_memory_suppressions_content")).toEqual([
			"project_id",
			"content_hash",
		]);
	});

	it("keeps key, persona, relation, and lineage reads inside one project", () => {
		runMigration(runtime.db);
		for (const [projectId, suffix] of [
			["project-a", "a"],
			["project-b", "b"],
		] as const) {
			insertMemory(runtime.db, {
				id: `key-${suffix}`,
				projectId,
				text: `The user in ${projectId} prefers tea.`,
				category: "profile",
				contentHash: `key-hash-${suffix}`,
				factId: "shared-parent-fact",
				subject: "user",
				attribute: "preferences.food",
			});
			insertMemory(runtime.db, {
				id: `persona-${suffix}`,
				projectId,
				text: `The agent in ${projectId} works on Atlas.`,
				category: "persona",
				contentHash: `persona-hash-${suffix}`,
				factId: `persona-fact-${suffix}`,
				subject: "agent",
				attribute: "persona.work",
			});
			insertMemory(runtime.db, {
				id: `lineage-${suffix}`,
				projectId,
				text: `Compiled claim in ${projectId}.`,
				category: "lesson",
				contentHash: `lineage-hash-${suffix}`,
				factId: `lineage-fact-${suffix}`,
				subject: "agent",
				attribute: "lessons.storage",
				derivedFrom: '["shared-parent-fact"]',
			});
			runtime.db
				.prepare(`
					INSERT INTO nodix_memory_relations(
						source_card_id, subject, predicate, object, created_at
					) VALUES (?, 'agent', 'WORKS_ON', 'Atlas', 1700000000000)
				`)
				.run(`persona-${suffix}`);
		}

		for (const [indexName, columns] of Object.entries(MEMORY_SELECTOR_INDEXES)) {
			expect(indexColumns(runtime.db, indexName)).toEqual(columns);
		}
		const keyRows = runtime.db
			.prepare(
				"SELECT id, project_id FROM nodix_memories WHERE project_id = ? AND subject = ? AND attribute = ? ORDER BY id",
			)
			.all("project-a", "user", "preferences.food");
		const personaRows = runtime.db
			.prepare(
				"SELECT id, project_id FROM nodix_memories WHERE project_id = ? AND category = 'persona' AND subject = 'agent' ORDER BY id",
			)
			.all("project-a");
		const relationRows = runtime.db
			.prepare(`
					SELECT source.id, source.project_id
					FROM nodix_memory_relations relation
					JOIN nodix_memories source ON source.id = relation.source_card_id
					WHERE source.project_id = ? AND relation.subject = ? AND relation.predicate = ?
					ORDER BY source.id
				`)
			.all("project-a", "agent", "WORKS_ON");
		const lineageRows = runtime.db
			.prepare(`
					SELECT child.id AS child_id, parent.id AS parent_id, parent.project_id
					FROM nodix_memories child
					JOIN json_each(child.derived_from) edge
					JOIN nodix_memories parent
						ON parent.fact_id = edge.value AND parent.project_id = child.project_id
					WHERE child.id = ? AND child.project_id = ?
					ORDER BY parent.id
				`)
			.all("lineage-a", "project-a");
		expect(keyRows).toEqual([{ id: "key-a", project_id: "project-a" }]);
		expect(personaRows).toEqual([{ id: "persona-a", project_id: "project-a" }]);
		expect(relationRows).toEqual([{ id: "persona-a", project_id: "project-a" }]);
		expect(lineageRows).toEqual([
			{ child_id: "lineage-a", parent_id: "key-a", project_id: "project-a" },
		]);
		for (const rows of [keyRows, personaRows, relationRows, lineageRows]) {
			expectOnlyProject(rows, "project-a");
		}

		const plantedKeyLeak = runtime.db
			.prepare(
				"SELECT project_id FROM nodix_memories WHERE subject = ? AND attribute = ? ORDER BY project_id",
			)
			.all("user", "preferences.food");
		const plantedRelationLeak = runtime.db
			.prepare(`
				SELECT source.project_id
				FROM nodix_memory_relations relation
				JOIN nodix_memories source ON source.id = relation.source_card_id
				WHERE relation.subject = ? AND relation.predicate = ?
				ORDER BY source.project_id
			`)
			.all("agent", "WORKS_ON");
		const plantedLineageLeak = runtime.db
			.prepare(`
				SELECT parent.project_id
				FROM nodix_memories child
				JOIN json_each(child.derived_from) edge
				JOIN nodix_memories parent ON parent.fact_id = edge.value
				WHERE child.id = ?
				ORDER BY parent.project_id
			`)
			.all("lineage-a");
		expect(plantedKeyLeak).toEqual([
			{ project_id: "project-a" },
			{ project_id: "project-b" },
		]);
		expect(plantedRelationLeak).toEqual([
			{ project_id: "project-a" },
			{ project_id: "project-b" },
		]);
		expect(plantedLineageLeak).toEqual([
			{ project_id: "project-a" },
			{ project_id: "project-b" },
		]);
		for (const plantedRows of [plantedKeyLeak, plantedRelationLeak, plantedLineageLeak]) {
			expect(() => expectOnlyProject(plantedRows, "project-a")).toThrow();
		}
	});
});

describe("memory relation product API", () => {
	let embedder: Awaited<ReturnType<typeof createTestEmbedder>>;

	beforeAll(async () => {
		embedder = await createTestEmbedder();
	});

	it("normalizes predicates and walks both directions within one project", async () => {
		const dictionary = JSON.parse(
			readFileSync(RELATION_DICTIONARY_PATH, "utf8"),
		) as RelationDictionary;
		const unratified = dictionary.relations.filter(({ ratified }) => !ratified);
		expect(unratified).toHaveLength(9);
		for (const predicate of RATIFIED_PREDICATES) {
			expect(normalizeMemoryRelationPredicate(predicate)).toBe(predicate);
		}
		for (const predicate of [
			"MENTIONS",
			...unratified.map(({ type }) => type),
			"NOT_IN_DICTIONARY",
		]) {
			expect(normalizeMemoryRelationPredicate(predicate)).toBe("MENTIONS");
		}

		const fixture = createTestDb();
		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		try {
			for (const [projectId, suffix] of [
				["project-a", "a"],
				["project-b", "b"],
			] as const) {
				insertMemory(fixture.runtime.db, {
					id: `relation-source-${suffix}`,
					projectId,
					text: `The agent in ${projectId} works on Atlas.`,
					category: "persona",
					contentHash: `relation-source-hash-${suffix}`,
					factId: `relation-source-fact-${suffix}`,
					subject: "agent",
					attribute: "persona.work",
				});
				const insertRelation = fixture.runtime.db.prepare(`
					INSERT INTO nodix_memory_relations(
						source_card_id, subject, predicate, object, created_at
					) VALUES (?, 'agent', ?, 'Atlas', ?)
				`);
				insertRelation.run(`relation-source-${suffix}`, "WORKS_ON", 1);
				insertRelation.run(`relation-source-${suffix}`, "MENTIONS", 2);
			}

			const expectedTyped = [
				{
					sourceCardId: "relation-source-a",
					projectId: "project-a",
					subject: "agent",
					predicate: "WORKS_ON",
					object: "Atlas",
					createdAt: 1,
				},
			];
			expect(
				store.walkMemoryRelations({
					projectId: "project-a",
					node: "agent",
					direction: "outgoing",
				}),
			).toEqual(expectedTyped);
			expect(
				store.walkMemoryRelations({
					projectId: "project-a",
					node: "Atlas",
					direction: "incoming",
				}),
			).toEqual(expectedTyped);
			for (const direction of ["outgoing", "incoming"] as const) {
				const node = direction === "outgoing" ? "agent" : "Atlas";
				expect(
					store.walkMemoryRelations({
						projectId: "project-a",
						node,
						direction,
						includeMentions: true,
					}),
				).toEqual([
					{
						sourceCardId: "relation-source-a",
						projectId: "project-a",
						subject: "agent",
						predicate: "MENTIONS",
						object: "Atlas",
						createdAt: 2,
					},
					...expectedTyped,
				]);
			}
			expect(() =>
				fixture.runtime.db
					.prepare(`
						INSERT INTO nodix_memory_relations(
							source_card_id, subject, predicate, object, created_at
						) VALUES ('relation-source-a', 'agent', 'WORKS_ON', 'Atlas', 3)
					`)
					.run(),
			).toThrow(/UNIQUE constraint failed/u);
		} finally {
			await store.close();
			fixture.cleanup();
		}
	});
});
