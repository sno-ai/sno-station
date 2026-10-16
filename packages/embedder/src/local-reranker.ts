/**
 * Local cross-encoder that scores how well each text answers a query, on the CPU.
 *
 * The model reads Chinese and English (and other languages). It downloads through the shared downloader and loads in
 * the background on first use: until it is ready, or if it cannot load (offline with nothing cached, say), `score`
 * answers undefined and the caller keeps its own order.
 */

import { createLogger } from "@snoai/utils/logger";
import { LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT } from "./constants";
import { downloadModel, type ModelSpec } from "./downloader";

const log = createLogger("embedder:local-reranker");

/**
 * Horizon-Labs/multilingual-reranker-small (Apache-2.0) in an 8-bit ONNX file Sno published; pinned revision and
 * file hashes, the same supply-chain rule as the embedding model.
 */
export const LOCAL_RERANK_MODEL: ModelSpec = {
	id: "sno-lab/multilingual-reranker-small-int8",
	revision: "ce76796ae42628f54f501271aeac16df8ecc8a6f",
	files: [
		{ path: "config.json", size: 1995, sha256: "e9fd043628cd796a364020164a7a6ca78d29b0ec5cf135464489f54110f4b1da" },
		{ path: "special_tokens_map.json", size: 636, sha256: "baec30ea10906f16adb8c18af7a34023002c1746542612b8b41c9f09e1351351" },
		{ path: "tokenizer.json", size: 34363439, sha256: "7925f638b5444897efe3b4608eed56c1652f0ed39c2662c8302de1bc264c6088" },
		{ path: "tokenizer_config.json", size: 46440, sha256: "ea349495764b24570b4560fe2e4a557e5c0a47e6bce782c2409b1d6445cf8633" },
		{ path: "onnx/model_quantized.onnx", size: 171363319, sha256: "d2b03e74b3ea60ca486a118b4e2ab6bc96b173c64224a689d653e135753d89ad" },
	],
};

const SCORE_BATCH = 5;
// A failed load (a download that broke, a mirror that was down) is tried again on the first call after this long; an
// offline machine with nothing cached pays one failed attempt per interval.
const LOAD_RETRY_MS = 10 * 60_000;

export interface LocalRerankerOptions {
	cacheDir: string;
	offline?: boolean | undefined;
	mirror?: string | undefined;
	intraOpNumThreads?: number;
}

interface Loaded {
	tokenizer: (texts: string[], options: Record<string, unknown>) => unknown;
	model: (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>;
	dispose(): Promise<void>;
}

// One model per process: the memory service makes an embedder, and so a reranker, per registered agent, and each copy
// would hold its own copy of the model. The first instance's options load it; the last dispose releases it.
let shared: Loaded | undefined;
let sharedLoading = false;
let sharedUsers = 0;
let sharedFailedAt: number | undefined;
// Bumped by the last release: a load still downloading then discards its model instead of publishing it.
let releases = 0;
// Scoring under way on the shared model, possibly for a caller that stopped waiting: the release waits for it.
const scoring = new Set<Promise<number[] | undefined>>();

export class LocalReranker {
	private disposed = false;

	constructor(private readonly options: LocalRerankerOptions) {
		sharedUsers += 1;
	}

	/**
	 * Raw relevance logits, one per text (higher is more relevant), or undefined while the model is not loaded.
	 * The first call starts the load and does not wait for it.
	 */
	async score(query: string, texts: string[], signal?: AbortSignal): Promise<number[] | undefined> {
		if (texts.length === 0) return [];
		const loaded = shared;
		if (!loaded) {
			if (sharedFailedAt !== undefined && Date.now() - sharedFailedAt >= LOAD_RETRY_MS) {
				sharedFailedAt = undefined;
				sharedLoading = false;
			}
			if (!sharedLoading) {
				sharedLoading = true;
				void this.load();
			}
			return undefined;
		}
		const run = this.run(loaded, query, texts, signal);
		scoring.add(run);
		try {
			return await run;
		} finally {
			scoring.delete(run);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		sharedUsers = Math.max(0, sharedUsers - 1);
		if (sharedUsers > 0) return;
		const loaded = shared;
		releases += 1;
		shared = undefined;
		sharedLoading = false;
		sharedFailedAt = undefined;
		await Promise.allSettled(scoring);
		await loaded?.dispose();
	}

	private async run(loaded: Loaded, query: string, texts: string[], signal?: AbortSignal): Promise<number[] | undefined> {
		// Five pairs per run: one run of all the long pairs holds several times the memory, for little time saved.
		// Runs of similar length pad less; the scores go back in the callers' order.
		const order = texts.map((_, index) => index).sort((a, b) => (texts[a]?.length ?? 0) - (texts[b]?.length ?? 0));
		const scores = new Array<number>(texts.length).fill(0);
		for (let start = 0; start < order.length; start += SCORE_BATCH) {
			// A caller that stopped waiting (deadline, cancel) gets no further runs.
			if (signal?.aborted) return undefined;
			const run = order.slice(start, start + SCORE_BATCH);
			const inputs = loaded.tokenizer(new Array(run.length).fill(query), {
				text_pair: run.map((index) => texts[index] ?? ""), padding: true, truncation: true, max_length: 512,
			});
			const { logits } = await loaded.model(inputs);
			for (const [i, index] of run.entries()) scores[index] = Number(logits.data[i] ?? 0);
		}
		return scores;
	}

	private async load(): Promise<Loaded | undefined> {
		const release = releases;
		const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import("@huggingface/transformers");
		const started = performance.now();
		try {
			const dir = await downloadModel(LOCAL_RERANK_MODEL, this.options);
			// Every file comes through the shared downloader; transformers only reads the revision directory.
			env.allowRemoteModels = false;
			const tokenizer = await AutoTokenizer.from_pretrained(dir, { local_files_only: true });
			const model = await AutoModelForSequenceClassification.from_pretrained(dir, {
				dtype: "q8", device: "cpu", local_files_only: true,
				// The embedder's low-memory profile (no arena, no memory pattern), so the two models together stay small.
				session_options: { ...LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT, interOpNumThreads: 1,
					...(this.options.intraOpNumThreads ? { intraOpNumThreads: this.options.intraOpNumThreads } : {}) },
			});
			if (release !== releases) {
				await model.dispose();
				return undefined;
			}
			shared = {
				tokenizer: (texts, options) => tokenizer(texts, options),
				model: (inputs) => model(inputs as Record<string, unknown>) as Promise<{ logits: { data: ArrayLike<number> } }>,
				dispose: async () => { await model.dispose(); },
			};
			log.info("local reranker loaded", { duration_ms: Math.round(performance.now() - started), model: LOCAL_RERANK_MODEL.id }, {
				event_name: "embedder.local_reranker.loaded", file: "packages/embedder/src/local-reranker.ts",
				function: "load", site_id: "embedder.local_reranker.loaded",
			});
			return shared;
		} catch (error) {
			log.warn("local reranker unavailable; recall keeps its cosine order", { error, offline: this.options.offline === true }, {
				event_name: "embedder.local_reranker.unavailable", file: "packages/embedder/src/local-reranker.ts",
				function: "load", site_id: "embedder.local_reranker.unavailable",
			});
			sharedFailedAt = Date.now();
			return undefined;
		}
	}
}
