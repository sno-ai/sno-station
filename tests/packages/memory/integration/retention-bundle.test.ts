/** Real ONNX embedder + real encrypted SQLite. No mocking. Missing deps = FAIL. */

/** Retrieval still records accesses and evaluates tier transitions without changing scores. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_RECALL_LIFECYCLE,
	type RecallLifecycleConfig,
} from "../../../../packages/sno-station-mem/config/index.ts";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import {
	createTierPromoter,
	type TierPromoter,
	type TierTransition,
} from "../../../../packages/sno-station-mem/src/engine/operations/memory-tier-promoter.ts";
import { AccessTracker } from "../../../../packages/sno-station-mem/src/engine/retrieval/access-tracker.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever.ts";
import type { MemoryRetrieverInternals } from "../../../../packages/sno-station-mem/src/engine/retrieval/retriever-core.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import type { DecayScore } from "../../../../packages/sno-station-mem/src/engine/shared/types.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

type SeedSpec = {
	text: string;
	importance?: number;
	tier?: "core" | "working" | "peripheral";
	timestampOffsetMs?: number;
	accessCount?: number;
	lastAccessedAt?: number;
};

interface SeededRow {
	id: string;
	tier: "core" | "working" | "peripheral";
}

async function readMetadata(store: MemoryStore, id: string): Promise<Record<string, unknown>> {
	const sqlite = (store as unknown as { sqlite: import("better-sqlite3").Database }).sqlite;
	const row = sqlite
		.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
		.get(id) as { metadata: string | null } | undefined;
	return JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
}

const BUNDLE_ON: RecallLifecycleConfig = {
	...DEFAULT_RECALL_LIFECYCLE,
	tierPromoter: true,
	autoRecallAccessTracking: true,
};

describe("Retrieval access tracking and tier transitions", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;
	let stateDir: string;
	let prevStateDir: string | undefined;

	beforeEach(() => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
		stateDir = mkdtempSync(join(tmpdir(), "mem-claw-retention-bundle-"));
		prevStateDir = process.env.SNO_PROFILE_DIR;
		process.env.SNO_PROFILE_DIR = stateDir;
	});

	afterEach(() => {
		store.close();
		cleanup();
		rmSync(stateDir, { recursive: true, force: true });
		if (prevStateDir === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = prevStateDir;
	});

	async function seed(spec: SeedSpec): Promise<SeededRow> {
		const now = Date.now();
		const ts = now - (spec.timestampOffsetMs ?? 0);
		const vector = await testEmbedder.embed(spec.text);
		const stored = await store.store({
			text: spec.text,
			vector,
			category: "episodic",
			projectId: "global",
			importance: spec.importance ?? 0.5,
			timestamp: ts,
		});
		const tier = spec.tier ?? "working";
		const patch: Record<string, unknown> = {};
		if (spec.accessCount !== undefined) patch.accessCount = spec.accessCount;
		if (spec.lastAccessedAt !== undefined) patch.lastAccessedAt = spec.lastAccessedAt;
		await store.updateMetadata(stored.id, patch);
		await store.updateTier(stored.id, tier, { writerAuthority: "offline-family" });
		return { id: stored.id, tier };
	}

	function buildRetriever(
		lifecycle: RecallLifecycleConfig,
		promoter?: TierPromoter,
	): MemoryRetrieverInternals {
		const retriever = createRetriever(store, testEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			hardMinScore: 0,
			minScore: 0,
		}) as unknown as MemoryRetrieverInternals;
		retriever._recallLifecycle = lifecycle;
		retriever._tierPromoter = promoter ?? createTierPromoter();
		return retriever;
	}

	const QUERY_SUBJECT =
		"PostgreSQL multi-version concurrency control prevents readers from blocking writers.";

	async function seedQueryFixtureSet(): Promise<SeededRow[]> {
		// Topic-aligned seeds so the ONNX embedder retrieves a stable top-K.
		return Promise.all([
			seed({
				text: "Postgres uses MVCC to give readers consistent snapshots without read locks.",
				importance: 0.9,
				tier: "core",
				accessCount: 8,
				lastAccessedAt: Date.now() - 60_000,
			}),
			seed({
				text: "Postgres autovacuum reclaims dead tuples and updates planner statistics.",
				importance: 0.6,
				tier: "working",
				accessCount: 3,
				lastAccessedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
			}),
			seed({
				text: "Postgres write-ahead logging persists commits before flushing data pages.",
				importance: 0.5,
				tier: "working",
				accessCount: 1,
				lastAccessedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
			}),
			seed({
				text: "Postgres bloom indexes accelerate multi-column equality lookups on wide rows.",
				importance: 0.4,
				tier: "peripheral",
				accessCount: 0,
				lastAccessedAt: 0,
				timestampOffsetMs: 90 * 24 * 60 * 60 * 1000,
			}),
			seed({
				text: "Postgres logical replication streams row-level changes between clusters.",
				importance: 0.3,
				tier: "peripheral",
				accessCount: 0,
				lastAccessedAt: 0,
				timestampOffsetMs: 120 * 24 * 60 * 60 * 1000,
			}),
		]);
	}

	it("§5.6 G2 top-K bound: only top `tierPromotionTopK` results have their tier evaluated", async () => {
		const seeds = await seedQueryFixtureSet();
		// All seeds start in `peripheral` so any tier write is detectable.
		for (const s of seeds) {
			await store.updateTier(s.id, "peripheral", { writerAuthority: "offline-family" });
		}

		const evaluated: string[] = [];
		const promoteAll: TierPromoter = {
			evaluate(memory, _score, _now): TierTransition | null {
				evaluated.push(memory.id);
				return {
					memoryId: memory.id,
					fromTier: memory.tier,
					toTier: "working",
					reason: "test-forced top-K probe",
				};
			},
			evaluateAll(memories, decayScores, now) {
				const scoresById = new Map(
					decayScores.map((s: DecayScore) => [s.memoryId, s] as const),
				);
				const out: TierTransition[] = [];
				for (const m of memories) {
					const s = scoresById.get(m.id);
					if (!s) continue;
					const t = this.evaluate(m, s, now);
					if (t) out.push(t);
				}
				return out;
			},
		};

		const topK = 3; // matches PRD §6.1 pinned default
		const retriever = buildRetriever(
			{ ...BUNDLE_ON, tierPromotionTopK: topK },
			promoteAll,
		);

		const results = await retriever.retrieve({
			query: QUERY_SUBJECT,
			limit: seeds.length,
		});
		expect(results.length).toBeGreaterThanOrEqual(topK);

		// `evaluated` must equal exactly the top-K result ids, regardless of
		// how many candidates the retrieval surfaced.
		expect(evaluated.length).toBe(topK);
		const topKResultIds = results.slice(0, topK).map((r) => r.entry.id);
		expect(evaluated).toEqual(topKResultIds);

		// And the (topK+1)-th result (if present) must NOT have moved.
		if (results.length > topK) {
			const untouched = results[topK];
			if (untouched) {
				const meta = await readMetadata(store, untouched.entry.id);
				expect(meta.tier).toBe("peripheral");
			}
		}
	});

	it("bundle OFF control: auto-recall does NOT increment accessCount; tier writes are zero", async () => {
		const seeds = await seedQueryFixtureSet();
		const tracker = new AccessTracker({
			store,
			debounceMs: 60_000,
			recallLifecycle: {
				...DEFAULT_RECALL_LIFECYCLE,
				autoRecallAccessTracking: false,
			},
		});

		const retriever = buildRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			tierPromoter: false,
			autoRecallAccessTracking: false,
		});
		retriever._accessTracker = tracker;

		const before = new Map<string, unknown>();
		for (const s of seeds) before.set(s.id, await readMetadata(store, s.id));

		await retriever.retrieve({
			query: QUERY_SUBJECT,
			limit: seeds.length,
			source: "auto-recall",
		});
		await tracker.flush();
		await tracker.destroy();

		for (const s of seeds) {
			const beforeMeta = before.get(s.id) as Record<string, unknown>;
			const afterMeta = await readMetadata(store, s.id);
			// Tier unchanged (tierPromoter OFF) — string-equal preserves null/undefined identity.
			expect(afterMeta.tier).toBe(beforeMeta.tier);
			// accessCount unchanged (autoRecallAccessTracking OFF; source=auto-recall).
			expect(afterMeta.accessCount ?? 0).toBe(beforeMeta.accessCount ?? 0);
		}
	});

	it("bundle ON: auto-recall increments accessCount on top results", async () => {
		const seeds = await seedQueryFixtureSet();
		const tracker = new AccessTracker({
			store,
			debounceMs: 60_000,
			recallLifecycle: BUNDLE_ON,
		});

		const retriever = buildRetriever(BUNDLE_ON);
		retriever._accessTracker = tracker;

		const beforeCounts = new Map<string, number>();
		for (const s of seeds) {
			const meta = await readMetadata(store, s.id);
			beforeCounts.set(s.id, (meta.accessCount as number | undefined) ?? 0);
		}

		const results = await retriever.retrieve({
			query: QUERY_SUBJECT,
			limit: seeds.length,
			source: "auto-recall",
		});
		await tracker.flush();
		await tracker.destroy();

		// Every result id should have been recorded. Flush writes the delta to
		// metadata via store.update.
		let incremented = 0;
		for (const r of results) {
			const beforeCount = beforeCounts.get(r.entry.id) ?? 0;
			const meta = await readMetadata(store, r.entry.id);
			const afterCount = (meta.accessCount as number | undefined) ?? 0;
			if (afterCount > beforeCount) incremented += 1;
		}
		expect(incremented).toBeGreaterThanOrEqual(1);
	});

	it("bundle ON: tier transitions persist for top-K candidates", async () => {
		const seeds = await seedQueryFixtureSet();
		// Force everyone down to peripheral so a `working` write is detectable.
		for (const s of seeds) {
			await store.updateTier(s.id, "peripheral", { writerAuthority: "offline-family" });
		}

		const promoter: TierPromoter = {
			evaluate(memory): TierTransition | null {
				return {
					memoryId: memory.id,
					fromTier: memory.tier,
					toTier: "working",
					reason: "bundle-on integration probe",
				};
			},
			evaluateAll() {
				return [];
			},
		};

		const retriever = buildRetriever(BUNDLE_ON, promoter);
		const results = await retriever.retrieve({
			query: QUERY_SUBJECT,
			limit: seeds.length,
		});
		expect(results.length).toBeGreaterThan(0);

		const topK = BUNDLE_ON.tierPromotionTopK;
		const topKIds = new Set(results.slice(0, topK).map((r) => r.entry.id));
		let promoted = 0;
		for (const id of topKIds) {
			const meta = await readMetadata(store, id);
			if (meta.tier === "working") promoted += 1;
		}
		expect(promoted).toBe(topKIds.size);
	});
});
