/** @file atomic-maintenance-cli.test.ts
 * @purpose Proves the guarded atomic cutover and FTS rebuild maintenance commands.
 * @boundary Commander to the real encrypted MemoryStore SQLite handle.
 */

import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import type { CliContext } from "../../../../packages/memory/src/engine/bindings/memory-cli-shared";
import { registerCommands } from "../../../../apps/mem-claw/src/commands/memory-command-registration";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";

function programFor(context: CliContext): Command {
	const program = new Command();
	program.exitOverride();
	registerCommands(program, context);
	return program;
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic maintenance CLI", () => {
	let fixture: TestDb;
	let store: MemoryStore;

	afterEach(() => {
		store.closeSync();
		fixture.cleanup();
	});

	it("requires the exact flag and runs cutover plus FTS rebuild on the store handle", async () => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
		const context = {
			store,
			retriever: {},
			embedder,
			stateDir: fixture.dbPath,
		} as CliContext;

		await expect(
			programFor(context).parseAsync(["node", "cli", "sno-mem", "atomic-cutover"]),
		).rejects.toThrow("atomic-cutover requires --confirm-empty-store");
		await programFor(context).parseAsync([
			"node",
			"cli",
			"sno-mem",
			"atomic-cutover",
			"--confirm-empty-store",
		]);
		const memorySchema = store.sqlite
			.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodix_memories'")
			.get() as { sql: string };
		expect(memorySchema.sql).toContain(
			"category IN ('episodic', 'profile', 'persona', 'lesson', 'foresight')",
		);

		store.sqlite.exec("PRAGMA foreign_keys = OFF");
		store.sqlite
			.prepare(
				`INSERT INTO nodix_memory_chunks (
					chunk_id, memory_id, chunk_index, chunk_text, dense_payload, summary,
					entities, tags, source, start_offset, end_offset, token_count, content_type,
					chunking_version, embedder_provider, embedder_model, embedder_dim, created_at,
					updated_at
				) VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, 0, 12, 1, 'prose',
					'test', 'local-onnx', 'test', 1024, 1, 1)`,
			)
			.run("atomic-rebuild-probe", "missing-parent-by-design", "rebuildprobe", "rebuildprobe");
		store.sqlite.exec("PRAGMA foreign_keys = ON");
		store.sqlite.exec(
			"INSERT INTO nodix_memory_chunks_fts(nodix_memory_chunks_fts) VALUES('delete-all')",
		);
		const matchCount = (): number =>
			(
				store.sqlite
					.prepare(
						"SELECT COUNT(*) AS count FROM nodix_memory_chunks_fts WHERE nodix_memory_chunks_fts MATCH 'rebuildprobe'",
					)
					.get() as { count: number }
			).count;
		expect(matchCount()).toBe(0);

		await expect(
			programFor(context).parseAsync(["node", "cli", "sno-mem", "atomic-rebuild-index"]),
		).rejects.toThrow("atomic-rebuild-index requires --confirm-empty-store");
		await programFor(context).parseAsync([
			"node",
			"cli",
			"sno-mem",
			"atomic-rebuild-index",
			"--confirm-empty-store",
		]);
		expect(matchCount()).toBe(1);
	});
});
