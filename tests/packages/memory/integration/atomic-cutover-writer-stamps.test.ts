/** @file atomic-cutover-writer-stamps.test.ts
 * @purpose Proves every production memory insert survives the atomic schema with required stamps.
 * @boundary Real encrypted SQLite plus a repository-wide inventory of product INSERT statements.
 */

import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "@/extraction/embedding-provider-client";
import { applyAtomicMemoryCutoverMigration } from "@/storage/atomic-memory-cutover-sql";
import { MemoryStore } from "@/storage/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

interface AtomicStampRow {
	maturity: string;
	source: string;
	extractorVersion: string;
}

interface MemoryInsert {
	file: string;
	columns: readonly string[];
}

let embedder: Embedder;
const fixtures: TestDb[] = [];
const stores: MemoryStore[] = [];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(async () => {
	for (const store of stores.splice(0).reverse()) await store.close();
	for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup();
});

function createFixture(): TestDb {
	const fixture = createTestDb();
	fixtures.push(fixture);
	return fixture;
}

describe("atomic cutover writer stamps", () => {
	it("refuses an unstamped bypass and admits the ordinary store entrypoint", async () => {
		const fixture = createFixture();
		applyAtomicMemoryCutoverMigration(fixture.runtime.db);

		expect(() =>
			fixture.runtime.db
				.prepare(
					`INSERT INTO nodix_memories(
						id, text, category, project_id, importance, timestamp, timezone,
						metadata, content_hash, fact_id
					) VALUES (?, ?, 'episodic', ?, 0.7, ?, 'UTC', '{}', ?, ?)`,
				)
				.run(
					"unstamped-bypass",
					"This bypass must be refused.",
					"atomic-writer-stamps",
					Date.parse("2030-01-01T00:00:00.000Z"),
					"unstamped-bypass-hash",
					"unstamped-bypass",
				),
		).toThrow(/maturity/iu);

		const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		stores.push(store);
		const written = await store.store({
			text: "The user keeps the evening work session under forty minutes.",
			category: "episodic",
			projectId: "atomic-writer-stamps",
			timestamp: Date.parse("2030-01-01T00:00:01.000Z"),
			timezone: "UTC",
			metadata: JSON.stringify({ source: "manual" }),
		});
		const row = fixture.runtime.db
			.prepare(
				`SELECT maturity, source, extractor_version AS extractorVersion
				 FROM nodix_memories WHERE id = ?`,
			)
			.get(written.id) as AtomicStampRow | undefined;
		expect(row).toEqual({
			maturity: "extracted",
			source: "manual",
			extractorVersion: "memory-store",
		});
	});

	it("requires every production INSERT to name all atomic stamp columns", () => {
		const inserts = globSync("apps/mem-claw/src/**/*.ts", { cwd: REPO_ROOT }).flatMap(
			(file): MemoryInsert[] => {
				const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
				return Array.from(
					source.matchAll(
						/INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO\s+nodix_memories\s*\(([^)]*)\)\s*VALUES/giu,
					),
					(match) => ({
						file,
						columns: (match[1] ?? "")
							.split(",")
							.map((column) => column.trim().toLowerCase()),
					}),
				);
			},
		);
		expect(inserts.length).toBeGreaterThan(0);
		for (const insert of inserts) {
			expect(insert.columns, `${insert.file} omits maturity`).toContain("maturity");
			expect(insert.columns, `${insert.file} omits source`).toContain("source");
			expect(insert.columns, `${insert.file} omits extractor_version`).toContain(
				"extractor_version",
			);
		}
		process.stdout.write(`ATOMIC_WRITER_INSERT_COUNT ${String(inserts.length)}\n`);
	});
});
