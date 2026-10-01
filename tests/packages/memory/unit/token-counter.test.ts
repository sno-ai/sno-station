import { describe, expect, it, vi } from "vitest";

describe("token counter", () => {
	it("uses the production tiktoken encoding for Qwen text prompts", async () => {
		const { countTextTokens } = await import(
			"../../../../packages/memory/src/engine/observability/token-counter.ts"
		);

		const result = countTextTokens("user preference classification", "Qwen3-32B");

		expect(result.method).toBe("tiktoken");
		expect(result.count).toBeGreaterThan(0);
	});

	it("caches Qwen tokenizers by model", async () => {
		vi.resetModules();
		const loadTokenizer = vi.fn(async (model: string) => ({
			encode: () => (model === "Qwen/model-a" ? [1] : [1, 2]),
		}));
		const { countEmbeddingTokens, setQwenTokenizerLoaderForTests } =
			await import(
				"../../../../packages/memory/src/engine/observability/token-counter.ts"
			);
		setQwenTokenizerLoaderForTests(loadTokenizer);

		await expect(
			countEmbeddingTokens("alpha", {
				provider: "local-onnx",
				model: "Qwen/model-a",
			}),
		).resolves.toEqual({ count: 1, method: "qwen_tokenizer" });
		await expect(
			countEmbeddingTokens("beta", {
				provider: "local-onnx",
				model: "Qwen/model-b",
			}),
		).resolves.toEqual({ count: 2, method: "qwen_tokenizer" });
		await expect(
			countEmbeddingTokens("again", {
				provider: "local-onnx",
				model: "Qwen/model-a",
			}),
		).resolves.toEqual({ count: 1, method: "qwen_tokenizer" });

		expect(loadTokenizer).toHaveBeenCalledTimes(2);
		expect(loadTokenizer).toHaveBeenNthCalledWith(1, "Qwen/model-a");
		expect(loadTokenizer).toHaveBeenNthCalledWith(2, "Qwen/model-b");
		setQwenTokenizerLoaderForTests();
	});

	it("retries a Qwen tokenizer after a failed load", async () => {
		vi.resetModules();
		const loadTokenizer = vi
			.fn()
			.mockRejectedValueOnce(new Error("load failed"))
			.mockResolvedValueOnce({ encode: () => [1, 2, 3] });
		const { countEmbeddingTokens, setQwenTokenizerLoaderForTests } =
			await import(
				"../../../../packages/memory/src/engine/observability/token-counter.ts"
			);
		setQwenTokenizerLoaderForTests(loadTokenizer);

		await expect(
			countEmbeddingTokens("alpha", {
				provider: "local-onnx",
				model: "Qwen/retry",
			}),
		).rejects.toThrow("load failed");
		await expect(
			countEmbeddingTokens("alpha", {
				provider: "local-onnx",
				model: "Qwen/retry",
			}),
		).resolves.toEqual({ count: 3, method: "qwen_tokenizer" });

		expect(loadTokenizer).toHaveBeenCalledTimes(2);
		expect(loadTokenizer).toHaveBeenNthCalledWith(1, "Qwen/retry");
		expect(loadTokenizer).toHaveBeenNthCalledWith(2, "Qwen/retry");
		setQwenTokenizerLoaderForTests();
	});
});
