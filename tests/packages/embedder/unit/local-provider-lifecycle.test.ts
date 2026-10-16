import { pipeline } from "@huggingface/transformers";
import {
	LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT,
	LocalEmbedProvider,
	type LocalEmbedGraphOptimizationLevel,
	type LocalEmbedPooling,
} from "@snoai/embedder";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { embeddingModelSpec } from "../../../../packages/embedder/src/model-download.ts";

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

// A cache the downloader already completed (sparse files of the right sizes), so loading never reaches the network.
const CACHE = mkdtempSync(join(tmpdir(), "sno-embedder-lifecycle-"));
beforeAll(() => {
	const spec = embeddingModelSpec("q8");
	const dir = join(CACHE, spec.id, spec.revision);
	for (const file of spec.files) {
		mkdirSync(dirname(join(dir, file.path)), { recursive: true });
		writeFileSync(join(dir, file.path), "");
		truncateSync(join(dir, file.path), file.size);
	}
	writeFileSync(join(dir, ".complete"), JSON.stringify({ revision: spec.revision, files: spec.files }));
});
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

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
			cacheDir: CACHE,
			dtype: "q8",
		});
		const second = new LocalEmbedProvider({
			cacheDir: CACHE,
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

		const first = new LocalEmbedProvider({ cacheDir: CACHE });
		const firstWarmup = first.warmup();
		const firstDispose = first.dispose();
		const second = new LocalEmbedProvider({ cacheDir: CACHE });
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

		const first = new LocalEmbedProvider({ cacheDir: CACHE });
		const firstWarmup = first.warmup();
		const second = new LocalEmbedProvider({ cacheDir: CACHE });
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
