/** Real ONNX embedder + real encrypted SQLite. No mocking. Missing deps = FAIL. */

/**
 * Phase 1 retention bundle (openspec/changes/mem-lifecycle/tasks.md §15.2).
 *
 * Bundle = three `recallLifecycle` flags flipped together:
 *   - retentionScorer
 *   - tierPromoter
 *   - autoRecallAccessTracking
 *
 * Phase 0 landed the wiring with all three defaulting `false`. Phase 1 flips
 * the defaults to `true`. This test enforces the bundle's observable contract
 * at integration scale (real ONNX embedder + real encrypted SQLite + real
 * retriever pipeline), so the §15.4 default flip lands against an already-
 * green target.
 *
 * Behavioral coverage per PRD `recall-lifecycle-wiring.md` §5.6:
 *   Group 1 (Retention Scorer wiring)
 *     1. Stage placement: `applyRetentionBoost` runs after `applyTimeDecay`
 *        and before `hardMinScore`, so a low-retention candidate can drop
 *        below `hardMinScore` while a healthy one survives.
 *     2. Multiplicative not additive: bundle ON re-orders results vs OFF
 *        (control), and the per-result `score` is the OFF score times a
 *        retention multiplier in [SEARCH_BOOST_MIN, 1.0].
 *     3. `tierFloorMode` arm divergence: `bare` and `withFloor` produce
 *        observably different scores for the same fixture.
 *   Group 2 (Tier Promoter wiring)
 *     5. Top-K bound: only the top `tierPromotionTopK` results have their
 *        tier evaluated; the (K+1)-th result keeps its seeded tier.
 *
 * Bundle-OFF control invariants the test ALSO locks down:
 *   - No tier writes on retrieval.
 *   - `auto-recall` source does NOT increment `accessCount`; manual source
 *     still does (preserves the pre-Phase-0 manual-only contract).
 * Bundle-ON expectations the test ALSO locks down:
 *   - `auto-recall` source DOES increment `accessCount`.
 *   - Tier transitions persisted to the metadata column.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_RECALL_LIFECYCLE,
	type RecallLifecycleConfig,
} from "../../../../packages/memory/config/index.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	createTierPromoter,
	type TierPromoter,
	type TierTransition,
} from "../../../../packages/memory/src/engine/operations/memory-tier-promoter.ts";
import { AccessTracker } from "../../../../packages/memory/src/engine/retrieval/access-tracker.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import type { MemoryRetrieverInternals } from "../../../../packages/memory/src/engine/retrieval/retriever-core.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import type { DecayScore } from "../../../../packages/memory/src/engine/shared/types.ts";
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
	retentionScorer: true,
	tierPromoter: true,
	autoRecallAccessTracking: true,
};

const BUNDLE_ON_WITH_FLOOR: RecallLifecycleConfig = {
	...BUNDLE_ON,
	tierFloorMode: "withFloor",
};

describe("Phase 1 retention bundle (Groups 1 + 2)", () => {
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
		// `applyRetentionBoost` + recency-skip gate read `this.config.recallLifecycle`,
		// while the access-tracker / tier-promoter gates read `this._recallLifecycle`
		// (set via `setRecallLifecycle`). Phase 0 wired the two source-of-truth
		// sites separately on purpose; the test pushes the same bundle into both
		// so the flag flip lands consistently.
		const retriever = createRetriever(store, testEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			temporalWeighting: true,
			rerank: "none",
			hardMinScore: 0,
			minScore: 0,
			recallLifecycle: lifecycle,
		}) as unknown as MemoryRetrieverInternals;
		retriever._recallLifecycle = lifecycle;
		retriever._tierPromoter = promoter ?? createTierPromoter();
		return retriever;
	}

	const QUERY_SUBJECT =
		"PostgreSQL multi-version concurrency control prevents readers from blocking writers.";
	const FIXTURE_TOPIC = "Postgres";

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

	it("§5.6 G1 (bundle ON vs OFF): retention multiplier shifts scores within [SEARCH_BOOST_MIN, 1.0]", async () => {
		const seeds = await seedQueryFixtureSet();

		const offRetriever = buildRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: false,
			tierPromoter: false,
		});
		const offResults = await offRetriever.retrieve({
			query: QUERY_SUBJECT,
			limit: seeds.length,
		});
		const offById = new Map(offResults.map((r) => [r.entry.id, r.score] as const));

		const onRetriever = buildRetriever(BUNDLE_ON);
		const onResults = await onRetriever.retrieve({
			query: QUERY_SUBJECT,
			limit: seeds.length,
		});

		// Both runs must surface a shared subset so per-id score comparison is well-defined.
		const shared = onResults.filter((r) => offById.has(r.entry.id));
		expect(shared.length).toBeGreaterThanOrEqual(2);

		let anyChanged = false;
		for (const r of shared) {
			const offScore = offById.get(r.entry.id);
			if (offScore === undefined) continue;
			// Bare-mode retention multiplier is in [SEARCH_BOOST_MIN=0.85, 1.0].
			// So bundle-ON score == OFF score * m, m ∈ [0.85, 1.0]. We allow a tiny
			// floating-point slack (1e-9 relative) on either bound.
			expect(r.score).toBeLessThanOrEqual(offScore + 1e-9);
			expect(r.score).toBeGreaterThanOrEqual(offScore * 0.85 - 1e-9);
			if (Math.abs(r.score - offScore) > 1e-6) anyChanged = true;
		}
		// At least one candidate's score must observably change — otherwise the
		// retention multiplier is a no-op and we'd be silently shipping OFF.
		expect(anyChanged).toBe(true);
	});

	it("§5.6 G1 stage placement: bundle ON + a hardMinScore floor drops a low-retention candidate that survives bundle OFF", async () => {
		// Two seeds: one fresh + frequent (high retention) and one ancient + cold
		// (low retention). Tier set equal so tier-floor isn't confounding.
		const fresh = await seed({
			text: `${FIXTURE_TOPIC} multi-version concurrency hot path.`,
			importance: 0.5,
			tier: "working",
			accessCount: 10,
			lastAccessedAt: Date.now() - 60_000,
		});
		const cold = await seed({
			text: `${FIXTURE_TOPIC} obscure historical replication command.`,
			importance: 0.5,
			tier: "working",
			accessCount: 0,
			lastAccessedAt: 0,
			timestampOffsetMs: 365 * 24 * 60 * 60 * 1000,
		});

		// Pick a hardMinScore that:
		//   - bundle OFF: both seeds clear (because retention multiplier is 1.0)
		//   - bundle ON:  the cold seed's score * retention_multiplier falls below
		// Run OFF first to get raw OFF scores, then place the floor between them.
		const probeOff = buildRetriever({
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: false,
			tierPromoter: false,
		});
		const probeResults = await probeOff.retrieve({
			query: QUERY_SUBJECT,
			limit: 5,
		});
		const offByIdProbe = new Map(probeResults.map((r) => [r.entry.id, r.score] as const));
		const offFresh = offByIdProbe.get(fresh.id);
		const offCold = offByIdProbe.get(cold.id);
		if (offFresh === undefined || offCold === undefined) {
			throw new Error("Both seeded candidates must be retrieved for the floor proof");
		}

		// Floor sits at 95% of the cold seed's OFF score — clears in OFF but the
		// retention multiplier (≤ 1.0, and substantially < 1.0 for an ancient
		// zero-access entry) pushes the bundle-ON score below it.
		const hardMin = offCold * 0.95;
		const onRetriever = createRetriever(store, testEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			temporalWeighting: true,
			rerank: "none",
			hardMinScore: hardMin,
			minScore: 0,
			recallLifecycle: BUNDLE_ON,
		}) as unknown as MemoryRetrieverInternals;
		onRetriever._recallLifecycle = BUNDLE_ON;
		onRetriever._tierPromoter = createTierPromoter();

		const offLifecycle: RecallLifecycleConfig = {
			...DEFAULT_RECALL_LIFECYCLE,
			retentionScorer: false,
			tierPromoter: false,
		};
		const offRetriever = createRetriever(store, testEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			temporalWeighting: true,
			rerank: "none",
			hardMinScore: hardMin,
			minScore: 0,
			recallLifecycle: offLifecycle,
		}) as unknown as MemoryRetrieverInternals;
		offRetriever._recallLifecycle = offLifecycle;

		const offFiltered = await offRetriever.retrieve({
			query: QUERY_SUBJECT,
			limit: 5,
		});
		const offIds = new Set(offFiltered.map((r) => r.entry.id));
		expect(offIds.has(fresh.id)).toBe(true);
		expect(offIds.has(cold.id)).toBe(true);

		const onFiltered = await onRetriever.retrieve({
			query: QUERY_SUBJECT,
			limit: 5,
		});
		const onIds = new Set(onFiltered.map((r) => r.entry.id));
		expect(onIds.has(fresh.id)).toBe(true);
		// The retention multiplier dropped `cold` below `hardMinScore`. If this
		// fails, the retention stage is running AFTER the floor (wrong slot) or
		// not running at all.
		expect(onIds.has(cold.id)).toBe(false);
	});

	it("§5.6 G1 tierFloorMode arm: `bare` and `withFloor` produce observably different scores", async () => {
		// Seed a peripheral entry with the cold-retention shape so the floor
		// matters: `bare` returns SEARCH_BOOST_MIN (0.3), `withFloor` clamps
		// against the peripheral tier floor.
		const peripheral = await seed({
			text: `${FIXTURE_TOPIC} obscure peripheral fact for tier-floor arm test.`,
			importance: 0.4,
			tier: "peripheral",
			accessCount: 0,
			lastAccessedAt: 0,
			timestampOffsetMs: 180 * 24 * 60 * 60 * 1000,
		});

		const bareR = buildRetriever(BUNDLE_ON);
		const floorR = buildRetriever(BUNDLE_ON_WITH_FLOOR);

		const bareResults = await bareR.retrieve({ query: QUERY_SUBJECT, limit: 5 });
		const floorResults = await floorR.retrieve({ query: QUERY_SUBJECT, limit: 5 });

		const bareScore = bareResults.find((r) => r.entry.id === peripheral.id)?.score;
		const floorScore = floorResults.find((r) => r.entry.id === peripheral.id)?.score;
		if (bareScore === undefined || floorScore === undefined) {
			throw new Error("The seeded candidate must be retrieved in both tier-floor arms");
		}
		// `withFloor` may clamp up OR down depending on tier; the contract is
		// only that the two arms are observably different on at least one
		// fixture. Equality here would mean the arm code path is dead.
		expect(Math.abs(bareScore - floorScore)).toBeGreaterThan(1e-6);
	});

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
			retentionScorer: false,
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
