/** Real ONNX embedder + real encrypted SQLite. No mocking. */

/**
 * Phase 0 §20.6 preservation test.
 *
 * Asserts the gate at the retriever's post-retrieval `recordAccess` site
 * (`apps/mem-claw/src/retrieval/retriever-execution.ts`) honors its Phase 0
 * contract:
 *
 *     (recallLifecycle.autoRecallAccessTracking || context.source === "manual")
 *
 * With every `recallLifecycle.*` boolean forced off (the `FLAGS_OFF`
 * literal), an `auto-recall` retrieval MUST NOT increment `accessCount`; a
 * `manual` retrieval MUST increment it. This is the same baseline behavior
 * preserved by §20.5 fixture-bit-equality, expressed at the metadata-write
 * boundary.
 *
 * Per §3.9/§3.10 of `openspec/changes/mem-lifecycle/tasks.md`, the
 * `autoRecallAccessTracking` half of the OR is the new wire — the test
 * exercises both branches against an explicit flags-off config so the
 * OFF-path contract holds independent of the schema defaults.
 *
 * Implementation follows the access-tracker hard-caps unit test: drive the
 * retriever directly (skip plugin `register()` plumbing) so the tracker's
 * 5s debounce can be shrunk to 1 ms and `flush()` is reachable.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_RECALL_LIFECYCLE,
	type RecallLifecycleConfig,
} from "../../../../packages/memory/config/index.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	AccessTracker,
	parseAccessMetadata,
} from "../../../../packages/memory/src/engine/retrieval/access-tracker.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

const SEED_TEXT =
	"The user prefers dark mode in every editor and operating system theme they configure.";
const QUERY = "What theme does the user prefer for editors and the OS?";
const FLAGS_OFF: RecallLifecycleConfig = {
	...DEFAULT_RECALL_LIFECYCLE,
	tierPromoter: false,
	autoRecallAccessTracking: false,
};

interface Fixture {
	store: MemoryStore;
	memoryId: string;
	cleanup: () => void;
}

async function buildFixture(): Promise<Fixture> {
	const td = createTestDb();
	const store = new MemoryStore({ dbPath: td.dbPath, embedder });
	const stored = await store.store({
		text: SEED_TEXT,
		category: "episodic",
		projectId: "global",
		importance: 0.7,
	});

	function cleanup(): void {
		try {
			store.closeSync();
		} catch {
			// already closed
		}
		td.cleanup();
	}

	return { store, memoryId: stored.id, cleanup };
}

function readAccessCount(store: MemoryStore, id: string): number {
	const meta = store.getById(id)?.metadata;
	return parseAccessMetadata(meta).accessCount;
}

describe("Phase 0 §20.6 — accessCount only increments on manual when all flags off", () => {
	let fixture: Fixture | undefined;

	beforeEach(() => {
		fixture = undefined;
	});

	afterEach(() => {
		fixture?.cleanup();
	});

	it("explicit flags-off config keeps every recallLifecycle boolean false", () => {
		const flags: ReadonlyArray<keyof RecallLifecycleConfig> = [
			"tierPromoter",
			"autoRecallAccessTracking",
		];
		for (const key of flags) {
			expect(FLAGS_OFF[key]).toBe(false);
		}
	});

	it("source=auto-recall + flags-off: accessCount does NOT increment", async () => {
		fixture = await buildFixture();
		const { store, memoryId } = fixture;

		const tracker = new AccessTracker({
			store,
			debounceMs: 1,
			recallLifecycle: FLAGS_OFF,
		});
		const retriever = createRetriever(store, embedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" });
		retriever.setAccessTracker(tracker);
		retriever.setRecallLifecycle(FLAGS_OFF);

		const before = readAccessCount(store, memoryId);

		const results = await retriever.retrieve({
			query: QUERY,
			limit: 5,
			source: "auto-recall",
		});
		await tracker.flush();
		await tracker.destroy();

		// Sanity guard: the test is meaningful only if the seed is actually
		// returned. If retrieval misses, the gate never fires either way.
		expect(results.some((r) => r.entry.id === memoryId)).toBe(true);

		const after = readAccessCount(store, memoryId);
		expect(after).toBe(before);
	});

	it("source=manual + flags-off: accessCount DOES increment", async () => {
		fixture = await buildFixture();
		const { store, memoryId } = fixture;

		const tracker = new AccessTracker({
			store,
			debounceMs: 1,
			recallLifecycle: FLAGS_OFF,
		});
		const retriever = createRetriever(store, embedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" });
		retriever.setAccessTracker(tracker);
		retriever.setRecallLifecycle(FLAGS_OFF);

		const before = readAccessCount(store, memoryId);

		const results = await retriever.retrieve({
			query: QUERY,
			limit: 5,
			source: "manual",
		});
		await tracker.flush();
		await tracker.destroy();

		expect(results.some((r) => r.entry.id === memoryId)).toBe(true);

		const after = readAccessCount(store, memoryId);
		expect(after).toBe(before + 1);
	});

	it("source=auto-recall + flags-off via retrieveWithTrace: still does NOT increment", async () => {
		// The retriever exposes two entry points (`retrieve` + `retrieveWithTrace`);
		// §3.10 puts the identical gate at both wire sites. Cover the second
		// branch so a copy-paste drift on one of them would surface.
		fixture = await buildFixture();
		const { store, memoryId } = fixture;

		const tracker = new AccessTracker({
			store,
			debounceMs: 1,
			recallLifecycle: FLAGS_OFF,
		});
		const retriever = createRetriever(store, embedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" });
		retriever.setAccessTracker(tracker);
		retriever.setRecallLifecycle(FLAGS_OFF);

		const before = readAccessCount(store, memoryId);

		const { results } = await retriever.retrieveWithTrace({
			query: QUERY,
			limit: 5,
			source: "auto-recall",
		});
		await tracker.flush();
		await tracker.destroy();

		expect(results.some((r) => r.entry.id === memoryId)).toBe(true);

		const after = readAccessCount(store, memoryId);
		expect(after).toBe(before);
	});

	it("retrieveWithTrace + source=manual + flags-off: increments", async () => {
		fixture = await buildFixture();
		const { store, memoryId } = fixture;

		const tracker = new AccessTracker({
			store,
			debounceMs: 1,
			recallLifecycle: FLAGS_OFF,
		});
		const retriever = createRetriever(store, embedder, { warn: () => {} }, { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" });
		retriever.setAccessTracker(tracker);
		retriever.setRecallLifecycle(FLAGS_OFF);

		const before = readAccessCount(store, memoryId);

		const { results } = await retriever.retrieveWithTrace({
			query: QUERY,
			limit: 5,
			source: "manual",
		});
		await tracker.flush();
		await tracker.destroy();

		expect(results.some((r) => r.entry.id === memoryId)).toBe(true);

		const after = readAccessCount(store, memoryId);
		expect(after).toBe(before + 1);
	});
});
