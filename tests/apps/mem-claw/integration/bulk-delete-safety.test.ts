import { beforeAll, describe, expect, it } from "vitest";
import { DELETE_BATCH_SIZE } from "../../../../packages/memory/config/index.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";

import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

describe("MemoryStore.bulkDelete", () => {
	let embedder: Embedder;
	beforeAll(async () => { embedder = await createTestEmbedder(); });

	it("deletes only rows in the requested scope in real SQLite", async () => {
		const testDb = createTestDb();
		const store = new MemoryStore({
			dbPath: testDb.dbPath,
			embedder,
		});

		try {
			await store.store({
				text: "team alpha rollout note",
				category: "episodic",
				projectId: "team",
			});
			await store.store({
				text: "team beta incident note",
				category: "episodic",
				projectId: "team",
			});
			await store.store({
				text: "global release policy",
				category: "episodic",
				projectId: "global",
			});
			await store.store({
				text: "alice private preference",
				category: "episodic",
				projectId: "agent:alice",
			});

			const result = await store.bulkDelete({ projectId: "team" });

			expect(result).toEqual({ deleted: 2, truncated: false });
			expect(await store.stats("team")).toMatchObject({ total: 0 });
			expect(await store.stats("global")).toMatchObject({ total: 1 });
			expect(await store.stats("agent:alice")).toMatchObject({ total: 1 });
			expect(await store.stats()).toMatchObject({ total: 2 });
		} finally {
			await store.close();
			testDb.cleanup();
		}
	});

	it("marks deletes as truncated when the safety cap is reached", async () => {
		const batchRows = Array.from(
			{ length: DELETE_BATCH_SIZE },
			(_value, index) => ({
				id: `id-${index}`,
			}),
		);
		let deleteCalls = 0;
		const selectSqls: string[] = [];
		const selectBindings: unknown[][] = [];

		const result = await MemoryStore.prototype.bulkDelete.call(
			{
				writeMutex: {
					runExclusive<T>(fn: () => T): T {
						return fn();
					},
				},
				sqlite: {
					prepare(sql: string) {
						// bulkDelete also clears the unplaced-candidate table with a DELETE …
						// RUN; only the paged SELECT belongs to what this case asserts.
						if (sql.startsWith("SELECT")) selectSqls.push(sql);
						return {
							all(...bindings: unknown[]) {
								selectBindings.push(bindings);
								return batchRows;
							},
							run() {
								return { changes: 0 };
							},
						};
					},
				},
				deleteByIds(ids: string[]) {
					deleteCalls += 1;
					expect(ids).toHaveLength(DELETE_BATCH_SIZE);
				},
			} as unknown as MemoryStore,
			{ projectId: "team" },
		);

		expect(result).toEqual({
			deleted: DELETE_BATCH_SIZE * 1000,
			truncated: true,
		});
		expect(deleteCalls).toBe(1000);
		expect(selectSqls).toHaveLength(1000);
		expect(
			selectSqls.every((sql) => sql.includes("WHERE project_id = ? LIMIT ?")),
		).toBe(true);
		expect(
			selectBindings.every(
				(bindings) =>
					bindings[0] === "team" && bindings[1] === DELETE_BATCH_SIZE,
			),
		).toBe(true);
	});
});
