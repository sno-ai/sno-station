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

describe("memory content hash unique index migration", () => {
	it("widens an already-applied legacy index to include category", () => {
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
				CREATE UNIQUE INDEX nodix_idx_memories_project_content_hash
				ON nodix_memories (project_id, content_hash);
			`);

			const sql = readFileSync(
				join(process.cwd(), "drizzle/0008_widen_memory_hash_unique_index.sql"),
				"utf8",
			);
			runMigration(sqlite, sql);

			const columns = sqlite
				.prepare("PRAGMA index_info(nodix_idx_memories_project_content_hash)")
				.all()
				.map((row) => (row as { name: string }).name);
			expect(columns).toEqual(["project_id", "content_hash", "category"]);

			const insert = sqlite.prepare(`
				INSERT INTO nodix_memories
				(id, text, category, project_id, importance, timestamp, metadata, content_hash)
				VALUES (?, ?, ?, 'unit-migration-project', 0.7, 1, '{}', 'same-hash')
			`);
			insert.run("a", "text", "fact");
			expect(() => insert.run("b", "text", "preference")).not.toThrow();
			expect(() => insert.run("c", "text", "fact")).toThrow();
		} finally {
			sqlite.close();
		}
	});
});
