/**
 * Local cross-encoder that scores how well each text answers a query, on the CPU.
 *
 * The model is multilingual (Chinese and English among others) and ships as an 8-bit ONNX file per CPU family. It
 * loads in the background on first use: until it is ready, or if it cannot load (offline with nothing cached, say),
 * `score` answers undefined and the caller keeps its own order.
 */

import { arch } from "node:os";
import { createLogger } from "@snoai/utils/logger";
import { LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT } from "./constants";

const log = createLogger("embedder:local-reranker");

/** Local reranker model (Hugging Face hub). Apache-2.0. */
export const LOCAL_RERANK_MODEL = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1";

/** Pinned revision (commit SHA), the same supply-chain rule as the embedding model. */
export const LOCAL_RERANK_MODEL_REVISION = "1427fd652930e4ba29e8149678df786c240d8825";

/** The repository ships one 8-bit file per CPU family and no generic quantized file. */
const MODEL_FILE = arch() === "arm64" ? "model_qint8_arm64" : "model_quint8_avx2";
const SCORE_BATCH = 5;

export interface LocalRerankerOptions {
	cacheDir: string;
	offline?: boolean;
	mirror?: string;
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
let sharedLoading: Promise<Loaded | undefined> | undefined;
let sharedUsers = 0;

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
			sharedLoading ??= this.load();
			return undefined;
		}
		// Five pairs per run: one run of all the long pairs holds several times the memory, for little time saved.
		const scores: number[] = [];
		for (let start = 0; start < texts.length; start += SCORE_BATCH) {
			// A caller that stopped waiting (deadline, cancel) gets no further runs.
			if (signal?.aborted) return undefined;
			const batch = texts.slice(start, start + SCORE_BATCH);
			const inputs = loaded.tokenizer(new Array(batch.length).fill(query), {
				text_pair: batch, padding: true, truncation: true, max_length: 512,
			});
			const { logits } = await loaded.model(inputs);
			for (let i = 0; i < batch.length; i += 1) scores.push(Number(logits.data[i] ?? 0));
		}
		return scores;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		sharedUsers = Math.max(0, sharedUsers - 1);
		if (sharedUsers > 0) return;
		const loaded = shared ?? (await sharedLoading?.catch(() => undefined));
		shared = undefined;
		sharedLoading = undefined;
		await loaded?.dispose();
	}

	private async load(): Promise<Loaded | undefined> {
		const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import("@huggingface/transformers");
		// The transformers env is process-wide and the embedder sets it for its own model; this load sets its own
		// revision and restores everything afterwards. It runs after a query was embedded, so the embedder's load is done.
		const previous = { cacheDir: env.cacheDir, allowRemoteModels: env.allowRemoteModels, localModelPath: env.localModelPath,
			remoteHost: env.remoteHost, remotePathTemplate: env.remotePathTemplate };
		const started = performance.now();
		try {
			env.cacheDir = this.options.cacheDir;
			env.localModelPath = this.options.cacheDir;
			env.allowRemoteModels = !this.options.offline;
			env.remotePathTemplate = `{model}/resolve/${LOCAL_RERANK_MODEL_REVISION}/`;
			const mirror = this.options.mirror?.trim();
			if (mirror) env.remoteHost = mirror.endsWith("/") ? mirror : `${mirror}/`;
			const tokenizer = await AutoTokenizer.from_pretrained(LOCAL_RERANK_MODEL);
			const model = await AutoModelForSequenceClassification.from_pretrained(LOCAL_RERANK_MODEL, {
				dtype: "fp32", model_file_name: MODEL_FILE, device: "cpu",
				// The embedder's low-memory profile (no arena, no memory pattern), so the two models together stay small.
				session_options: { ...LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT, interOpNumThreads: 1,
					...(this.options.intraOpNumThreads ? { intraOpNumThreads: this.options.intraOpNumThreads } : {}) },
			});
			shared = {
				tokenizer: (texts, options) => tokenizer(texts, options),
				model: (inputs) => model(inputs as Record<string, unknown>) as Promise<{ logits: { data: ArrayLike<number> } }>,
				dispose: async () => { await model.dispose(); },
			};
			log.info("local reranker loaded", { duration_ms: Math.round(performance.now() - started), model_file: MODEL_FILE }, {
				event_name: "embedder.local_reranker.loaded", file: "packages/embedder/src/local-reranker.ts",
				function: "load", site_id: "embedder.local_reranker.loaded",
			});
			return shared;
		} catch (error) {
			log.warn("local reranker unavailable; recall keeps its cosine order", { error, offline: this.options.offline === true }, {
				event_name: "embedder.local_reranker.unavailable", file: "packages/embedder/src/local-reranker.ts",
				function: "load", site_id: "embedder.local_reranker.unavailable",
			});
			return undefined;
		} finally {
			Object.assign(env, previous);
		}
	}
}
