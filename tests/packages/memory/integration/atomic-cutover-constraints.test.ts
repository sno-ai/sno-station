/** @file atomic-cutover-constraints.test.ts
 * @purpose Proves the empty-store cutover constraints and a file-level rollback rehearsal.
 * @boundary Real encrypted SQLite opened only through the product runtime and MemoryStore.
 */

import { copyFileSync, rmSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "@/extraction/embedding-provider-client";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "@/extraction/memory-metadata-codec";
import { applyAtomicMemoryCutoverMigration } from "@/storage/atomic-memory-cutover-sql";
import { MemoryStore } from "@/storage/store";
import { openSqliteDatabase, type SqliteDatabaseLike } from "@/storage/sqlite-runtime";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

const PROJECT_ID = "atomic-cutover-project";
const INGESTED_AT = Date.parse("2030-01-01T00:00:00.000Z");
const FUTURE_FROM = Date.parse("2030-02-01T00:00:00.000Z");
const FUTURE_UNTIL = Date.parse("2030-02-02T00:00:00.000Z");

interface CutoverRow {
	id: string;
	category: string;
	importance: number;
	subject: string | null;
	attribute: string | null;
	validFrom: number | null;
	validUntil: number | null;
	maturity: string | null;
	derivedFrom: string | null;
	source: string | null;
}

let embedder: Embedder;
let sequence = 0;
const fixtures: TestDb[] = [];
const stores: MemoryStore[] = [];

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(async () => {
	for (const store of stores.splice(0).reverse()) {
		await store.close();
	}
	for (const fixture of fixtures.splice(0).reverse()) {
		fixture.cleanup();
	}
});

function createFixture(): TestDb {
	const fixture = createTestDb();
	fixtures.push(fixture);
	return fixture;
}

function createStore(dbPath: string): MemoryStore {
	const store = new MemoryStore({ dbPath, embedder });
	stores.push(store);
	return store;
}

function row(overrides: Partial<CutoverRow> = {}): CutoverRow {
	const id = `cutover-row-${++sequence}`;
	return {
		id,
		category: "episodic",
		importance: 0.5,
		subject: "user",
		attribute: "trait.constraint",
		validFrom: null,
		validUntil: null,
		maturity: "extracted",
		derivedFrom: null,
		source: "edge",
		...overrides,
	};
}

function insertRow(database: SqliteDatabaseLike, input: CutoverRow): void {
	database
		.prepare(
			`INSERT INTO nodix_memories (
				id, text, category, project_id, importance, timestamp, timezone, metadata,
				content_hash, fact_id, derived_from, lane, subject, attribute, valid_from,
				valid_until, maturity, source, extractor_version
			) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			`Claim for ${input.id}`,
			input.category,
			PROJECT_ID,
			input.importance,
			INGESTED_AT,
			"UTC",
			`hash-${input.id}`,
			input.id,
			input.derivedFrom,
			input.subject,
			input.attribute,
			input.validFrom,
			input.validUntil,
			input.maturity,
			input.source,
			"atomic-v3-cutover-test",
		);
}

function expectAccepted(database: SqliteDatabaseLike, input: CutoverRow): void {
	expect(() => insertRow(database, input), `expected ${input.id} to be accepted`).not.toThrow();
}

function expectRejected(database: SqliteDatabaseLike, input: CutoverRow): void {
	expect(() => insertRow(database, input), `expected ${input.id} to be rejected`).toThrow();
}

function seedIncumbentSummary(database: SqliteDatabaseLike, id: string): void {
	database
		.prepare(
			`INSERT INTO nodix_memories (
				id, text, category, project_id, importance, timestamp, timezone, metadata,
				content_hash, fact_id, lane
			) VALUES (?, ?, 'summary', ?, 0.7, ?, 'UTC', '{}', ?, ?, 'active')`,
		)
		.run(id, `Summary ${id}`, PROJECT_ID, INGESTED_AT, `hash-${id}`, id);
}

describe("atomic memory cutover constraints", () => {
	it("runs only on an empty memory store and leaves a rejected non-empty store unchanged", () => {
		const implementation = applyAtomicMemoryCutoverMigration.toString();
		expect(implementation.indexOf("database.transaction")).toBeGreaterThanOrEqual(0);
		expect(implementation.indexOf("database.transaction")).toBeLessThan(
			implementation.indexOf("SELECT COUNT(*) AS count FROM nodix_memories"),
		);

		const empty = createFixture();
		expect(() => applyAtomicMemoryCutoverMigration(empty.runtime.db)).not.toThrow();

		const nonEmpty = createFixture();
		const concurrent = openSqliteDatabase(nonEmpty.dbPath, { fileMustExist: true });
		try {
			seedIncumbentSummary(concurrent.db, "incumbent-summary-before-cutover");
			const schemaBefore = nonEmpty.runtime.db
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memories'")
				.get();
			expect(() => applyAtomicMemoryCutoverMigration(nonEmpty.runtime.db)).toThrow(
				/non-empty|must be empty|zero stored memories/iu,
			);
			expect(
				nonEmpty.runtime.db
					.prepare("SELECT id, category FROM nodix_memories WHERE id = ?")
					.get("incumbent-summary-before-cutover"),
			).toEqual({ id: "incumbent-summary-before-cutover", category: "summary" });
		const schemaAfter = nonEmpty.runtime.db
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memories'")
			.get();
			expect(schemaAfter).toEqual(schemaBefore);
			seedIncumbentSummary(concurrent.db, "incumbent-summary-after-refusal");
		} finally {
			concurrent.db.close();
		}
	});

	it("activates the exact category, scalar, time, maturity, source, and class matrix", () => {
		const fixture = createFixture();
		const database = fixture.runtime.db;
		applyAtomicMemoryCutoverMigration(database);

		for (const accepted of [
			row({ category: "episodic" }),
			row({ category: "profile", validFrom: INGESTED_AT }),
			row({ category: "persona", subject: "agent", attribute: null, source: "manual" }),
			row({ category: "lesson", subject: null, attribute: null, source: "manual" }),
			row({
				category: "foresight",
				subject: "user",
				attribute: null,
				validFrom: FUTURE_FROM,
				validUntil: FUTURE_UNTIL,
				source: "cloud",
			}),
		]) {
			expectAccepted(database, accepted);
		}
		expectRejected(database, row({ category: "summary" }));
		expectRejected(database, row({ category: "other" }));

		expectAccepted(database, row({ importance: 0 }));
		expectAccepted(database, row({ importance: 1 }));
		expectRejected(database, row({ importance: -0.01 }));
		expectRejected(database, row({ importance: 1.01 }));

		expectAccepted(database, row({ validFrom: INGESTED_AT, validUntil: INGESTED_AT + 1 }));
		expectRejected(database, row({ validFrom: INGESTED_AT, validUntil: INGESTED_AT }));
		expectRejected(database, row({ validFrom: INGESTED_AT, validUntil: INGESTED_AT - 1 }));

		expectAccepted(database, row({ maturity: "extracted" }));
		expectAccepted(
			database,
			row({ maturity: "distilled", derivedFrom: "source-card-distilled" }),
		);
		expectAccepted(
			database,
			row({
				category: "lesson",
				subject: "agent",
				attribute: null,
				maturity: "compiled",
				derivedFrom: "source-card-compiled",
				source: "manual",
			}),
		);
		expectRejected(database, row({ maturity: "draft" }));
		expectRejected(database, row({ maturity: null }));
		expectRejected(database, row({ maturity: "distilled", derivedFrom: null }));
		expectRejected(
			database,
			row({ category: "lesson", maturity: "compiled", derivedFrom: null, source: "manual" }),
		);
		expectRejected(
			database,
			row({ category: "profile", maturity: "compiled", derivedFrom: "source-card" }),
		);

		for (const source of ["edge", "cloud", "manual"] as const) {
			expectAccepted(database, row({ source }));
		}
		expectRejected(database, row({ source: "legacy" }));
		expectRejected(database, row({ source: null }));
		expectRejected(
			database,
			row({
				category: "foresight",
				subject: "user",
				validFrom: FUTURE_FROM,
				validUntil: FUTURE_UNTIL,
				source: "edge",
			}),
		);

		expectAccepted(database, row({ category: "persona", subject: "agent", source: "manual" }));
		expectRejected(database, row({ category: "persona", subject: "user", source: "manual" }));
		expectRejected(database, row({ category: "persona", subject: null, source: "manual" }));

		expectAccepted(database, row({ category: "lesson", subject: "agent", source: "manual" }));
		expectAccepted(database, row({ category: "lesson", subject: null, source: "manual" }));
		expectRejected(database, row({ category: "lesson", subject: "user", source: "manual" }));

		for (const subject of ["user", "entity:canonical-person"] as const) {
			expectAccepted(
				database,
				row({
					category: "foresight",
					subject,
					validFrom: FUTURE_FROM,
					validUntil: FUTURE_UNTIL,
					source: "cloud",
				}),
			);
		}
		for (const subject of ["agent", "entity:", null] as const) {
			expectRejected(
				database,
				row({
					category: "foresight",
					subject,
					validFrom: FUTURE_FROM,
					validUntil: FUTURE_UNTIL,
					source: "cloud",
				}),
			);
		}
		for (const window of [
			{ validFrom: null, validUntil: FUTURE_UNTIL },
			{ validFrom: FUTURE_FROM, validUntil: null },
			{ validFrom: FUTURE_FROM, validUntil: FUTURE_FROM },
			{ validFrom: INGESTED_AT - 2_000, validUntil: INGESTED_AT - 1_000 },
		]) {
			expectRejected(
				database,
				row({ category: "foresight", subject: "user", source: "cloud", ...window }),
			);
		}

		const immutable = row();
		expectAccepted(database, immutable);
		expect(() =>
			database
				.prepare("UPDATE nodix_memories SET text = ? WHERE id = ?")
				.run("Changed after cutover", immutable.id),
		).toThrow(/text.*immutable|immutable.*text/iu);
	});

	it("restores the pre-cutover file and a working summary write after rollback", async () => {
		const fixture = createFixture();
		const backupPath = `${fixture.dbPath}.pre-cutover`;
		fixture.runtime.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		copyFileSync(fixture.dbPath, backupPath);

		applyAtomicMemoryCutoverMigration(fixture.runtime.db);
		const cutoverStore = createStore(fixture.dbPath);
		const summaryText = "Rollback restores this incumbent summary.";
		const timestamp = INGESTED_AT + 10_000;
		const summaryInput = {
			text: summaryText,
			category: "summary" as const,
			projectId: PROJECT_ID,
			timestamp,
			offlineFamily: true,
			metadata: stringifyInsightMetadata(
				buildInsightMetadata(
					{ text: summaryText, category: "summary", timestamp },
					{ children_ids: ["source-a"], depth: 1 },
				),
			),
		};
		await expect(cutoverStore.store(summaryInput)).rejects.toThrow();

		await cutoverStore.close();
		stores.splice(stores.indexOf(cutoverStore), 1);
		fixture.runtime.db.close();
		rmSync(`${fixture.dbPath}-wal`, { force: true });
		rmSync(`${fixture.dbPath}-shm`, { force: true });
		copyFileSync(backupPath, fixture.dbPath);

		const restoredStore = createStore(fixture.dbPath);
		const restored = await restoredStore.store(summaryInput);
		const readback = restoredStore.getById(restored.id);
		expect(readback).toMatchObject({
			id: restored.id,
			text: summaryText,
			category: "summary",
			projectId: PROJECT_ID,
		});
		process.stdout.write(
			`ATOMIC_ROLLBACK_EVIDENCE ${JSON.stringify({
				status: "pass",
				copy_store: true,
				migration_applied: true,
				rollback_restored: true,
				summary_write: { status: "pass", id: restored.id },
				summary_readback: {
					status: "pass",
					id: readback?.id,
					text: readback?.text,
				},
			})}\n`,
		);
	});
});
