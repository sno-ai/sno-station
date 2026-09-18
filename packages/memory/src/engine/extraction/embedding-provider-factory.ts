import {
	type EmbeddingProvider,
	LocalEmbedProvider,
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
	/** Quantization dtype. Default: q8. */
	dtype?: LocalEmbedDtype;
	/** ONNX Runtime session options for local low-memory operation. */
	sessionOptions?: LocalEmbedSessionOptions;
	/** Enable text chunking for long passages (default: true) */
	chunking?: boolean;
}

/** Assembles provider from validated inputs for deterministic embedding generation. */
export function buildProvider(config: EmbeddingConfig): EmbeddingProvider {
	return new LocalEmbedProvider({
		cacheDir: config.cacheDir,
		dtype: config.dtype,
		sessionOptions: config.sessionOptions,
		...(config.model !== undefined ? { model: config.model } : {}),
		...(config.revision !== undefined ? { revision: config.revision } : {}),
		...(config.nativeDim !== undefined ? { nativeDim: config.nativeDim } : {}),
		...(config.dimensions !== undefined ? { outputDim: config.dimensions } : {}),
		...(config.pooling !== undefined ? { pooling: config.pooling } : {}),
	});
}
