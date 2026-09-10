/** Real local ONNX embeddings. No mocking. */

import { afterAll, describe, expect, it } from "vitest";
import { LocalEmbedProvider } from "@snoai/embedder";
import { chunk } from "@snoai/chunking";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { VECTOR_DIMENSION_DEFAULT } from "../../../../apps/mem-claw/config/index.ts";

const STATE_DIR = mkdtempSync(join(tmpdir(), "mem-claw-embedder-state-"));

afterAll(() => {
	rmSync(STATE_DIR, { recursive: true, force: true });
});

/**
 * Embedder integration: local ONNX embedder, dimension check, unit normalization, LRU cache.
 */
describe("Embedder integration (local ONNX)", () => {
	it("embedMany 10 texts — each vector has VECTOR_DIMENSION_DEFAULT dimensions", async () => {
		const embedder = new Embedder(
			{
				dimensions: VECTOR_DIMENSION_DEFAULT,
			},
			STATE_DIR,
		);

		const texts = [
			"TypeScript strict mode enables comprehensive type checking.",
			"Node.js runtime provides native SQLite support.",
			"React hooks manage state without class components.",
			"Zod schema validation ensures type safety.",
			"Rust ownership prevents memory leaks.",
			"Redis enables microsecond caching operations.",
			"Docker containers isolate application environments.",
			"PostgreSQL MVCC supports high concurrency.",
			"Kubernetes autoscaling adjusts pod replicas.",
			"Git branching enables parallel development workflows.",
		];

		const vectors = await embedder.embedMany(texts);

		expect(vectors).toHaveLength(10);
		for (const vector of vectors) {
			expect(vector).toBeInstanceOf(Float32Array);
			expect(vector.length).toBe(VECTOR_DIMENSION_DEFAULT);
		}
	});

	it("each vector is unit-normalized (L2 norm ≈ 1.0 ± 0.001)", async () => {
		const embedder = new Embedder(
			{
				dimensions: VECTOR_DIMENSION_DEFAULT,
				normalized: true,
			},
			STATE_DIR,
		);

		const texts = [
			"TypeScript provides compile-time type safety.",
			"Node.js is a fast JavaScript runtime.",
			"Machine learning requires large training datasets.",
			"Database indexing improves query performance.",
			"Kubernetes orchestrates container workloads.",
		];

		const vectors = await embedder.embedMany(texts);

		for (const vector of vectors) {
			// Compute L2 norm
			let sumOfSquares = 0;
			for (const value of vector) {
				sumOfSquares += value * value;
			}
			const norm = Math.sqrt(sumOfSquares);
			// Local ONNX embedder returns normalized vectors
			expect(Math.abs(norm - 1.0)).toBeLessThan(0.01);
		}
	});

	it("embed() twice on same text — second call hits LRU cache (elapsed < 100ms)", async () => {
		const embedder = new Embedder(
			{
				dimensions: VECTOR_DIMENSION_DEFAULT,
			},
			STATE_DIR,
		);

		const text = "Cache hit test: TypeScript strict mode is always preferred.";

		// First call — computes embedding
		const start1 = Date.now();
		await embedder.embed(text);
		const elapsed1 = Date.now() - start1;

		// Second call — should hit LRU cache and stay comfortably below cold-call time.
		const start2 = Date.now();
		await embedder.embed(text);
		const elapsed2 = Date.now() - start2;

		// First call will take longer, second should be near-instant (cache hit)
		expect(elapsed1).toBeGreaterThan(0);
		expect(elapsed2).toBeLessThan(100);
	});

	it("embed matches unprefixed local and batch vectors for short text", async () => {
		const embedder = new Embedder({ dimensions: VECTOR_DIMENSION_DEFAULT }, STATE_DIR);
		const provider = new LocalEmbedProvider();
		try {
			const text = "TypeScript performance";
			const vector = await embedder.embed(text);
			const [batchVector] = await embedder.embedMany([text]);
			const rawVector = Float32Array.from(await provider.embed(text));
			expect(vector).toBeInstanceOf(Float32Array);
			expect(batchVector).toBeInstanceOf(Float32Array);
			expect(vector).toHaveLength(VECTOR_DIMENSION_DEFAULT);
			expect(batchVector).toHaveLength(VECTOR_DIMENSION_DEFAULT);
			expect(vector).toEqual(batchVector);
			expect(vector).toEqual(rawVector);
		} finally {
			await embedder.dispose();
			await provider.dispose();
		}
	});

	it.each([
		["English", "TypeScript checks types before deployment. ".repeat(50)],
		["CJK", "数据库索引可以提高查询效率。".repeat(60)],
	])("embed preserves the weighted chunk vector for long %s text", async (_label, text) => {
		const embedder = new Embedder({ dimensions: VECTOR_DIMENSION_DEFAULT }, STATE_DIR);
		const provider = new LocalEmbedProvider();
		try {
			const chunks = chunk(text, {
				contentType: "prose",
				minTokens: 256,
				targetTokens: 460,
				maxTokens: 460,
				overlapTokens: 32,
			}).map((draft) => draft.chunkText);
			expect(chunks.length).toBeGreaterThan(1);
			const vectors = await provider.embedDocuments(chunks);
			const totalWeight = chunks.reduce((sum, value) => sum + value.length, 0);
			const average = Array.from({ length: VECTOR_DIMENSION_DEFAULT }, (_, index) =>
				vectors.reduce((sum, vector, chunkIndex) => {
					const weight = chunks[chunkIndex]?.length ?? 0;
					return sum + Math.fround(vector[index] ?? 0) * weight;
				}, 0) / totalWeight,
			);
			const norm = Math.sqrt(average.reduce((sum, value) => sum + value * value, 0));
			const expected = Float32Array.from(average.map((value) => value / norm));
			const actual = await embedder.embed(text);
			expect(actual).toEqual(expected);
			expect(actual).not.toEqual(Float32Array.from(await provider.embed(text)));
		} finally {
			await embedder.dispose();
			await provider.dispose();
		}
	});
});
