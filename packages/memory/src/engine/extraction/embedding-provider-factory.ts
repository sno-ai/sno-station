import { availableParallelism } from "node:os";
import {
	type EmbeddingProvider,
	LocalEmbedProvider,
	LOCAL_EMBEDDING_CACHE_DIR_DEFAULT,
	type LocalEmbedDtype,
	type LocalEmbedSessionOptions,
} from "@snoai/embedder";

export type EmbeddingProviderKind = "local-onnx";

export interface EmbeddingConfig {
	/** Which provider to instantiate. Defaults to local-onnx. */
	provider?: EmbeddingProviderKind;
	/** Hugging Face model id. Defaults to the bundled PPLX INT8 model. */
	model?: string;
	/** Output dimension. Smaller values truncate and re-normalize the native vector. */
	dimensions?: number;
	/** Native model dimension. Defaults to 1024 for bundled PPLX. */
	nativeDim?: number;
	/** Pinned HuggingFace revision SHA for local-onnx (defaults to bundled 0.6B revision). */
	revision?: string;
	/**
	 * Pooling strategy for local-onnx. Defaults to `mean` for bundled PPLX.
	 * Read the model's `1_Pooling/config.json`.
	 */
	pooling?: "last_token" | "mean" | "cls";
	normalized?: boolean;
	/** Local ONNX model cache directory (default: ./embedding/models) */
	cacheDir?: string;
	offline?: boolean;
	mirror?: string;
	/** Quantization dtype. Default: q8. */
	dtype?: LocalEmbedDtype;
	/** ONNX Runtime session options for local low-memory operation. */
	sessionOptions?: LocalEmbedSessionOptions;
	/** Enable text chunking for long passages (default: true) */
	chunking?: boolean;
}

export function resolveEmbeddingCacheDir(config: EmbeddingConfig): string {
	return config.cacheDir || LOCAL_EMBEDDING_CACHE_DIR_DEFAULT;
}

/** Assembles provider from validated inputs for deterministic embedding generation. */
export function buildProvider(config: EmbeddingConfig): EmbeddingProvider {
	return new LocalEmbedProvider({
		...(config.cacheDir ? { cacheDir: config.cacheDir } : {}),
		offline: config.offline,
		mirror: config.mirror,
		dtype: config.dtype,
		// No thread count means automatic. ONNX alone would take every core, so a background pass would pin the whole
		// machine; and every provider in a process must agree, because they share one pipeline.
		sessionOptions: { ...config.sessionOptions,
			intraOpNumThreads: config.sessionOptions?.intraOpNumThreads ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))) },
		...(config.model !== undefined ? { model: config.model } : {}),
		...(config.revision !== undefined ? { revision: config.revision } : {}),
		...(config.nativeDim !== undefined ? { nativeDim: config.nativeDim } : {}),
		...(config.dimensions !== undefined ? { outputDim: config.dimensions } : {}),
		...(config.pooling !== undefined ? { pooling: config.pooling } : {}),
	});
}
