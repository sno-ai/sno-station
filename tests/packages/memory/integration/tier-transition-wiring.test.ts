/** Real ONNX embedder + real encrypted SQLite. No mocking. Missing deps = FAIL. */

/**
 * Tier transitioner wiring (Phase 0 §5, openspec/changes/mem-lifecycle/tasks.md).
 *
 * Asserts the WIRING contract — not the promotion algorithm itself
 * (memory-tier-promoter unit tests own that).
 *
 *  §5.1 — recallLifecycle.tierPromoter=false → zero tier writes on retrieval
 *  §5.3 — per-item evaluator failure must not block sibling persistence
 *  §5.4 — persisted transition preserves embedding row + every metadata field
 *         OTHER THAN tier, byte-for-byte
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RECALL_LIFECYCLE } from "../../../../packages/sno-station-mem/config/index.ts";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import {
	createTierPromoter,
	type TierPromoter,
	type TierTransition,
} from "../../../../packages/sno-station-mem/src/engine/operations/memory-tier-promoter.ts";
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

interface SeededRow {
	id: string;
	metadataRaw: string;
	embeddingRow: Buffer | null;
}

async function readMetadataRaw(store: MemoryStore, id: string): Promise<string> {
	const sqlite = (store as unknown as { sqlite: import("better-sqlite3").Database }).sqlite;
	const row = sqlite
		.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
		.get(id) as { metadata: string | null } | undefined;
	return row?.metadata ?? "";
}

async function readChunkVectorRow(
	store: MemoryStore,
	memoryId: string,
): Promise<Buffer | null> {
	const sqlite = (store as unknown as { sqlite: import("better-sqlite3").Database }).sqlite;
	const row = sqlite
		.prepare(
			`SELECT v.embedding AS embedding
			 FROM nodix_memory_chunk_vectors v
			 JOIN nodix_memory_chunks c ON c.chunk_id = v.id
			 WHERE c.memory_id = ?
			 ORDER BY c.chunk_index ASC
			 LIMIT 1`,
		)
		.get(memoryId) as { embedding: Buffer | null } | undefined;
	return row?.embedding ?? null;
}

describe("Tier transitioner wiring (Phase 0 §5)", () => {
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
		stateDir = mkdtempSync(join(tmpdir(), "mem-claw-tier-wire-"));
		prevStateDir = process.env.OPENCLAW_STATE_DIR;
		process.env.OPENCLAW_STATE_DIR = stateDir;
	});

	afterEach(() => {
		store.close();
		cleanup();
		rmSync(stateDir, { recursive: true, force: true });
		if (prevStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = prevStateDir;
	});

	async function seed(text: string, importance = 0.5): Promise<SeededRow> {
		const vector = await testEmbedder.embed(text);
		const stored = await store.store({
			text,
			vector,
			category: "episodic",
			projectId: "global",
			importance,
		});
		const metadataRaw = await readMetadataRaw(store, stored.id);
		const embeddingRow = await readChunkVectorRow(store, stored.id);
		return { id: stored.id, metadataRaw, embeddingRow };
	}

	it("§5.1 — flag OFF: retrieval does not write tier (metadata byte-for-byte unchanged)", async () => {
		const seeded = await seed("TypeScript strict mode catches null errors at compile time.");

		const retriever = createRetriever(store, testEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			hardMinScore: 0,
			minScore: 0,
		});
		(retriever as unknown as MemoryRetrieverInternals)._recallLifecycle = {
			...DEFAULT_RECALL_LIFECYCLE,
			tierPromoter: false,
		};
		(retriever as unknown as MemoryRetrieverInternals)._tierPromoter = createTierPromoter();

		const results = await retriever.retrieve({
			query: "TypeScript strict mode",
			limit: 5,
		});
		expect(results.length).toBeGreaterThan(0);

		const after = await readMetadataRaw(store, seeded.id);
		expect(after).toBe(seeded.metadataRaw);
	});

	it("§5.3 — per-item evaluator failure isolates: siblings still persist", async () => {
		const a = await seed("Postgres uses MVCC for transaction isolation.");
		const b = await seed("Postgres autovacuum reclaims dead tuples in the background.");
		const c = await seed("Postgres write-ahead logging guarantees crash recovery.");
		// Seed each row at `peripheral` so the forced `working` transition is a
		// real tier change, not a no-op same-tier write.
		for (const id of [a.id, b.id, c.id]) {
			await store.updateMetadata(id, { tier: "peripheral" });
		}

		// Build a promoter that throws for id `b` and returns a `peripheral→working`
		// promotion for every other top-K id. The wiring contract requires per-item
		// try/catch so sibling persistence is not blocked by one bad evaluation.
		const throwingPromoter: TierPromoter = {
			evaluate(memory, _score, _now): TierTransition | null {
				if (memory.id === b.id) throw new Error("synthetic evaluator failure");
				return {
					memoryId: memory.id,
					fromTier: memory.tier,
					toTier: "working",
					reason: "test forced",
				};
			},
			evaluateAll(memories, decayScores, now) {
				const map = new Map(decayScores.map((s: DecayScore) => [s.memoryId, s]));
				const out: TierTransition[] = [];
				for (const m of memories) {
					const s = map.get(m.id);
					if (!s) continue;
					try {
						const t = this.evaluate(m, s, now);
						if (t) out.push(t);
					} catch {
						/* tolerated */
					}
				}
				return out;
			},
		};

		const retriever = createRetriever(store, testEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			hardMinScore: 0,
			minScore: 0,
		});
		(retriever as unknown as MemoryRetrieverInternals)._recallLifecycle = {
			...DEFAULT_RECALL_LIFECYCLE,
			tierPromoter: true,
		};
		(retriever as unknown as MemoryRetrieverInternals)._tierPromoter = throwingPromoter;

		const results = await retriever.retrieve({
			query: "Postgres database internals",
			limit: 5,
		});
		const ids = new Set(results.map((r) => r.entry.id));
		expect(ids.has(a.id) || ids.has(b.id) || ids.has(c.id)).toBe(true);

		const aMeta = JSON.parse((await readMetadataRaw(store, a.id)) || "{}") as {
			tier?: string;
		};
		const cMeta = JSON.parse((await readMetadataRaw(store, c.id)) || "{}") as {
			tier?: string;
		};
		const bMeta = JSON.parse((await readMetadataRaw(store, b.id)) || "{}") as {
			tier?: string;
		};

		// `a` and `c` must reach `working` if they were in the top-K (they will be
		// — only 3 entries exist and limit=5 returns them all). The throwing item
		// `b` must not have moved beyond its seeded `peripheral`.
		expect(aMeta.tier).toBe("working");
		expect(cMeta.tier).toBe("working");
		expect(bMeta.tier).toBe("peripheral");
	});

	it("§5.4 — persisted transition preserves embedding row + non-tier metadata byte-for-byte", async () => {
		const seeded = await seed("Redis cluster shards data across primary nodes by hash slot.");

		// Seed a richer metadata blob first so we can assert preservation of arbitrary fields.
		await store.updateMetadata(seeded.id, {
			accessCount: 7,
			lastAccessedAt: 1700000000000,
			last_bad_recall_at: 1699999999999,
			intrinsic: { confidence: 0.81, importance: 0.55 },
		});
		const beforeMeta = JSON.parse(await readMetadataRaw(store, seeded.id)) as Record<
			string,
			unknown
		>;
		const beforeEmbedding = await readChunkVectorRow(store, seeded.id);

		const promoter: TierPromoter = {
			evaluate(memory): TierTransition | null {
				return {
					memoryId: memory.id,
					fromTier: memory.tier,
					toTier: "core",
					reason: "test forced",
				};
			},
			evaluateAll() {
				return [];
			},
		};

		const retriever = createRetriever(store, testEmbedder, { warn: () => {} }, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			hardMinScore: 0,
			minScore: 0,
		});
		(retriever as unknown as MemoryRetrieverInternals)._recallLifecycle = {
			...DEFAULT_RECALL_LIFECYCLE,
			tierPromoter: true,
		};
		(retriever as unknown as MemoryRetrieverInternals)._tierPromoter = promoter;

		const results = await retriever.retrieve({
			query: "Redis cluster sharding",
			limit: 3,
		});
		expect(results.some((r) => r.entry.id === seeded.id)).toBe(true);

		const afterMeta = JSON.parse(await readMetadataRaw(store, seeded.id)) as Record<
			string,
			unknown
		>;
		const afterEmbedding = await readChunkVectorRow(store, seeded.id);

		// Embedding row preserved byte-for-byte.
		if (beforeEmbedding === null || afterEmbedding === null) {
			throw new Error("embedding row missing — chunk vec not persisted");
		}
		expect(afterEmbedding.equals(beforeEmbedding)).toBe(true);

		// Tier moved.
		expect(afterMeta.tier).toBe("core");

		// Every non-tier key preserved byte-for-byte.
		for (const key of Object.keys(beforeMeta)) {
			if (key === "tier") continue;
			expect(JSON.stringify(afterMeta[key])).toBe(JSON.stringify(beforeMeta[key]));
		}
	});
});
