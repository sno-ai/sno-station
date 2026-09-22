/** @file rem-journal-operation-migration.test.ts
 * @purpose Proves the operation rename migrates an existing REM journal without rewriting history.
 * @boundary Real encrypted SQLite, the pre-rename schema, and ordinary MemoryStore opens; no substitutes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createRemRepository } from "../../../../packages/memory/src/engine/rem/index.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

interface JournalRow {
	sequence: number;
	job_id: string;
	job_type: string;
	stage: string;
	outcome: string;
	row_id: string | null;
	pair_id: string | null;
	pairs_scanned: number;
	verdicts: number;
	actions_applied: number;
	reason: string | null;
}

const PRE_RENAME_SCHEMA = readFileSync(
	resolve(import.meta.dirname, "../../../apps/mem-claw/fixtures/rem-journal-pre-rename-schema.sql"),
	"utf8",
);

const HISTORICAL_ROWS = [
	{
		sequence: 41,
		job_id: "historical-verdict-job",
		job_type: "rem-verdict",
		stage: " verdict:pair-α ",
		outcome: "done",
		row_id: null,
		pair_id: "pair-legacy-α",
		pairs_scanned: 7,
		verdicts: 3,
		actions_applied: 1,
		reason: "retired verdict history — preserve exactly",
	},
	{
		sequence: 42,
		job_id: "historical-restate-job",
		job_type: "rem-restate",
		stage: "restate:row-β",
		outcome: "no-action",
		row_id: "row-legacy-β",
		pair_id: null,
		pairs_scanned: 0,
		verdicts: 1,
		actions_applied: 0,
		reason: "retired restate history: punctuation, spaces, and case stay verbatim",
	},
] satisfies JournalRow[];

let embedder: Embedder;
let fixture: TestDb | undefined;
let store: MemoryStore | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(() => {
	store?.closeSync();
	fixture?.cleanup();
	store = undefined;
	fixture = undefined;
});

function readJournalRows(database: TestDb["runtime"]["db"]): JournalRow[] {
	return database
		.prepare(
			`SELECT sequence, job_id, job_type, stage, outcome, row_id, pair_id,
				pairs_scanned, verdicts, actions_applied, reason
			FROM nodix_rem_journal
			ORDER BY sequence`,
		)
		.all() as JournalRow[];
}

function readJournalSchema(database: TestDb["runtime"]["db"]): string {
	const row = database
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodix_rem_journal'")
		.get() as { sql: string } | undefined;
	if (!row) throw new Error("nodix_rem_journal schema is missing");
	return row.sql;
}

function readSchemaVersion(database: TestDb["runtime"]["db"]): number {
	return (database.prepare("PRAGMA schema_version").get() as { schema_version: number })
		.schema_version;
}

function seedPreRenameStore(): void {
	if (!fixture) throw new Error("test fixture is not initialized");
	fixture.runtime.db.exec(PRE_RENAME_SCHEMA);
	const insert = fixture.runtime.db.prepare(
		`INSERT INTO nodix_rem_journal(
			sequence, job_id, job_type, stage, outcome, row_id, pair_id,
			pairs_scanned, verdicts, actions_applied, reason
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	fixture.runtime.db.transaction(() => {
		for (const row of HISTORICAL_ROWS) {
			insert.run(
				row.sequence,
				row.job_id,
				row.job_type,
				row.stage,
				row.outcome,
				row.row_id,
				row.pair_id,
				row.pairs_scanned,
				row.verdicts,
				row.actions_applied,
				row.reason,
			);
		}
	})();
}

describe("REM journal operation-name migration", () => {
	it("preserves retired history and makes the second ordinary store open a no-op", () => {
		fixture = createTestDb();
		seedPreRenameStore();
		expect(readJournalSchema(fixture.runtime.db)).toContain(
			"CHECK (job_type IN ('rem-verdict', 'rem-restate'))",
		);
		expect(readJournalRows(fixture.runtime.db)).toEqual(HISTORICAL_ROWS);

		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const firstRepository = createRemRepository(store.sqlite);
		firstRepository.appendJournal("current-update-job", "rem-update", {
			stage: "update:current-row",
			outcome: "done",
			pairsScanned: 0,
			verdicts: 1,
			actionsApplied: 1,
		});

		const migratedSchema = readJournalSchema(fixture.runtime.db);
		expect(migratedSchema).not.toMatch(/job_type[^,]*CHECK/iu);
		expect(readJournalRows(fixture.runtime.db).slice(0, HISTORICAL_ROWS.length)).toEqual(
			HISTORICAL_ROWS,
		);
		store.closeSync();
		store = undefined;
		const schemaVersionAfterFirstClose = readSchemaVersion(fixture.runtime.db);

		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		expect(readSchemaVersion(fixture.runtime.db)).toBe(schemaVersionAfterFirstClose);
		expect(readJournalSchema(fixture.runtime.db)).toBe(migratedSchema);
		const secondRepository = createRemRepository(store.sqlite);
		secondRepository.appendJournal("current-replace-job", "rem-replace", {
			stage: "replace:current-pair",
			outcome: "done",
			pairsScanned: 1,
			verdicts: 1,
			actionsApplied: 1,
		});

		const allRows = readJournalRows(fixture.runtime.db);
		expect(allRows.slice(0, HISTORICAL_ROWS.length)).toEqual(HISTORICAL_ROWS);
		expect(allRows.slice(HISTORICAL_ROWS.length).map((row) => row.job_type)).toEqual([
			"rem-update",
			"rem-replace",
		]);
	});
});
