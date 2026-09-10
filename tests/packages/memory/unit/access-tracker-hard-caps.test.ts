/** @file access-tracker-hard-caps.test.ts
 * @purpose RED test for mem-lifecycle Phase 0 §3: PRD §6.1 accessRateLimitMs + accessCountCeiling.
 * @boundary Real encrypted SQLite chokepoint + real embedder; no mocks.
 *
 * Spec: openspec/changes/mem-lifecycle/tasks.md §3 (3.1, 3.3, 3.5 anchors).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RECALL_LIFECYCLE, type RecallLifecycleConfig } from "../../../../apps/mem-claw/config/index.ts";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../apps/mem-claw/src/extraction/memory-metadata-codec.ts";
import { AccessTracker, parseAccessMetadata } from "../../../../apps/mem-claw/src/retrieval/access-tracker.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let embedder: Embedder;
const TEST_PROJECT_ID = "unit-access-tracker-project";

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

const ON: RecallLifecycleConfig = {
	...DEFAULT_RECALL_LIFECYCLE,
	autoRecallAccessTracking: true,
};

async function seedMemoryWithAccess(
	store: MemoryStore,
	accessCount: number,
	lastAccessedAt: number,
): Promise<string> {
	const stored = await store.store({
			text: "Access-tracker hard-caps target memory with sufficient body for the chunker to accept it.",
			category: "episodic",
			projectId: "global",
			metadata: JSON.stringify({
			accessCount,
			lastAccessedAt,
			access_count: accessCount,
			last_accessed_at: lastAccessedAt,
		}),
	});
	return stored.id;
}

async function seedProfileMemory(store: MemoryStore): Promise<string> {
	const text = "The user prefers concise status updates.";
	const stored = await store.store({
		text,
		category: "profile",
		projectId: "global",
		metadata: stringifyInsightMetadata(
			buildInsightMetadata(
				{ text, category: "profile", timestamp: 0 },
				{ section_name: "preferences.status_updates", access_count: 0, last_accessed_at: 0 },
			),
		),
		trusted: true,
	});
	return stored.id;
}

function readAccess(store: MemoryStore, id: string): { count: number; last: number } {
	const meta = store.getById(id)?.metadata;
	const parsed = parseAccessMetadata(meta);
	return { count: parsed.accessCount, last: parsed.lastAccessedAt };
}

describe("AccessTracker — Phase 0 §3 hard caps gated by autoRecallAccessTracking", () => {
	let store: MemoryStore;
	let cleanup: () => void;

	beforeEach(() => {
		const td = createTestDb();
		cleanup = td.cleanup;
		store = new MemoryStore({ dbPath: td.dbPath, embedder });
	});

	afterEach(async () => {
		store.closeSync();
		cleanup();
	});

	it("flag OFF: increments proceed without 1h window gating (legacy behavior)", async () => {
		const id = await seedMemoryWithAccess(store, 5, Date.now());

		const tracker = new AccessTracker({
			store,
			debounceMs: 5_000,
			recallLifecycle: {
				...DEFAULT_RECALL_LIFECYCLE,
				autoRecallAccessTracking: false,
			},
		});
		tracker.recordAccess([id]);
		await tracker.flush();

		const after = readAccess(store, id);
		expect(after.count).toBe(6);

		await tracker.destroy();
	});

	it("flag ON + accessCount already at ceiling (20): increment is a no-op on count", async () => {
		const id = await seedMemoryWithAccess(store, 20, 0);

		const tracker = new AccessTracker({
			store,
			debounceMs: 5_000,
			recallLifecycle: ON,
		});
		tracker.recordAccess([id]);
		await tracker.flush();

		const after = readAccess(store, id);
		expect(after.count).toBe(20);

		await tracker.destroy();
	});

	it("flag ON + last access within 1h: second call within the window is a no-op", async () => {
		const id = await seedMemoryWithAccess(store, 5, Date.now());

		const tracker = new AccessTracker({
			store,
			debounceMs: 5_000,
			recallLifecycle: ON,
		});
		tracker.recordAccess([id]);
		await tracker.flush();

		const after = readAccess(store, id);
		expect(after.count).toBe(5);
		expect(after.last).toBeGreaterThan(0);

		await tracker.destroy();
	});

	it("flag ON + last access > 1h ago: increment proceeds", async () => {
		const id = await seedMemoryWithAccess(store, 5, Date.now() - 3_700_000);

		const tracker = new AccessTracker({
			store,
			debounceMs: 5_000,
			recallLifecycle: ON,
		});
		tracker.recordAccess([id]);
		await tracker.flush();

		const after = readAccess(store, id);
		expect(after.count).toBe(6);

		await tracker.destroy();
	});

	it("keeps episodic access updates when the recalled batch also contains a profile", async () => {
		const episodicId = await seedMemoryWithAccess(store, 0, 0);
		const profileId = await seedProfileMemory(store);
		const tracker = new AccessTracker({
			store,
			debounceMs: 5_000,
			recallLifecycle: {
				...DEFAULT_RECALL_LIFECYCLE,
				autoRecallAccessTracking: false,
			},
		});

		tracker.recordAccess([episodicId, profileId]);
		await tracker.flush();

		expect(readAccess(store, episodicId).count).toBe(1);
		expect(readAccess(store, profileId).count).toBe(0);
		expect(tracker.getPendingUpdates()).toEqual(new Map());
		await tracker.destroy();
	});

	it("retries the complete batch when category lookup fails", async () => {
		const episodicId = await seedMemoryWithAccess(store, 0, 0);
		const originalGetById = store.getById.bind(store);
		let shouldFail = true;
		store.getById = ((id) => {
			if (shouldFail) {
				shouldFail = false;
				throw new Error("injected category lookup failure");
			}
			return originalGetById(id);
		}) as MemoryStore["getById"];
		const tracker = new AccessTracker({
			store,
			debounceMs: 5_000,
			recallLifecycle: {
				...DEFAULT_RECALL_LIFECYCLE,
				autoRecallAccessTracking: false,
			},
		});

		tracker.recordAccess([episodicId]);
		await tracker.flush();
		expect(tracker.getPendingUpdates()).toEqual(new Map([[episodicId, 1]]));
		await tracker.flush();

		expect(readAccess(store, episodicId).count).toBe(1);
		expect(tracker.getPendingUpdates()).toEqual(new Map());
		await tracker.destroy();
	});
});
