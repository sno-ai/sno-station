/**
 * Local ONNX embedding provider — PPLX embed v1 0.6B INT8, 1024-d vectors.
 *
 * Self-contained: all params via constructor; no app-level config dependency.
 */

import { resolve } from "node:path";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { createLogger } from "@snoai/utils/logger";
import {
	EMBEDDING_DIMENSION,
	LOCAL_EMBEDDING_CACHE_DIR_DEFAULT,
	LOCAL_EMBEDDING_DTYPE_DEFAULT,
	LOCAL_EMBEDDING_MODEL,
	LOCAL_EMBEDDING_MODEL_REVISION,
	LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT,
} from "./constants";
import type {
	DisposableProvider,
	LocalEmbedConfig,
	LocalEmbedDtype,
	LocalEmbedPooling,
	LocalEmbedSessionOptions,
} from "./types";

const log = createLogger("embedder:local");

// Process-global singleton for the ONNX pipeline. All LocalEmbedProvider instances
// share one FeatureExtractionPipeline because (a) @huggingface/transformers env is
// process-global, (b) the configuredCacheDir check already enforces identical config,
// and (c) each ONNX session allocates ~1.5 GiB native memory — duplicating it when
// the host framework re-loads the plugin exhausts RSS on constrained VMs.
let sharedExtractor: FeatureExtractionPipeline | undefined;
let sharedLoading: Promise<FeatureExtractionPipeline> | undefined;
let sharedRefCount = 0;
let sharedPipelineKey: string | undefined;

interface LocalPipelineSessionOptions {
	graphOptimizationLevel: NonNullable<
		LocalEmbedSessionOptions["graphOptimizationLevel"]
	>;
	enableMemPattern: boolean;
	enableCpuMemArena: boolean;
	freeDimensionOverrides: { batch_size: number };
	executionMode?: NonNullable<LocalEmbedSessionOptions["executionMode"]>;
	interOpNumThreads?: number;
	intraOpNumThreads?: number;
}

interface LocalPipelineIdentity {
	cacheDir: string;
	modelId: string;
	revision: string | undefined;
	dtype: LocalEmbedDtype;
	sessionOptions: LocalEmbedSessionOptions;
}

function buildSessionOptions(
	options: LocalEmbedSessionOptions,
): LocalPipelineSessionOptions {
	const sessionOptions: LocalPipelineSessionOptions = {
		graphOptimizationLevel:
			options.graphOptimizationLevel ??
			LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT.graphOptimizationLevel,
		enableMemPattern:
			options.enableMemPattern ??
			LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT.enableMemPattern,
		enableCpuMemArena:
			options.enableCpuMemArena ??
			LOCAL_EMBEDDING_SESSION_OPTIONS_DEFAULT.enableCpuMemArena,
		freeDimensionOverrides: { batch_size: 1 },
	};
	if (options.executionMode !== undefined) {
		sessionOptions.executionMode = options.executionMode;
	}
	if (options.interOpNumThreads !== undefined) {
		sessionOptions.interOpNumThreads = options.interOpNumThreads;
	}
	if (options.intraOpNumThreads !== undefined) {
		sessionOptions.intraOpNumThreads = options.intraOpNumThreads;
	}
	return sessionOptions;
}

function buildPipelineKey(identity: LocalPipelineIdentity): string {
	return JSON.stringify({
		cacheDir: identity.cacheDir,
		modelId: identity.modelId,
		revision: identity.revision,
		dtype: identity.dtype,
		sessionOptions: buildSessionOptions(identity.sessionOptions),
	});
}

type NumericTensorData = ArrayLike<number> & {
	subarray?: (start: number, end?: number) => ArrayLike<number>;
};

function isNumericTensorData(value: unknown): value is NumericTensorData {
	if (typeof value !== "object" || value === null) return false;
	return "length" in value && typeof value.length === "number";
}

function tensorDataToArray(data: unknown, length: number): number[] {
	if (!isNumericTensorData(data)) {
		throw new Error("Local embedding returned non-array tensor data");
	}
	return typeof data.subarray === "function"
		? Array.from(data.subarray(0, length))
		: Array.from(data).slice(0, length);
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ModelNotFoundError extends Error {
	constructor(modelId: string) {
		super(
			`Local embedding model "${modelId}" not found in cacheDir. ` +
				`Download it via Hugging Face CLI or 'npm run model:pull'.`,
		);
		this.name = "ModelNotFoundError";
	}
}

/** Thrown by `countTokens()` before the model (and its tokenizer) has loaded. */
export class ModelNotLoadedError extends Error {
	constructor(modelId: string) {
		super(
			`Local embedding model "${modelId}" is not loaded yet; ` +
				`await embed() or the embedder warmup before counting tokens.`,
		);
		this.name = "ModelNotLoadedError";
	}
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class LocalEmbedProvider implements DisposableProvider {
	private _disposed = false;
	private readonly cacheDir: string;
	private readonly dtype: LocalEmbedDtype;
	private readonly modelId: string;
	private readonly revision: string | undefined;
	private readonly nativeDim: number;
	private readonly outputDim: number;
	private readonly pooling: LocalEmbedPooling;
	private readonly sessionOptions: LocalEmbedSessionOptions;
	private readonly pipelineKey: string;
	private readonly offline: boolean;
	private readonly mirror: string | undefined;

	/**
	 * Guard: transformers `env` is process-global — only one cacheDir is allowed per process.
	 * Intentionally never reset during normal operation; use `resetStaticState()` only in tests.
	 */
	private static configuredCacheDir: string | undefined;

	/** Reset static state — FOR TESTS ONLY. Not safe in production. */
	static resetStaticState(): void {
		LocalEmbedProvider.configuredCacheDir = undefined;
		sharedExtractor = undefined;
		sharedLoading = undefined;
		sharedRefCount = 0;
		sharedPipelineKey = undefined;
	}

	/** Output dimension exposed to consumers (after Matryoshka truncation, if any). */
	get dimension(): number {
		return this.outputDim;
	}

	constructor(config?: LocalEmbedConfig) {
		// Resolve to absolute path — @huggingface/transformers pathJoin
		// crashes on relative paths when multiple workers load concurrently.
		this.cacheDir = resolve(
			config?.cacheDir ?? LOCAL_EMBEDDING_CACHE_DIR_DEFAULT,
		);
		this.dtype = config?.dtype ?? LOCAL_EMBEDDING_DTYPE_DEFAULT;
		this.modelId = config?.model ?? LOCAL_EMBEDDING_MODEL;
		this.revision =
			config?.revision ??
			(config?.model === undefined ? LOCAL_EMBEDDING_MODEL_REVISION : undefined);
		// Default native dim assumes the bundled PPLX 0.6B (1024). Callers using
		// other models must pass nativeDim explicitly so Matryoshka math is correct.
		this.nativeDim = config?.nativeDim ?? EMBEDDING_DIMENSION;
		this.outputDim = config?.outputDim ?? this.nativeDim;
		if (this.outputDim > this.nativeDim) {
			throw new Error(
				`outputDim (${this.outputDim}) cannot exceed nativeDim (${this.nativeDim}) — ` +
					`Matryoshka truncation only shrinks dimensions.`,
			);
		}
		this.pooling = config?.pooling ?? "mean";
		this.sessionOptions = config?.sessionOptions ?? {};
		this.offline = config?.offline ?? false;
		this.mirror = config?.mirror;
		this.pipelineKey = buildPipelineKey({
			cacheDir: this.cacheDir,
			modelId: this.modelId,
			revision: this.revision,
			dtype: this.dtype,
			sessionOptions: this.sessionOptions,
		});
		sharedRefCount++;
	}

	// ── Pipeline lifecycle ─────────────────────────────────────────────────

	// Single-threaded safety — after `await this._loading` resolves, the assignment
	// to `_extractor` and the `finally` block run synchronously in the same microtask.
	// No concurrent caller can slip between them. If worker threads are introduced,
	// this must be replaced with a proper mutex.
	private async getExtractor(): Promise<FeatureExtractionPipeline> {
		if (this._disposed) throw new Error("LocalEmbedProvider has been disposed");
		this.assertCompatibleSharedPipeline();
		if (sharedExtractor) return sharedExtractor;
		if (sharedLoading) {
			const extractor = await sharedLoading;
			if (this._disposed) {
				throw new Error("LocalEmbedProvider has been disposed");
			}
			if (!sharedExtractor) {
				sharedExtractor = extractor;
			}
			return extractor;
		}

		sharedPipelineKey = this.pipelineKey;
		sharedLoading = this.initPipeline();
		try {
			const extractor = await sharedLoading;
			sharedExtractor = extractor;
			if (this._disposed) {
				throw new Error("LocalEmbedProvider has been disposed");
			}
			return extractor;
		} finally {
			sharedLoading = undefined;
			if (!sharedExtractor && sharedRefCount === 0) {
				sharedPipelineKey = undefined;
			}
		}
	}

	private assertCompatibleSharedPipeline(): void {
		if (
			sharedPipelineKey === undefined ||
			sharedPipelineKey === this.pipelineKey
		) {
			return;
		}
		throw new Error(
			"LocalEmbedProvider shared ONNX pipeline is already loaded with a different " +
				"model, revision, dtype, cacheDir, or sessionOptions. Dispose all live " +
				"providers before changing pipeline configuration.",
		);
	}

	private async initPipeline(): Promise<FeatureExtractionPipeline> {
		// Guard: transformers `env` is process-global — reject conflicting cacheDirs.
		if (
			LocalEmbedProvider.configuredCacheDir !== undefined &&
			LocalEmbedProvider.configuredCacheDir !== this.cacheDir
		) {
			throw new Error(
				`transformers env is global; LocalEmbedProvider cacheDir must be consistent ` +
					`(existing: ${LocalEmbedProvider.configuredCacheDir}, requested: ${this.cacheDir})`,
			);
		}
		LocalEmbedProvider.configuredCacheDir = this.cacheDir;
		// Loaded here, not at module top: transformers pulls in sharp's native binding, and a host
		// that stages dependencies apart (OpenClaw 2026.9.5) fails the whole plugin load on it.
		const { env, pipeline } = await import("@huggingface/transformers");

		// Environment hardening -- set BEFORE pipeline creation.
		// Remote downloads from Hugging Face Hub are enabled by default so that
		// end users get a friction-free first run (no manual model:pull step,
		// no HF account/token — the canonical model is a public anonymous
		// download). Dev/CI environments that must fail-fast on a missing
		// cache can opt out through caller config. A mirror overrides the hub host.
		env.cacheDir = this.cacheDir;
		env.allowRemoteModels = !this.offline;
		env.localModelPath = this.cacheDir;
		// transformers 4.3.0 drops `revision` when it lists model files, so the revision lives in the
		// download path and files stay at <cacheDir>/<model>/, where the offline lookup finds them.
		env.remotePathTemplate = `{model}/resolve/${this.revision ?? "main"}/`;
		const hfEndpoint = this.mirror?.trim();
		if (hfEndpoint) {
			env.remoteHost = hfEndpoint.endsWith("/") ? hfEndpoint : `${hfEndpoint}/`;
		}

		log.info("loading ONNX model", {
			model: this.modelId,
			cacheDir: this.cacheDir,
			dtype: this.dtype,
			nativeDim: this.nativeDim,
			outputDim: this.outputDim,
			sessionOptions: buildSessionOptions(this.sessionOptions),
		}, {
			event_name: "embedder.local.provider.initpipeline",
			file: "packages/embedder/src/local-provider.ts",
			function: "initPipeline",
			site_id: "embedder.local.provider.initpipeline.1",
		});
		const t0 = performance.now();

		try {
			const sessionOptions = buildSessionOptions(this.sessionOptions);
			const extractor = await pipeline("feature-extraction", this.modelId, {
				dtype: this.dtype,
				device: "cpu",
				session_options: sessionOptions,
			});

			const durationMs = Math.round(performance.now() - t0);
			log.info("ONNX model loaded", { durationMs, model: this.modelId }, {
				event_name: "embedder.local.provider.initpipeline",
				file: "packages/embedder/src/local-provider.ts",
				function: "initPipeline",
				site_id: "embedder.local.provider.initpipeline.2",
			});
			return extractor;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (
				msg.includes("no such file") ||
				msg.includes("ENOENT") ||
				msg.includes("not found") ||
				msg.includes("Could not locate file")
			) {
				log.error("ONNX model not found", {
					cacheDir: this.cacheDir,
					model: this.modelId,
				}, {
					event_name: "embedder.local.provider.initpipeline",
					file: "packages/embedder/src/local-provider.ts",
					function: "initPipeline",
					site_id: "embedder.local.provider.initpipeline.3",
				});
				throw new ModelNotFoundError(this.modelId);
			}
			log.error("ONNX model init failed", { error }, {
				event_name: "embedder.local.provider.initpipeline",
				file: "packages/embedder/src/local-provider.ts",
				function: "initPipeline",
				site_id: "embedder.local.provider.initpipeline.4",
			});
			throw error;
		}
	}

	// ── EmbeddingProvider interface ────────────────────────────────────────

	countTokens(text: string): number {
		if (this._disposed) throw new Error("LocalEmbedProvider has been disposed");
		this.assertCompatibleSharedPipeline();
		if (!sharedExtractor) {
			throw new ModelNotLoadedError(this.modelId);
		}
		return sharedExtractor.tokenizer.encode(text, { add_special_tokens: false }).length;
	}

	async embed(text: string): Promise<number[]> {
		const extractor = await this.getExtractor();
		// We pass `normalize: true` so the model returns a unit-length native vector.
		// If we then truncate, the truncated head is no longer unit-length and we
		// re-normalize manually below — Matryoshka requires the truncated prefix
		// to be re-normalized so cosine similarity remains comparable across dims.
		// Pooling is configurable: Qwen3 family uses last_token, pplx-embed uses
		// mean, BERT-style models use cls. Read from `1_Pooling/config.json`.
		const output = await extractor(text, {
			pooling: this.pooling,
			normalize: true,
		});
		const lastDimIndex = output.dims.length - 1;
		if (lastDimIndex < 0) {
			throw new Error("Local embedding returned empty tensor dims");
		}
		const dim = output.dims[lastDimIndex];
		if (dim === undefined) {
			throw new Error("Local embedding returned undefined dimension");
		}
		if (dim !== this.nativeDim) {
			throw new Error(
				`Model "${this.modelId}" produced ${dim}-d native vectors, ` +
					`but provider was configured with nativeDim=${this.nativeDim}.`,
			);
		}
		const native = tensorDataToArray(output.data, dim);
		if (native.length !== this.nativeDim) {
			throw new Error(
				`Expected ${this.nativeDim}-d native embedding, got ${native.length}-d`,
			);
		}
		// Fast path: no truncation requested.
		if (this.outputDim === this.nativeDim) {
			return native;
		}
		return truncateAndRenormalize(native, this.outputDim);
	}

	async embedDocuments(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		log.debug("batch local embedding", { count: texts.length }, {
			event_name: "embedder.local.provider.embeddocuments",
			file: "packages/embedder/src/local-provider.ts",
			function: "embedDocuments",
			site_id: "embedder.local.provider.embeddocuments.5",
		});
		// Sequential loop — ONNX session with batch_size=1 forces CPU-bound serial
		// inference anyway. A loop is explicit and avoids allocating N promise objects.
		const results: number[][] = new Array(texts.length);
		for (let i = 0; i < texts.length; i++) {
			const text = texts[i];
			if (text === undefined) {
				throw new Error(`Missing text at batch index ${i}`);
			}
			results[i] = await this.embed(text);
		}
		return results;
	}

	// ── Lifecycle helpers ──────────────────────────────────────────────────

	async dispose(): Promise<void> {
		if (this._disposed) return;
		log.debug("disposing local embedding provider", {}, {
			event_name: "embedder.local.provider.dispose",
			file: "packages/embedder/src/local-provider.ts",
			function: "dispose",
			site_id: "embedder.local.provider.dispose.6",
		});
		this._disposed = true;
		sharedRefCount = Math.max(0, sharedRefCount - 1);

		if (sharedRefCount > 0) return;

		const pending = sharedLoading;
		if (pending) {
			const extractor = await pending.catch(() => undefined);
			if (sharedRefCount > 0) {
				if (extractor && !sharedExtractor) {
					sharedExtractor = extractor;
				}
				return;
			}
			if (extractor && extractor !== sharedExtractor) {
				await extractor.dispose();
			}
		}

		if (sharedRefCount > 0) return;

		if (sharedExtractor) {
			await sharedExtractor.dispose();
			sharedExtractor = undefined;
		}
		if (sharedLoading === undefined) {
			sharedPipelineKey = undefined;
		}
	}

	async warmup(): Promise<void> {
		await this.embed("warmup");
	}
}

// ─── Matryoshka truncation ───────────────────────────────────────────────────

/**
 * Slice the leading `outputDim` floats and re-L2-normalize.
 *
 * Qwen3 embedding models are trained with Matryoshka representation learning,
 * so the head of a unit-length native vector remains a meaningful (but no
 * longer unit-length) embedding. Re-normalizing keeps cosine similarity
 * comparable across stored vectors of the same truncated dim.
 */
export function truncateAndRenormalize(
	native: number[],
	outputDim: number,
): number[] {
	if (outputDim <= 0 || outputDim > native.length) {
		throw new Error(
			`truncateAndRenormalize: outputDim=${outputDim} out of range for native length ${native.length}`,
		);
	}
	const head = native.slice(0, outputDim);
	let normSq = 0;
	for (let i = 0; i < outputDim; i++) {
		const v = head[i] ?? 0;
		normSq += v * v;
	}
	const norm = Math.sqrt(normSq);
	if (norm === 0) return head;
	for (let i = 0; i < outputDim; i++) {
		head[i] = (head[i] ?? 0) / norm;
	}
	return head;
}
