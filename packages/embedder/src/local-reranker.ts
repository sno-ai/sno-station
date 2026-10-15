/**
 * Local cross-encoder that scores how well each text answers a query, on the CPU.
 *
 * The model is multilingual (Chinese and English among others) and ships as an 8-bit ONNX file per CPU family. It
 * loads in the background on first use: until it is ready, or if it cannot load (offline with nothing cached, say),
 * `score` answers undefined and the caller keeps its own order.
 */

import { arch } from "node:os";
import { createLogger } from "@snoai/utils/logger";

const log = createLogger("embedder:local-reranker");

/** Local reranker model (Hugging Face hub). Apache-2.0. */
export const LOCAL_RERANK_MODEL = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1";

/** Pinned revision (commit SHA), the same supply-chain rule as the embedding model. */
export const LOCAL_RERANK_MODEL_REVISION = "1427fd652930e4ba29e8149678df786c240d8825";

/** The repository ships one 8-bit file per CPU family and no generic quantized file. */
const MODEL_FILE = arch() === "arm64" ? "model_qint8_arm64" : "model_quint8_avx2";

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

export class LocalReranker {
	private loading: Promise<Loaded | undefined> | undefined;
	private loaded: Loaded | undefined;

	constructor(private readonly options: LocalRerankerOptions) {}

	/**
	 * Raw relevance logits, one per text (higher is more relevant), or undefined while the model is not loaded.
	 * The first call starts the load and does not wait for it.
	 */
	async score(query: string, texts: string[]): Promise<number[] | undefined> {
		if (texts.length === 0) return [];
		if (!this.loaded) {
			this.loading ??= this.load();
			return undefined;
		}
		const inputs = this.loaded.tokenizer(new Array(texts.length).fill(query), {
			text_pair: texts, padding: true, truncation: true, max_length: 512,
		});
		const { logits } = await this.loaded.model(inputs);
		return Array.from({ length: texts.length }, (_, i) => Number(logits.data[i] ?? 0));
	}

	async dispose(): Promise<void> {
		const loaded = this.loaded ?? (await this.loading?.catch(() => undefined));
		this.loaded = undefined;
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
				session_options: { interOpNumThreads: 1, ...(this.options.intraOpNumThreads ? { intraOpNumThreads: this.options.intraOpNumThreads } : {}) },
			});
			this.loaded = {
				tokenizer: (texts, options) => tokenizer(texts, options),
				model: (inputs) => model(inputs as Record<string, unknown>) as Promise<{ logits: { data: ArrayLike<number> } }>,
				dispose: async () => { await model.dispose(); },
			};
			log.info("local reranker loaded", { duration_ms: Math.round(performance.now() - started), model_file: MODEL_FILE }, {
				event_name: "embedder.local_reranker.loaded", file: "packages/embedder/src/local-reranker.ts",
				function: "load", site_id: "embedder.local_reranker.loaded",
			});
			return this.loaded;
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
