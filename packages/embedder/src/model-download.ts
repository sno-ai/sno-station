/**
 * model-download.ts — the bundled embedding model's files at its pinned revision, fetched through the shared
 * downloader. User-facing progress goes to stderr (not stdout) so it doesn't interfere with structured log output
 * or piped commands.
 */

import { readdirSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { createLogger } from "@snoai/utils/logger";
import {
	LOCAL_EMBEDDING_CACHE_DIR_DEFAULT,
	LOCAL_EMBEDDING_DTYPE_DEFAULT,
	LOCAL_EMBEDDING_MODEL,
	LOCAL_EMBEDDING_MODEL_REVISION,
} from "./constants";
import { downloadModel, isDownloaded, type ModelFile, type ModelSpec } from "./downloader";
import type { LocalEmbedDtype } from "./types";

const log = createLogger("embedder:model-download");

// ─── Constants ──────────────────────────────────────────────────────────────

const RAM_THRESHOLD_GB = 8;

type Dtype = "q4" | "q8" | "fp16" | "fp32";

const DTYPE_SIZES: Record<Dtype, string> = {
	q4: "~400MB",
	q8: "~639MB",
	fp16: "~1.2GB",
	// The pinned repository ships its int8 weights under the fp32 name too.
	fp32: "~639MB",
};

const TOKENIZER_FILES: readonly ModelFile[] = [
	{ path: "config.json", size: 1651, sha256: "c851a73845113421a2dd85b34446371635844b3875859794fb0d5fc9aee9948d" },
	{ path: "tokenizer.json", size: 11423016, sha256: "db86c3db621fcbcb43e5dd8981d46a9b30b715a41ce8994a9420ec5c8c3797d3" },
	{ path: "tokenizer_config.json", size: 768, sha256: "62b1e4690e44d8c7bec7f22f228331db2d9886160ed7dc4b2068ca24af87d68a" },
];

/** The weights for each dtype at the pinned revision; the repository ships one int8 file under both names. */
const WEIGHTS: Partial<Record<LocalEmbedDtype, ModelFile>> = {
	q8: { path: "onnx/model_quantized.onnx", size: 602401737, sha256: "b514c342c20aec2431ea213bde1a03083e117ac3b6e77ba6eee57cac8b79cd29" },
	fp32: { path: "onnx/model.onnx", size: 602401737, sha256: "b514c342c20aec2431ea213bde1a03083e117ac3b6e77ba6eee57cac8b79cd29" },
};

/** The bundled embedding model's files at its pinned revision for one dtype. */
export function embeddingModelSpec(dtype: LocalEmbedDtype = LOCAL_EMBEDDING_DTYPE_DEFAULT): ModelSpec {
	const weights = WEIGHTS[dtype];
	if (!weights) throw new Error(`${LOCAL_EMBEDDING_MODEL} has no ${dtype} file at revision ${LOCAL_EMBEDDING_MODEL_REVISION}; use q8 or fp32`);
	return { id: LOCAL_EMBEDDING_MODEL, revision: LOCAL_EMBEDDING_MODEL_REVISION, files: [...TOKENIZER_FILES, weights] };
}

// ─── Public types ───────────────────────────────────────────────────────────

export interface EnsureModelDownloadedOptions {
	cacheDir?: string;
	dtype?: Dtype;
	offline?: boolean;
	mirror?: string;
}

// ─── Helpers (exported for reuse by CLI) ────────────────────────────────────

export function getSystemRamGB(): number {
	return Math.round(totalmem() / (1024 * 1024 * 1024));
}

export function recommendDtype(ramGB: number): "q4" | "q8" {
	return ramGB >= RAM_THRESHOLD_GB ? "q8" : "q4";
}

/**
 * Whether the bundled embedding model is complete in cacheDir at the pinned (or the given) revision; with no dtype,
 * a complete download of any dtype the model ships counts.
 */
export function isModelCached(cacheDir: string, expectedRevision?: string, expectedDtype?: string): boolean {
	if (expectedRevision !== undefined && expectedRevision !== LOCAL_EMBEDDING_MODEL_REVISION) return false;
	const dtypes = expectedDtype === undefined ? Object.keys(WEIGHTS) : [expectedDtype];
	return dtypes.some((dtype) => WEIGHTS[dtype as LocalEmbedDtype] !== undefined && isDownloaded(cacheDir, embeddingModelSpec(dtype as LocalEmbedDtype)));
}

export function getDirSizeMB(dirPath: string): number {
	let total = 0;
	try {
		const entries = readdirSync(dirPath, { recursive: true });
		for (const entry of entries) {
			if (typeof entry !== "string") continue;
			const fullPath = join(dirPath, entry);
			try {
				const stat = statSync(fullPath);
				if (stat.isFile()) total += stat.size;
			} catch {
				// skip individual unreadable files (permissions, broken symlinks)
			}
		}
	} catch (error: unknown) {
		log.warn("failed to read directory for size calculation", {
			dirPath,
			error,
		}, {
			event_name: "embedder.model.download.getdirsizemb",
			file: "packages/embedder/src/model-download.ts",
			function: "getDirSizeMB",
			site_id: "embedder.model.download.getdirsizemb.5",
		});
	}
	return Math.round(total / (1024 * 1024));
}

export function getDtypeDisplaySize(dtype: Dtype): string {
	return DTYPE_SIZES[dtype] ?? "unknown size";
}

// ─── Main entry point ───────────────────────────────────────────────────────

/** Downloads the bundled embedding model into cacheDir unless it is already complete there. */
export async function ensureModelDownloaded(opts?: EnsureModelDownloadedOptions): Promise<void> {
	const cacheDir = opts?.cacheDir ?? LOCAL_EMBEDDING_CACHE_DIR_DEFAULT;
	const dtype = opts?.dtype ?? (LOCAL_EMBEDDING_DTYPE_DEFAULT as Dtype);
	const spec = embeddingModelSpec(dtype);
	const fetching = !opts?.offline && !isDownloaded(cacheDir, spec);
	const started = performance.now();
	if (fetching) process.stderr.write(`\nPreparing the local embedding model (a first run downloads ${getDtypeDisplaySize(dtype)})...\n`);
	await downloadModel(spec, { cacheDir, offline: opts?.offline, mirror: opts?.mirror });
	if (fetching) process.stderr.write(`  Ready in ${Math.round((performance.now() - started) / 1000)}s: ${cacheDir}\n`);
	log.info("local embedding model ready", { cacheDir, dtype }, {
		event_name: "embedder.model.download.complete", file: "packages/embedder/src/model-download.ts",
		function: "ensureModelDownloaded", site_id: "embedder.model.download.complete",
	});
}
