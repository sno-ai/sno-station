/**
 * @snoai/embedder — Unified embedding package for all Sno Station apps.
 *
 * Provides local ONNX (PPLX 0.6B INT8, 1024-d) embeddings with LRU caching.
 */

// ─── Constants ───────────────────────────────────────────────────────────────
export {
	EMBEDDING_DIMENSION,
	LOCAL_EMBEDDING_CACHE_DIR_DEFAULT,
	LOCAL_EMBEDDING_DTYPE_DEFAULT,
	LOCAL_EMBEDDING_MODEL,
	LOCAL_EMBEDDING_MODEL_REVISION,
	LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT,
	LRU_CACHE_MAX_DEFAULT,
	LRU_CACHE_TTL_MS_DEFAULT,
} from "./constants";
// ─── Providers ───────────────────────────────────────────────────────────────
export {
	LocalEmbedProvider,
	ModelNotFoundError,
	ModelNotLoadedError,
	truncateAndRenormalize,
} from "./local-provider";
export { CachedEmbeddingProvider } from "./lru-cache";
// ─── Types & Interface ───────────────────────────────────────────────────────
export type { EnsureModelDownloadedOptions } from "./model-download";
export {
	ensureModelDownloaded,
	getDirSizeMB,
	getDtypeDisplaySize,
	getSystemRamGB,
	isModelCached,
	recommendDtype,
} from "./model-download";
export type {
	CacheConfig,
	DisposableProvider,
	EmbeddingProvider,
	LocalEmbedConfig,
	LocalEmbedDtype,
	LocalEmbedGraphOptimizationLevel,
	LocalEmbedPooling,
	LocalEmbedSessionOptions,
} from "./types";
