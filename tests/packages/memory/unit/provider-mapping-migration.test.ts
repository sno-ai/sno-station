import { readFileSync } from "node:fs";
import { join } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";

function runMigration(sqlite: DatabaseConstructor.Database, sql: string): void {
	for (const statement of sql.split("--> statement-breakpoint")) {
		const trimmed = statement.trim();
		if (trimmed) sqlite.exec(trimmed);
	}
}

describe("provider mapping migration", () => {
	it("creates provider tables after the telemetry migration was already applied", () => {
		const sqlite = new DatabaseConstructor(":memory:");
		try {
			const telemetrySql = readFileSync(
				join(process.cwd(), "drizzle/0009_memory_telemetry.sql"),
				"utf8",
			);
			expect(telemetrySql).not.toContain("nodix_provider_project_mappings");

			const providerSql = readFileSync(
				join(process.cwd(), "drizzle/0010_provider_mappings.sql"),
				"utf8",
			);
			const migrationJournal = readFileSync(
				join(process.cwd(), "drizzle/meta/_journal.json"),
				"utf8",
			);
			expect(migrationJournal).toContain('"tag": "0010_provider_mappings"');
			runMigration(sqlite, providerSql);

			const tables = sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'nodix_provider_%' ORDER BY name",
				)
				.all()
				.map((row) => (row as { name: string }).name);
			expect(tables).toEqual([
				"nodix_provider_agent_mappings",
				"nodix_provider_project_agents",
				"nodix_provider_project_mappings",
			]);
		} finally {
			sqlite.close();
		}
	});
});
