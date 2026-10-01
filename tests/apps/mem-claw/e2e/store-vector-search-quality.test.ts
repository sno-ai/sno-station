/** @file store-vector-search-quality.test.ts
 * @purpose Measures semantic vector-search quality across clustered topics and nearest-neighbor expectations.
 * @boundary Embedder output, sqlite-vec search, MemoryStore ranking, and score observability.
 * @see precision-recall-fusion.test.ts, retriever-pipeline-bugs.test.ts, tool-memory-recall.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createEmbedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { f32ToBytes } from "../../../../packages/memory/src/engine/shared/utils.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

const STATE_DIR = `/tmp/mem-claw-vec-state-${Date.now()}`;

function vectorWithOffset(offset: number): Float32Array {
	const vector = new Float32Array(1024);
	vector[0] = 1;
	vector[1] = offset;
	return vector;
}

function insertChunkVector(
	store: MemoryStore,
	args: { memoryId: string; projectId: string; text: string; vector: Float32Array },
): void {
	const now = Date.now();
	const chunkId = `${args.memoryId}:chunk:0`;
	store.sqlite
		.prepare(
			"INSERT INTO nodix_memories (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id) VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?)",
		)
		.run(
			args.memoryId,
			args.text,
			"episodic",
			args.projectId,
			0.7,
			now,
			"{}",
			`hash:${args.memoryId}`,
			`fact:${args.memoryId}`,
		);
	store.sqlite
		.prepare(
			"INSERT INTO nodix_memory_chunks (chunk_id, memory_id, chunk_index, chunk_text, dense_payload, summary, entities, tags, source, start_offset, end_offset, token_count, content_type, chunking_version, embedder_provider, embedder_model, embedder_dim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			chunkId,
			args.memoryId,
			0,
			args.text,
			args.text,
			null,
			null,
			null,
			null,
			0,
			args.text.length,
			1,
			"prose",
			"test-chunking-version",
			"test-provider",
			"test-model",
			1024,
			now,
			now,
		);
	store.sqlite
		.prepare("INSERT INTO nodix_memory_chunk_vectors(id, project_id, embedding) VALUES (?, ?, vec_f32(?))")
		.run(chunkId, args.projectId, f32ToBytes(args.vector));
}

/**
 * Vector search quality: 30 memories across 5 topics.
 * For each topic query, top-3 results must all belong to the correct topic.
 * Required recall ≥ 80% across 5 queries.
 */
beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("store vector search quality", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({
			dbPath,
			embedder: testEmbedder,
			memoryTelemetry: { enabled: false },
		});
	});

	afterEach(() => {
		store.close();
		cleanup();
	});

	it("top-3 results per topic are all correct topic (>80% recall across 5 topics)", async () => {
		const embedder = createEmbedder(
			{
				dimensions: 1024,
			},
			STATE_DIR,
		);

		// 5 topics × 6 memories each = 30 total
		const topicData: Array<{ topic: string; texts: string[]; query: string }> =
			[
				{
					topic: "rust-programming",
					query: "Rust ownership and borrowing system",
					texts: [
						"Rust's ownership system prevents data races at compile time without garbage collection.",
						"The borrow checker in Rust ensures memory safety through static analysis.",
						"Rust uses lifetimes to express the scope of references in the type system.",
						"Zero-cost abstractions in Rust allow high-level code with low-level performance.",
						"Rust's pattern matching is exhaustive and enforced by the compiler.",
						"The Rust standard library provides safe abstractions over unsafe system calls.",
					],
				},
				{
					topic: "machine-learning",
					query: "Neural network training and backpropagation",
					texts: [
						"Backpropagation computes gradients by applying the chain rule through layers.",
						"Stochastic gradient descent updates model weights using mini-batches of data.",
						"Dropout regularization prevents overfitting by randomly zeroing activations.",
						"Batch normalization accelerates training by normalizing layer inputs.",
						"The Adam optimizer combines momentum and adaptive learning rates for convergence.",
						"Convolutional neural networks excel at spatial feature extraction from images.",
					],
				},
				{
					topic: "database-design",
					query: "Database normalization and ACID transactions",
					texts: [
						"Third normal form eliminates transitive dependencies in relational schemas.",
						"ACID transactions guarantee atomicity, consistency, isolation, and durability.",
						"Index covering queries allows the database to serve results from the index alone.",
						"Denormalization trades redundancy for query performance in read-heavy workloads.",
						"Foreign keys enforce referential integrity between related tables in RDBMS.",
						"Database sharding distributes data across multiple nodes for horizontal scaling.",
					],
				},
				{
					topic: "docker-containers",
					query: "Docker containers and Kubernetes orchestration",
					texts: [
						"Docker containers package applications with their dependencies into portable images.",
						"Kubernetes orchestrates container scheduling and scaling across a cluster of nodes.",
						"Container networking via overlay networks enables cross-host pod communication.",
						"Docker volumes persist data independently from container lifecycle.",
						"Helm charts provide templated Kubernetes manifests for application deployment.",
						"Resource limits in Kubernetes prevent noisy neighbor problems in shared clusters.",
					],
				},
				{
					topic: "cryptography",
					query: "Public key cryptography and digital signatures",
					texts: [
						"RSA encryption relies on the computational hardness of integer factorization.",
						"Elliptic curve cryptography provides equivalent security with smaller key sizes.",
						"Digital signatures use asymmetric keys to authenticate message origin and integrity.",
						"Hash functions produce fixed-length digests that are collision-resistant.",
						"TLS 1.3 removed weak cipher suites and mandatory forward secrecy.",
						"Zero-knowledge proofs allow proving knowledge without revealing the secret itself.",
					],
				},
			];

		// Store all 30 memories with production embeddings
		const allTexts = topicData.flatMap((t) => t.texts);
		const allVectors = await embedder.embedMany(allTexts);
		const storedTopics: Array<{ id: string; topic: string }> = [];

		let vectorIdx = 0;
		for (const topicEntry of topicData) {
			for (const text of topicEntry.texts) {
				const vector = allVectors[vectorIdx];
				if (!vector) throw new Error(`Missing vector at index ${vectorIdx}`);
				const stored = await store.store({
					text,
					vector,
					category: "episodic",
					projectId: "global",
				});
				storedTopics.push({ id: stored.id, topic: topicEntry.topic });
				vectorIdx++;
			}
		}

		expect((await store.stats()).total).toBe(30);

		// Build a lookup map from id to topic
		const idToTopic = new Map<string, string>();
		for (const entry of storedTopics) {
			idToTopic.set(entry.id, entry.topic);
		}

		// Run a semantic search for each topic query, check top-3 precision
		let totalCorrect = 0;
		let totalChecked = 0;

		for (const topicEntry of topicData) {
			const queryVector = await embedder.embed(topicEntry.query);
			const results = await store.searchSemantic(queryVector, {
				limit: 3,
				minScore: 0,
			});

			for (const result of results.slice(0, 3)) {
				const predictedTopic = idToTopic.get(result.entry.id);
				if (predictedTopic === topicEntry.topic) {
					totalCorrect++;
				}
				totalChecked++;
			}
		}

		// Require ≥ 80% recall: at least 12 of 15 top-3 results are correct
		const recallRate = totalCorrect / totalChecked;
		expect(recallRate).toBeGreaterThanOrEqual(0.8);
	});

	it("finds a project-scoped chunk even when other projects dominate the nearest neighbors", async () => {
		// Before Phase D (vec0 project_id PARTITION KEY, 2026-07-13), this
		// scenario relied on the candidate-budget growth loop expanding past a
		// global scan polluted by closer out-of-project neighbors. The KNN query
		// is now project-scoped from the first call, so noise-project vectors
		// never enter the candidate pool at all — no expansion needed.
		for (let i = 0; i < 64; i++) {
			insertChunkVector(store, {
				memoryId: `noise-${i}`,
				projectId: "noise-project",
				text: `Out-of-scope vector neighbor ${i}`,
				vector: vectorWithOffset(i * 0.001),
			});
		}
		insertChunkVector(store, {
			memoryId: "target-1",
			projectId: "target-project",
			text: "In-scope vector neighbor after the initial global candidate cutoff",
			vector: vectorWithOffset(0.1),
		});

		const results = await store.searchChunksSemantic(vectorWithOffset(0), {
			limit: 1,
			minScore: 0,
			projectIdFilter: ["target-project"],
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.parentMemoryId).toBe("target-1");
	});
});
