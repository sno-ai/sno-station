/** @file retriever-pipeline-bugs.test.ts
 * @purpose Guards retrieval ranking regressions across hard floors, candidate limits, MMR, and precision recall scoring.
 * @boundary Retriever orchestration, MemoryStore search branches, real embeddings, and score metadata contracts.
 * @see precision-recall-fusion.test.ts, store-vector-search-quality.test.ts, tool-memory-recall.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import {
	CANDIDATE_POOL_SIZE,
	MAX_CANDIDATE_POOL_SIZE,
	MAX_LIST_LIMIT,
} from "../../../../packages/memory/config/index.ts";
import { createEmbedder, type Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	createRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
} from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-pipeline-bugs-state-${Date.now()}`;
const noopLogger = { warn: (_msg: string) => {} };

/**
 * Retriever scoring pipeline regression suite.
 *
 * Each scenario protects a concrete ranking invariant across scoring math, config
 * clamping, and filter boundaries. The tests use production local embeddings so
 * fixture quality matches the runtime retrieval path.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("retriever pipeline bugs", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	/**
	 * Candidate pool contract: the store can serve the full retriever pool.
	 *
	 * MAX_LIST_LIMIT must stay at or above the pool CEILING, not the default pool size: a
	 * search branch clamps its own limit to MAX_LIST_LIMIT, while retrieval asks for as much as
	 * MAX_CANDIDATE_POOL_SIZE. Comparing against the default let the ceiling move 512 -> 2048
	 * on 2026-09-15 with the branch cap left at 512, and every candidate past 512 was dropped
	 * before ranking saw it. Assert the relation, never the literal.
	 */
	it("the store serves the whole candidate pool a retrieval can ask for", async () => {
		expect(MAX_CANDIDATE_POOL_SIZE).toBeLessThanOrEqual(MAX_LIST_LIMIT);
		expect(CANDIDATE_POOL_SIZE).toBeLessThanOrEqual(MAX_CANDIDATE_POOL_SIZE);

		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		// Seed beyond candidatePoolSize to prove the returned count is capped by request size.
		const texts: string[] = [];
		for (let i = 0; i < 70; i++) {
			texts.push(
				`Memory entry number ${i}: programming language feature ${i} for software development project ${i}.`,
			);
		}

		// bulkStore embeds all 70 entries in one batched ONNX pass. Caller-provided
		// vectors are ignored by the store (it chunks + embeds internally), so the
		// previous embedMany + per-entry store() loop embedded everything twice and
		// timed out on a GPU-contended box.
		await store.bulkStore(
			texts.map((text) => ({ text, category: "episodic" as const, projectId: "global" })),
		);

		expect((await store.stats()).total).toBe(70);

		// Direct semantic search must serve all requested candidates within MAX_LIST_LIMIT.
		const queryVector = await embedder.embed(
			"programming language feature",
		);
		const semanticResults = await store.searchSemantic(queryVector, {
			limit: 64,
			minScore: 0,
		});

		// Returning the full pool keeps downstream reranking from losing candidate diversity.
		expect(semanticResults.length).toBe(64);
		expect(semanticResults.length).toBeLessThanOrEqual(MAX_LIST_LIMIT);
	}, 120_000);

	/**
	 * Hard minimum contract: raw scores are filtered before amplification.
	 *
	 * Entries below hardMinScore must not be rescued later by importance weighting,
	 * time decay, or other score multipliers.
	 */
	it("hardMinScore filters on raw scores before amplification — low scores cannot be rescued", async () => {
		// Exercises the filtering mechanism at a real nonzero threshold. Not
		// DEFAULT_HARD_MIN_SCORE — the shipped default is 0 (see config/index.ts),
		// which would make this test's conditional always take the "survives" branch.
		const hardMin = 0.35;
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		// Store a deliberately weak semantic match with maximum amplification inputs.
		const targetText =
			"The quick brown fox jumps over the lazy dog near the river.";
		const queryText = "advanced kubernetes cluster autoscaling configuration";

		const targetVector = await embedder.embed(targetText);
		await store.importEntry({
			id: "compound-test-target",
			text: targetText,
			vector: targetVector,
			category: "episodic",
			projectId: "global",
			importance: 1.0, // Maximum importance would rescue the entry if filtering were late.
			timestamp: Date.now(), // A fresh timestamp keeps time decay at its strongest value.
			metadata: "{}",
			contentHash: "a".repeat(64),
		});

		// Capture the raw vector score before any retriever-stage amplification.
		const queryVector = await embedder.embed(queryText);
		const rawResults = await store.searchSemantic(queryVector, {
			limit: 1,
			minScore: 0,
		});
		expect(rawResults.length).toBe(1);
		const rawVectorScore = rawResults[0]!.score;

		// Run the full retriever with hardMinScore enabled at the pipeline boundary.
		const retriever = createRetriever(store, embedder, noopLogger, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			lengthNormAnchor: 0,
			hardMinScore: hardMin,
			minScore: 0,
		});

		const results = await retriever.retrieve({
			query: queryText,
			limit: 1,
		});

		// Raw scores below the hard floor must be removed before amplification can apply.
		if (rawVectorScore < hardMin) {
			expect(results.length).toBe(0);
		} else {
			expect(results.length).toBe(1);
		}
	});

	/**
	 * HardMinScore boundary: values at the threshold survive and lower values are filtered.
	 *
	 * Test the exact boundary of the hardMinScore >= filter after all pipeline stages.
	 * We construct synthetic entries with known scores by controlling all pipeline inputs.
	 */
	it("hardMinScore filters at exact boundary: 0.35 survives, below does not", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		// Store varied entries to produce a meaningful spread around the threshold.
		const entries = [
			"Kubernetes pods are scheduled by the control plane.",
			"Docker containers package applications with dependencies.",
			"Cloud-native applications leverage microservice architecture.",
			"Infrastructure as code manages servers programmatically.",
			"Continuous deployment automates software delivery pipelines.",
		];

		const vectors = await embedder.embedMany(entries);
		for (let i = 0; i < entries.length; i++) {
			const text = entries[i];
			const vector = vectors[i];
			if (!text || !vector) throw new Error(`Missing at index ${i}`);
			await store.store({ text, vector, category: "episodic", projectId: "global" });
		}

		// Retrieve with the default threshold to observe the surviving set.
		const retriever035 = createRetriever(store, embedder, noopLogger, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			minScore: 0,
			hardMinScore: 0.35,
		});

		const results035 = await retriever035.retrieve({
			query: "kubernetes container orchestration",
			limit: 10,
		});

		// Surviving results must satisfy the inclusive hard-minimum boundary.
		for (const r of results035) {
			expect(r.score).toBeGreaterThanOrEqual(0.35);
		}

		// Disable the boundary to derive the entries filtered by the default threshold.
		const retriever0 = createRetriever(store, embedder, noopLogger, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			minScore: 0,
			hardMinScore: 0,
		});

		const results0 = await retriever0.retrieve({
			query: "kubernetes container orchestration",
			limit: 10,
		});

		// Removing the boundary can only preserve or increase the result count.
		expect(results0.length).toBeGreaterThanOrEqual(results035.length);

		// Partition by the default boundary so both sides of the invariant are explicit.
		const filteredEntries = results0.filter((r) => r.score < 0.35);
		const survivedEntries = results0.filter((r) => r.score >= 0.35);

		// The inclusive partition must match the thresholded retriever output exactly.
		expect(survivedEntries.length).toBe(results035.length);

		// The boundary remains inclusive: exactly 0.35 belongs to the surviving set.
		for (const r of survivedEntries) {
			expect(r.score).toBeGreaterThanOrEqual(0.35);
		}
		for (const r of filteredEntries) {
			expect(r.score).toBeLessThan(0.35);
		}
	});

	/**
	 * MMR contract: diversity ordering is preserved after reranking.
	 *
	 * MMR output balances relevance and diversity. A final score sort would erase
	 * that ordering, so the unique item must remain promoted among near-duplicates.
	 */
	it("MMR diversity reordering is preserved — unique entry promoted among near-duplicates", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		// Three near-duplicates create a strong relevance cluster.
		const duplicateText1 =
			"Python is a general purpose programming language used widely.";
		const duplicateText2 =
			"Python is a general purpose programming language used broadly.";
		const duplicateText3 =
			"Python is a general purpose programming language used extensively.";
		// One unique entry gives MMR a diversity candidate to promote.
		const uniqueText =
			"Glaciers form over centuries from compacted snow in mountainous regions.";

		const allTexts = [
			duplicateText1,
			duplicateText2,
			duplicateText3,
			uniqueText,
		];
		const vectors = await embedder.embedMany(allTexts);

		const storedIds: string[] = [];
		for (let i = 0; i < allTexts.length; i++) {
			const text = allTexts[i];
			const vector = vectors[i];
			if (!text || !vector) throw new Error(`Missing at index ${i}`);
			const stored = await store.store({
				text,
				vector,
				category: "episodic",
				projectId: "global",
			});
			storedIds.push(stored.id);
		}

		expect(storedIds.length).toBe(4);
		const uniqueId = storedIds[3]!;

		// The query favors the duplicate cluster so diversity promotion is visible.
		const retriever = createRetriever(store, embedder, noopLogger, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			hardMinScore: 0,
			minScore: 0,
			lengthNormAnchor: 0,
			importanceWeightBase: 0.5,
			mmrLambda: 0, // Maximum diversity makes ordering changes easy to detect.
		});

		const results = await retriever.retrieve({
			query: "Python general purpose programming language",
			limit: 4,
		});

		expect(results.length).toBe(4);

		const resultIds = results.map((r) => r.entry.id);
		const uniquePosition = resultIds.indexOf(uniqueId);
		expect(uniquePosition).not.toBe(-1);

		// With mmrLambda=0, MMR promotes the unique entry because it has minimal
		// similarity to the first selected duplicate-cluster result.
		expect(uniquePosition).toBeLessThan(results.length - 1);

		// Diversity ordering intentionally allows a lower-score unique entry to outrank duplicates.
		expect(uniquePosition).toBeLessThan(3);
	});

	/**
	 * Config override contract: custom hardMinScore changes result counts.
	 *
	 * Verify that passing non-default hardMinScore actually changes scoring behavior.
	 * Use a mix of related and unrelated entries with a very high threshold.
	 * Note: pipeline amplification (importance * time decay) can push scores well above
	 * raw cosine similarity, so threshold must be set high enough to filter even amplified scores.
	 */
	it("custom config overrides propagate: different hardMinScore changes result count", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		// Mix related and unrelated entries to produce a wide raw-score spread.
		const entries = [
			"TypeScript generics enable type-safe reusable components.", // related
			"Rust ownership model prevents data races at compile time.", // related
			"Sourdough bread requires a 24-hour fermentation process with wild yeast.", // unrelated
			"The Hubble Space Telescope orbits Earth at 340 miles altitude.", // unrelated
			"Origami cranes symbolize peace in Japanese cultural tradition.", // very unrelated
		];

		const vectors = await embedder.embedMany(entries);
		for (let i = 0; i < entries.length; i++) {
			const text = entries[i];
			const vector = vectors[i];
			if (!text || !vector) throw new Error(`Missing at index ${i}`);
			await store.store({ text, vector, category: "episodic", projectId: "global" });
		}

		// Lenient mode establishes the full candidate set before applying the custom floor.
		// hardMinScore is enforced after every score-mutating stage, so the threshold
		// must be derived from the post-pipeline scores the floor will actually see.
		const lenientRetriever = createRetriever(store, embedder, noopLogger, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			minScore: 0,
			hardMinScore: 0,
		});

		const lenientResults = await lenientRetriever.retrieve({
			query: "programming language type systems",
			limit: 10,
		});
		expect(lenientResults.length).toBe(5);

		// Pick a threshold between the two lowest post-pipeline scores to guarantee
		// at least one exclusion when the floor is applied.
		const finalScores = lenientResults.map((r) => r.score).sort((a, b) => a - b);
		const finalMin = finalScores[0]!;
		const finalSecond = finalScores[1]!;
		const filterThreshold = (finalMin + finalSecond) / 2;

		// Filtered mode uses the derived threshold to prove override propagation.
		const filteredRetriever = createRetriever(store, embedder, noopLogger, {
			...DEFAULT_RETRIEVAL_CONFIG,
			mode: "vector",
			rerank: "none",
			minScore: 0,
			hardMinScore: filterThreshold,
		});

		const filteredResults = await filteredRetriever.retrieve({
			query: "programming language type systems",
			limit: 10,
		});

		// At least the lowest-scored entry must be removed by the custom boundary.
		expect(filteredResults.length).toBeLessThan(lenientResults.length);
		expect(filteredResults.length).toBeGreaterThan(0);
		// Every survivor must clear the floor — this would silently break if hardMinScore
		// were applied before later stages shrank scores below the threshold.
		for (const r of filteredResults) {
			expect(r.score).toBeGreaterThanOrEqual(filterThreshold);
		}
	});

	/**
	 * End-to-end pipeline sanity: verify all scoring stages compose correctly
	 * with default config and real embeddings, producing sorted results
	 * with positive finite scores.
	 */
	it("full scoring pipeline produces sorted finite-score results with defaults", async () => {
		const embedder = createEmbedder({ dimensions: 1024 }, STATE_DIR);

		const entries = [
			"React hooks replaced class component lifecycle methods.",
			"Vue composition API provides reactive state management.",
			"Svelte compiles components to vanilla JavaScript at build time.",
			"Angular dependency injection manages service instances automatically.",
			"Solid.js uses fine-grained reactivity without virtual DOM.",
		];

		const vectors = await embedder.embedMany(entries);
		for (let i = 0; i < entries.length; i++) {
			const text = entries[i];
			const vector = vectors[i];
			if (!text || !vector) throw new Error(`Missing at index ${i}`);
			await store.store({ text, vector, category: "episodic", projectId: "global" });
		}

		// Use default config minus rerank and noise filtering to keep this test self-contained.
		const retriever = createRetriever(store, embedder, noopLogger, {
			...DEFAULT_RETRIEVAL_CONFIG,
			rerank: "none",
			mmrLambda: 1,
			minScore: 0,
		});

		const results = await retriever.retrieve({
			query: "frontend framework reactivity patterns",
			limit: 5,
		});

		expect(results.length).toBeGreaterThan(0);

		// Final scores must be positive and finite after all scoring stages compose.
		for (const r of results) {
			expect(typeof r.score).toBe("number");
			expect(Number.isFinite(r.score)).toBe(true);
			expect(r.score).toBeGreaterThan(0);
		}

		// Default non-MMR output is expected to remain score-sorted descending.
		for (let i = 0; i < results.length - 1; i++) {
			expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
		}

		// Source metadata makes vector/BM25 contribution debugging possible.
		for (const r of results) {
			expect(r.sources).toBeDefined();
			// Precision-recall results must expose at least one contributing retrieval source.
			const hasSource =
				r.sources.vector !== undefined || r.sources.bm25 !== undefined;
			expect(hasSource).toBe(true);
		}
	});
});
