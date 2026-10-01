/**
 * Shared interface for the local ONNX embedding provider.
 */

export interface EmbeddingProvider {
	/** Embed a single text for storage (passage encoding) */
	embed(text: string): Promise<number[]>;
	/** Embed multiple texts for storage (passage encoding, batch) */
	embedDocuments(texts: string[]): Promise<number[][]>;
	/** Vector dimension (always 1024) */
	readonly dimension: number;
	/**
	 * Exact token count of `text` under this provider's own tokenizer — the same count the
	 * model sees, so a limit checked here is a hard limit, not an estimate. Synchronous;
	 * throws until the model has loaded (`embed()` or `warmup` loads it).
	 */
	countTokens(text: string): number;
}

/** Disposable extension — providers that hold resources (ONNX sessions, HTTP clients) */
export interface DisposableProvider extends EmbeddingProvider {
	dispose(): Promise<void>;
}

/** Pooling strategy for the local ONNX feature-extraction pipeline. */
export type LocalEmbedPooling = "last_token" | "mean" | "cls";

/** ONNX model precision variants supported by Transformers.js. */
export type LocalEmbedDtype =
	| "fp32"
	| "fp16"
	| "q8"
	| "q4"
	| "bnb4"
	| "q4f16"
	| "int8"
	| "uint8";

/** ONNX Runtime graph optimization level for the local provider. */
export type LocalEmbedGraphOptimizationLevel =
	| "disabled"
	| "basic"
	| "extended"
	| "all";

/** ONNX Runtime session knobs for local embedding memory control. */
export interface LocalEmbedSessionOptions {
	graphOptimizationLevel?: LocalEmbedGraphOptimizationLevel;
	enableMemPattern?: boolean;
	enableCpuMemArena?: boolean;
	executionMode?: "sequential" | "parallel";
	interOpNumThreads?: number;
	intraOpNumThreads?: number;
}

/** Config for the local ONNX provider */
export interface LocalEmbedConfig {
	cacheDir?: string;
	offline?: boolean;
	mirror?: string;
	dtype?: LocalEmbedDtype;
	/**
	 * Hugging Face model id. Defaults to the bundled PPLX 1024-d INT8 model.
	 * Override to use other ONNX feature-extraction models.
	 */
	model?: string;
	/** Pinned HF revision (commit SHA). Defaults only when using the bundled local model. */
	revision?: string;
	/**
	 * Native embedding dimension produced by the model (model's `hidden_size`).
	 * For PPLX 0.6B = 1024, Qwen3-4B = 2560. When `outputDim` is smaller, the
	 * provider Matryoshka-truncates the head and re-L2-normalizes.
	 */
	nativeDim?: number;
	/**
	 * Output dimension exposed to callers and stored in the vec table. Defaults
	 * to `nativeDim`. Set < `nativeDim` to enable Matryoshka truncation.
	 */
	outputDim?: number;
	/**
	 * Pooling strategy. Read from the model's `1_Pooling/config.json` when
	 * porting a SentenceTransformers model:
	 *   - Qwen3-Embedding family → `last_token`
	 *   - pplx-embed (Qwen3-derived w/ mean pooling) → `mean`
	 *   - BERT-style encoders → `cls`
	 * Defaults to `mean` for the bundled PPLX local model.
	 */
	pooling?: LocalEmbedPooling;
	/**
	 * Optional ONNX Runtime session overrides. Defaults use the low-memory CPU
	 * profile: graph optimization extended, memory pattern off, CPU arena off.
	 */
	sessionOptions?: LocalEmbedSessionOptions;
}

/** Config for the LRU cache wrapper */
export interface CacheConfig {
	maxSize?: number;
	ttlMs?: number;
}
