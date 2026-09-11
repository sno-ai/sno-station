import { CachedEmbeddingProvider, type EmbeddingProvider } from "@snoai/embedder";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("CachedEmbeddingProvider batch rejection", () => {
	const seen: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		seen.push(reason);
	};

	beforeEach(() => {
		seen.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	it("handles every rejection and retries the same texts after a failed batch", async () => {
		let shouldFail = true;
		const inner: EmbeddingProvider = {
			dimension: 2,
			async embed(text: string): Promise<number[]> {
				const [vector] = await this.embedDocuments([text]);
				if (vector === undefined) throw new Error("Missing test embedding");
				return vector;
			},
			async embedDocuments(texts: string[]): Promise<number[][]> {
				if (shouldFail) throw new Error("Batch embedding failed");
				return texts.map((_, index) => [index + 1, index + 2]);
			},
		};
		const cache = new CachedEmbeddingProvider(inner);
		try {
			await expect(cache.embedDocuments(["alpha", "beta"])).rejects.toThrow(
				"Batch embedding failed",
			);
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
			expect(seen).toEqual([]);

			shouldFail = false;
			await expect(cache.embedDocuments(["alpha", "beta"])).resolves.toEqual([
				[1, 2],
				[2, 3],
			]);
		} finally {
			await cache.dispose();
		}
	});
});
