/** @file embedding-provider-client.ts
 * @purpose Adapts embedding providers to the plugin retrieval and storage contract.
 * @boundary Local ONNX embeddings, chunk sizing, and vector dimensions.
 * @see store.ts, retriever.ts.
 */

/** Local ONNX embedding with an LRU cache and oversized-text chunking. */

import { CachedEmbeddingProvider, LOCAL_EMBEDDING_MODEL } from "@snoai/embedder";
import { chunk, getCjkRatio, type ChunkConfig } from "@snoai/chunking";
import { createLogger } from "@snoai/utils/logger";
import {
	CACHE_SIZE,
	CACHE_TTL_MS,
	CHUNKER_SAFETY_MARGIN,
	CJK_CHAR_TOKEN_DIVISOR,
	CJK_RATIO_THRESHOLD,
	DEFAULT_CHARS_PER_TOKEN,
	DEFAULT_MAX_CONTEXT_TOKENS,
} from "../../../config/index";
import {
	buildProvider,
	type EmbeddingConfig,
	type EmbeddingProviderKind,
} from "./embedding-provider-factory";
import { weightedAverageFloat32 } from "./embedding-vector-aggregation";
import { EmbeddingError } from "../shared/errors";

const log = createLogger("sno-station-mem:embed");

export type { EmbeddingConfig, EmbeddingProviderKind };

export class Embedder {
	private readonly provider: CachedEmbeddingProvider;
	private readonly maxSingleEmbedChars: number;
	private readonly chunkingEnabled: boolean;
	private readonly maxContextTokens: number;
	private readonly charsPerToken: number;
	readonly dimensions: number;
	readonly providerKind: EmbeddingProviderKind;
	readonly model: string;
	// Tracks the in-flight (or completed) warmup so embed can
	// wait for it before issuing the first real call. Plugin register() returns
	// before warmup finishes (gateway >= 2026.6.9 requires sync register), so
	// without this gate the first capture/recall could hit the provider before
	// the local ONNX model loaded.
	private warmupPromise: Promise<void> | null = null;

	/**
	 * Initializes embedding generation collaborators while keeping runtime work in explicit
	 * methods.
	 */
	constructor(config: EmbeddingConfig, _stateDir: string) {
		// Chunker config
		this.chunkingEnabled = config.chunking !== false;
		this.maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
		this.charsPerToken = config.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
		const maxTokens = this.maxContextTokens;
		const charsPerToken = this.charsPerToken;
		this.maxSingleEmbedChars = Math.floor(maxTokens * charsPerToken * CHUNKER_SAFETY_MARGIN);

		const providerKind: EmbeddingProviderKind = config.provider ?? "local-onnx";
		const inner = buildProvider(config);
		this.dimensions = inner.dimension;
		this.providerKind = providerKind;
		// Default model is the bundled PPLX INT8 id.
		this.model =
			config.model && config.model.trim().length > 0 ? config.model : LOCAL_EMBEDDING_MODEL;

		this.provider = new CachedEmbeddingProvider(inner, {
			maxSize: CACHE_SIZE,
			ttlMs: CACHE_TTL_MS,
		});

		log.info("embedder initialized", {
			provider: providerKind,
			model: this.model,
			dimensions: this.dimensions,
			chunking: this.chunkingEnabled,
			maxSingleEmbedChars: this.maxSingleEmbedChars,
		}, {
			event_name: "sno_station_mem.embedding-provider-client.embedder.initialized",
			file: "packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts",
			function: "<anonymous callback>",
			site_id: "embedding-provider-client.<anonymous callback>.3c8d5ee192",
		});
	}

	/** Converts float32 into the transport shape expected by embedding generation. */
	private toFloat32(vector: number[]): Float32Array {
		// Guard vector.length here so the remaining embedding path works with normalized inputs.
		if (vector.length !== this.dimensions) {
			// Surface this invalid embedding state as an explicit typed failure.
			throw new EmbeddingError(
				`Embedding dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
			);
		}
		// Centralize the embedding fallback value at the boundary of this helper.
		return Float32Array.from(vector);
	}

	private buildEmbedderChunkConfig(): Partial<ChunkConfig> {
		const maxTokens = Math.max(1, Math.floor(this.maxContextTokens * CHUNKER_SAFETY_MARGIN));
		const minTokens = Math.min(256, maxTokens);
		const overlapTokens = Math.min(32, Math.max(0, minTokens - 1));
		return {
			contentType: "prose",
			minTokens,
			targetTokens: maxTokens,
			maxTokens,
			overlapTokens,
		};
	}

	/**
	 * Wait for warmup before issuing real embedding work. Calls `warmup()`
	 * itself so callers that bypass register-time warmup (tests, ad-hoc
	 * scripts) still get the same fail-loud probe — `warmup()` is memoized,
	 * so repeated calls reuse the in-flight or completed promise.
	 */
	private async awaitWarmup(): Promise<void> {
		await this.warmup();
	}

	/** Implements embed as the local embedding generation operation. */
	// LH: Passage embedding proactively chunks oversized content before provider calls to avoid token-limit failures.
	// LH: The live budget is CJK-aware because character-to-token ratios differ materially across languages.
	// LH: Chunk fallback should preserve semantic coverage instead of truncating large memories blindly.
	// LH: The returned vector represents the whole passage through weighted normalized aggregation.
	async embed(text: string): Promise<Float32Array> {
		await this.awaitWarmup();
		if (!this.chunkingEnabled) {
			return this.embedDirect(text);
		}

		// Decide fast-path vs chunked path against a CJK-aware char budget. CJK-heavy
		// text packs more tokens per character, so the generic `maxSingleEmbedChars`
		// underestimates token cost — using it as the gate would push CJK passages
		// past the provider's token limit before we ever reach the chunker.
		const cjkHeavy = getCjkRatio(text) > CJK_RATIO_THRESHOLD;
		const effectiveMaxChars = cjkHeavy
			? Math.floor(this.maxSingleEmbedChars / CJK_CHAR_TOKEN_DIVISOR)
			: this.maxSingleEmbedChars;
		if (text.length <= effectiveMaxChars) {
			return this.embedDirect(text);
		}

		const chunks = chunk(text, this.buildEmbedderChunkConfig()).map((draft) => draft.chunkText);
		// Guard chunks.length here so the remaining embedding path works with normalized inputs.
		if (chunks.length <= 1) {
			return this.embedDirect(chunks[0] ?? text);
		}

		// Per PRD §14 step 17: this warning is an embedding-API safety net
		// only. Steady-state ingest now chunks via `@snoai/chunking` upstream of this
		// path, so any invocation here means a single retrieval-unit chunk exceeded
		// the embedder's context window — drift signal that PRD §16 acceptance check
		// asserts must fire zero times during smoke ingest.
		log.warn("legacy chunker invoked (embedding-API safety net)", {
			chunks: chunks.length,
			totalChars: text.length,
			maxChars: this.maxSingleEmbedChars,
		}, {
			event_name: "sno_station_mem.embedding-provider-client.legacy.chunker.invoked.embedding.api.safety.net",
			file: "packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts",
			function: "embed",
			site_id: "embedding-provider-client.embed.ab60111378",
		});

		// Await the embedding dependency before deriving downstream state.
		const vectors = await this.embedMany(chunks);
		// We intentionally collapse chunk embeddings back into one vector here so
		// downstream storage stays one-vector-per-memory. This loses some per-chunk
		// detail for very long passages, but keeps retrieval/storage costs bounded.
		return weightedAverageFloat32(
			vectors,
			chunks.map((c) => c.length),
			this.dimensions,
		);
	}

	/** Implements embed direct as the local embedding generation operation. */
	protected async embedDirect(text: string): Promise<Float32Array> {
		// Isolate the embedding operation that can fail because of runtime I/O or input shape.
		try {
			// Await the embedding dependency before deriving downstream state.
			const vector = await this.provider.embed(text);
			// Centralize the embedding fallback value at the boundary of this helper.
			return this.toFloat32(vector);
		} catch (error) {
			// Log operational context for embedding without changing control flow.
			log.error("passage embedding failed", {
				textLength: text.length,
				error,
			}, {
				event_name: "sno_station_mem.embedding-provider-client.passage.embedding.failed",
				file: "packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts",
				function: "embedDirect",
				site_id: "embedding-provider-client.embedDirect.c6998ac2fb",
			});
			// Surface this invalid embedding state as an explicit typed failure.
			throw new EmbeddingError("Failed to generate passage embedding", error);
		}
	}

	/** Implements embed many as the local embedding generation operation. */
	async embedMany(values: string[]): Promise<Float32Array[]> {
		await this.awaitWarmup();
		// Log operational context for embedding without changing control flow.
		log.debug("batch embedding", { count: values.length }, {
			event_name: "sno_station_mem.embedding-provider-client.batch.embedding",
			file: "packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts",
			function: "embedMany",
			site_id: "embedding-provider-client.embedMany.8ffe2fb365",
		});

		try {
			// Await the embedding dependency before deriving downstream state.
			const vectors = await this.provider.embedDocuments(values);
			if (vectors.length !== values.length) {
				throw new EmbeddingError(
					`Embedding provider returned ${vectors.length} vectors for ${values.length} inputs`,
				);
			}
			// Transform the collection in one place so embedding ordering and filters stay reviewable.
			return vectors.map((v) => this.toFloat32(v));
		} catch (error) {
			// Log operational context for embedding without changing control flow.
			log.error("batch embedding failed", {
				count: values.length,
				error,
			}, {
				event_name: "sno_station_mem.embedding-provider-client.batch.embedding.failed",
				file: "packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts",
				function: "embedMany",
				site_id: "embedding-provider-client.embedMany.71b35eadaf",
			});
			if (error instanceof EmbeddingError) {
				throw error;
			}
			// Surface this invalid embedding state as an explicit typed failure.
			throw new EmbeddingError("Failed to generate batch embeddings", error);
		}
	}

	/**
	 * Embed each input text individually as a passage. Used by chunk-level
	 * ingestion in `MemoryStore` — one vector per chunk, no averaging. Reuses
	 * the batch primitive and its cache.
	 */
	async embedChunks(texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		return this.embedMany(texts);
	}

	/**
	 * Force the underlying ONNX model to load and run one real inference.
	 *
	 * LocalEmbedProvider lazy-loads the model on first `embed()` call. That
	 * means `new Embedder(...)` succeeds even if the model file is missing —
	 * the failure only surfaces later, per-turn, during ambient-learning, where
	 * the error is swallowed by `Promise.allSettled`. Calling `warmup()` at
	 * plugin-register time turns a latent misconfiguration into a hard,
	 * loud registration failure. Caller should let the error propagate.
	 */
	async warmup(): Promise<void> {
		// Memoize so concurrent callers (e.g. the detached register() path plus
		// the first hook-driven embed) all wait on the same probe.
		if (this.warmupPromise) return this.warmupPromise;
		const probe = (async () => {
			try {
				const vector = await this.provider.embed("warmup");
				if (vector.length !== this.dimensions) {
					// Surface this invalid embedding state as an explicit typed failure.
					throw new EmbeddingError(
						`Embedder warmup dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
					);
				}
				log.info("embedder warmup ok", { dimensions: this.dimensions }, {
					event_name: "sno_station_mem.embedding-provider-client.embedder.warmup.ok",
					file: "packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts",
					function: "<anonymous callback>",
					site_id: "embedding-provider-client.<anonymous callback>.32cc9ec43e",
				});
			} catch (error) {
				log.error("embedder warmup failed", { error }, {
					event_name: "sno_station_mem.embedding-provider-client.embedder.warmup.failed",
					file: "packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts",
					function: "<anonymous callback>",
					site_id: "embedding-provider-client.<anonymous callback>.d7a3f8337c",
				});
				// Surface this invalid embedding state as an explicit typed failure.
				throw new EmbeddingError(
					"Embedder warmup failed — the plugin cannot capture or recall memories. Check that the local ONNX model exists at the configured cacheDir.",
					error,
				);
			}
		})();
		// Clear the memo on rejection so a transient provider hiccup does not
		// pin every later embed call to the same rejected promise for the life
		// of the process. Concurrent callers awaiting `probe` still observe the
		// same rejection; only the *next* call after settle triggers a retry.
		this.warmupPromise = probe.catch((err) => {
			this.warmupPromise = null;
			throw err;
		});
		return this.warmupPromise;
	}

	/** Implements dispose as the local embedding generation operation. */
	async dispose(): Promise<void> {
		const warmup = this.warmupPromise;
		if (warmup) await warmup.catch(() => undefined);
		await this.provider.dispose();
	}
}

/** Creates the embedder facade around the local ONNX provider. */
export function createEmbedder(config: EmbeddingConfig, stateDir: string): Embedder {
	return new Embedder(config, stateDir);
}
