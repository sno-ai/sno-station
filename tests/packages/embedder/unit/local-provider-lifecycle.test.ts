import { pipeline } from "@huggingface/transformers";
import {
	LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT,
	LocalEmbedProvider,
	type LocalEmbedGraphOptimizationLevel,
	type LocalEmbedPooling,
} from "@snoai/embedder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@huggingface/transformers", () => ({
	env: {},
	pipeline: vi.fn(),
}));

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolveFn: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolveFn = resolve;
	});
	if (resolveFn === undefined) {
		throw new Error("deferred resolver was not initialized");
	}
	return { promise, resolve: resolveFn };
}

function createExtractor(dim = 1024): {
	extractor: ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };
	dispose: ReturnType<typeof vi.fn>;
} {
	const dispose = vi.fn(async (): Promise<void> => {});
	const extractor = Object.assign(
		vi.fn(async () => ({
			dims: [1, dim],
			data: new Float32Array(dim).fill(1 / Math.sqrt(dim)),
		})),
		{ dispose },
	);
	return { extractor, dispose };
}

describe("LocalEmbedProvider shared lifecycle", () => {
	const pipelineMock = vi.mocked(pipeline);

	beforeEach(() => {
		LocalEmbedProvider.resetStaticState();
		pipelineMock.mockReset();
	});

	afterEach(() => {
		LocalEmbedProvider.resetStaticState();
	});

	it("exports the local ONNX option surface from the package root", () => {
		const level: LocalEmbedGraphOptimizationLevel = "extended";
		const pooling: LocalEmbedPooling = "mean";

		expect(LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT.graphOptimizationLevel).toBe(
			level,
		);
		expect(pooling).toBe("mean");
	});

	it("rejects a second live provider with different pipeline options", async () => {
		const { extractor, dispose } = createExtractor();
		pipelineMock.mockResolvedValueOnce(extractor);

		const first = new LocalEmbedProvider({
			cacheDir: "/tmp/embedder-models",
			dtype: "q8",
		});
		const second = new LocalEmbedProvider({
			cacheDir: "/tmp/embedder-models",
			dtype: "q4",
		});

		try {
			await first.warmup();
			await expect(second.warmup()).rejects.toThrow(
				/shared ONNX pipeline is already loaded with a different/,
			);
			expect(pipelineMock).toHaveBeenCalledTimes(1);
		} finally {
			await first.dispose();
			await second.dispose();
		}
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("keeps a pending shared load alive when another provider waits for it", async () => {
		const pending = createDeferred<ReturnType<typeof createExtractor>["extractor"]>();
		pipelineMock.mockReturnValueOnce(pending.promise);

		const first = new LocalEmbedProvider({ cacheDir: "/tmp/embedder-models" });
		const firstWarmup = first.warmup();
		const firstDispose = first.dispose();
		const second = new LocalEmbedProvider({ cacheDir: "/tmp/embedder-models" });
		const secondWarmup = second.warmup();

		const { extractor, dispose } = createExtractor();
		pending.resolve(extractor);

		await expect(firstWarmup).rejects.toThrow("disposed");
		await firstDispose;
		await secondWarmup;

		expect(dispose).not.toHaveBeenCalled();
		expect(pipelineMock).toHaveBeenCalledTimes(1);

		await second.embed("reuse loaded extractor");
		expect(pipelineMock).toHaveBeenCalledTimes(1);

		await second.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("publishes a pending load when its owner is disposed before another provider waits", async () => {
		const pending = createDeferred<ReturnType<typeof createExtractor>["extractor"]>();
		pipelineMock.mockReturnValueOnce(pending.promise);

		const first = new LocalEmbedProvider({ cacheDir: "/tmp/embedder-models" });
		const firstWarmup = first.warmup();
		const second = new LocalEmbedProvider({ cacheDir: "/tmp/embedder-models" });
		await first.dispose();

		const { extractor, dispose } = createExtractor();
		pending.resolve(extractor);

		await expect(firstWarmup).rejects.toThrow("disposed");
		await second.warmup();

		expect(pipelineMock).toHaveBeenCalledTimes(1);
		expect(dispose).not.toHaveBeenCalled();

		await second.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
