/** @file memory-metadata-active-task-shape.test.ts
 * @purpose Proves the storage chokepoint rejects legacy or oversized active-task writes loudly.
 * @boundary Real encrypted SQLite and real local embeddings; migration seeds bypass this boundary.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";

let embedder: Embedder;
let fixture: TestDb;
let store: MemoryStore;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

beforeEach(() => {
	fixture = createTestDb();
	store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
});

afterEach(() => {
	store.closeSync();
	fixture.cleanup();
});

function baseMetadata(text: string, patch: Record<string, unknown>): string {
	return stringifyInsightMetadata(
		buildInsightMetadata(
			{ text, category: "profile", timestamp: 1_000 },
			{
				section_name: "active_tasks",
				source: "ambient-learning",
				...patch,
			},
		),
	);
}

describe("active-task shape alarm", () => {
	it("rejects a new active omnibus ledger", async () => {
		const text = "Active tasks:\n- legacy task";
		await expect(
			store.store({
				text,
				category: "profile",
				projectId: "active-task-shape-alarm",
				timestamp: 1_000,
				metadata: baseMetadata(text, {
					active_tasks: [{ id: "legacy", description: "legacy task", created_at: 1_000 }],
				}),
				trusted: true,
			}),
		).rejects.toThrow(/active-task shape alarm/i);
	});

	it("rejects an oversized projection title", async () => {
		// The bound is 128 tokens. Each emoji costs two UTF-16 units, so 193 of
		// them price at 129 tokens — one over.
		const title = "😀".repeat(193);
		const text = `Active tasks:\n- ${title}`;
		await expect(
			store.store({
				text,
				category: "profile",
				projectId: "active-task-shape-alarm",
				timestamp: 2_000,
				metadata: baseMetadata(text, {
					active_task_kind: "projection",
					active_task_ids: ["task-1"],
					active_task_titles: [title],
				}),
				trusted: true,
			}),
		).rejects.toThrow(/active-task shape alarm/i);
	});
});
