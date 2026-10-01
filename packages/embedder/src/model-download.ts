/**
 * model-download.ts — Shared ONNX model download utility.
 *
 * Idempotent: skips download when a .download-complete marker and .onnx files
 * exist in cacheDir. Interrupted downloads (no marker) trigger re-download.
 * User-facing progress goes to stderr (not stdout) so it doesn't interfere
 * with structured log output or piped commands.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { createLogger } from "@snoai/utils/logger";
import {
	LOCAL_EMBEDDING_CACHE_DIR_DEFAULT,
	LOCAL_EMBEDDING_DTYPE_DEFAULT,
	LOCAL_EMBEDDING_MODEL,
	LOCAL_EMBEDDING_MODEL_REVISION,
} from "./constants";

const log = createLogger("embedder:model-download");

// ─── Constants ──────────────────────────────────────────────────────────────

const RAM_THRESHOLD_GB = 8;

/** Marker file written after a successful download to distinguish complete vs partial cache. */
const DOWNLOAD_COMPLETE_MARKER = ".download-complete";

/** Lock file for cross-process download serialization (O_EXCL based). */
const DOWNLOAD_LOCK_FILE = ".download-lock";

/** Max time (ms) to wait for another process's download before giving up. */
const LOCK_WAIT_TIMEOUT_MS = 600_000; // 10 min

/** Poll interval (ms) when waiting for a competing download to finish. */
const LOCK_POLL_INTERVAL_MS = 2_000;

/** Stale lock threshold (ms) — locks older than this are assumed abandoned. */
const LOCK_STALE_MS = 900_000; // 15 min

/** Lock heartbeat interval (ms) while owning the download lock. */
const LOCK_HEARTBEAT_INTERVAL_MS = 5_000;

type Dtype = "q4" | "q8" | "fp16" | "fp32";

/** Shape of the JSON written to .download-complete marker file. */
interface DownloadMarker {
	model: string;
	revision: string;
	dtype: string;
	completedAt: string;
}

function parseDownloadMarker(raw: string): DownloadMarker | null {
	try {
		const parsed = JSON.parse(raw) as {
			model?: unknown;
			revision?: unknown;
			dtype?: unknown;
			completedAt?: unknown;
		};
		const model = parsed.model;
		const revision = parsed.revision;
		const dtype = parsed.dtype;
		const completedAt = parsed.completedAt;
		if (
			typeof model !== "string" ||
			typeof revision !== "string" ||
			typeof dtype !== "string" ||
			typeof completedAt !== "string"
		) {
			return null;
		}
		return {
			model,
			revision,
			dtype,
			completedAt,
		};
	} catch {
		return null;
	}
}

const DTYPE_SIZES: Record<Dtype, string> = {
	q4: "~400MB",
	q8: "~639MB",
	fp16: "~1.2GB",
	fp32: "~2.4GB",
};

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
 * Check if a valid model download exists in cacheDir.
 *
 * When `expectedRevision` and/or `expectedDtype` are provided, the marker
 * metadata is validated against them — a mismatch (e.g. after model upgrade)
 * returns false so the caller re-downloads. Without these params the check
 * is structural only (marker + .onnx files), which is appropriate for
 * lock-wait polling where dtype/revision aren't available.
 */
export function isModelCached(
	cacheDir: string,
	expectedRevision?: string,
	expectedDtype?: string,
): boolean {
	try {
		if (!existsSync(cacheDir)) return false;
		// Require both the completion marker AND at least one .onnx file.
		// A partial/interrupted download will have .onnx files but no marker,
		// triggering a re-download on next startup.
		const markerPath = join(cacheDir, DOWNLOAD_COMPLETE_MARKER);
		if (!existsSync(markerPath)) return false;
		// Files live at <cacheDir>/<model>/; a cache in the older <model>/<revision>/ layout re-downloads.
		const onnxDir = join(cacheDir, LOCAL_EMBEDDING_MODEL, "onnx");
		if (!existsSync(onnxDir) || !readdirSync(onnxDir).some((e) => e.endsWith(".onnx"))) {
			return false;
		}

		// Validate marker metadata against expected revision/dtype when provided.
		// Prevents silently using stale artifacts after a model or dtype upgrade.
		if (expectedRevision !== undefined || expectedDtype !== undefined) {
			const raw = readFileSync(markerPath, "utf8");
			const marker = parseDownloadMarker(raw);
			if (!marker) {
				// Marker exists but unreadable/unparseable — treat as invalid cache.
				log.warn("download marker is corrupt, re-download needed", {
					cacheDir,
				}, {
					event_name: "embedder.model.download.ismodelcached",
					file: "packages/embedder/src/model-download.ts",
					function: "isModelCached",
					site_id: "embedder.model.download.ismodelcached.1",
				});
				return false;
			}
			if (
				expectedRevision !== undefined &&
				marker.revision !== expectedRevision
			) {
				log.info("cached model revision mismatch, re-download needed", {
					cached: String(marker.revision),
					expected: expectedRevision,
				}, {
					event_name: "embedder.model.download.ismodelcached",
					file: "packages/embedder/src/model-download.ts",
					function: "isModelCached",
					site_id: "embedder.model.download.ismodelcached.2",
				});
				return false;
			}
			if (expectedDtype !== undefined && marker.dtype !== expectedDtype) {
				log.info("cached model dtype mismatch, re-download needed", {
					cached: String(marker.dtype),
					expected: expectedDtype,
				}, {
					event_name: "embedder.model.download.ismodelcached",
					file: "packages/embedder/src/model-download.ts",
					function: "isModelCached",
					site_id: "embedder.model.download.ismodelcached.3",
				});
				return false;
			}
		}

		return true;
	} catch (error: unknown) {
		log.warn("failed to inspect model cache directory", {
			cacheDir,
			error,
		}, {
			event_name: "embedder.model.download.ismodelcached",
			file: "packages/embedder/src/model-download.ts",
			function: "isModelCached",
			site_id: "embedder.model.download.ismodelcached.4",
		});
		return false;
	}
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

// ─── File lock ──────────────────────────────────────────────────────────────

/**
 * Acquire an exclusive download lock using O_EXCL (atomic create-if-not-exists).
 * Returns true if lock acquired, false if another process holds it.
 */
function tryAcquireLock(cacheDir: string): boolean {
	const lockPath = join(cacheDir, DOWNLOAD_LOCK_FILE);
	try {
		mkdirSync(cacheDir, { recursive: true });
		const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL | O_WRONLY
		writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
		closeSync(fd);
		return true;
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			return false;
		}
		throw error;
	}
}

function releaseLock(cacheDir: string): void {
	try {
		unlinkSync(join(cacheDir, DOWNLOAD_LOCK_FILE));
	} catch {
		// Already removed or never existed — safe to ignore.
	}
}

function heartbeatLock(cacheDir: string): void {
	const lockPath = join(cacheDir, DOWNLOAD_LOCK_FILE);
	try {
		const now = new Date();
		utimesSync(lockPath, now, now);
	} catch {
		// Lock may already be gone; ignore.
	}
}

function isLockStale(cacheDir: string): boolean {
	const lockPath = join(cacheDir, DOWNLOAD_LOCK_FILE);
	try {
		const stat = statSync(lockPath);
		if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true;
		// A holder that was interrupted (Ctrl-C during install) is gone; do not wait out the stale window.
		const pid = Number.parseInt(readFileSync(lockPath, "utf8").split("\n")[0] ?? "", 10);
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try { process.kill(pid, 0); return false; } catch (error) {
			return error instanceof Error && "code" in error && error.code === "ESRCH";
		}
	} catch {
		return true; // File gone → treat as stale so caller can proceed
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for an existing download lock to be released (another process finishing).
 * If the lock is stale (abandoned), break it and return so the caller can retry.
 *
 * `expectedRevision` / `expectedDtype` are forwarded to `isModelCached` so a
 * concurrent revision/dtype upgrade is not satisfied by a stale matching-shape
 * cache from the previous version. Without them, two processes upgrading the
 * same cacheDir can both return "finished" on the old artifacts.
 */
async function waitForLock(
	cacheDir: string,
	expectedRevision?: string,
	expectedDtype?: string,
): Promise<void> {
	const lockPath = join(cacheDir, DOWNLOAD_LOCK_FILE);
	const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

	log.info("another process is downloading the model, waiting...", {
		cacheDir,
	}, {
		event_name: "embedder.model.download.waitforlock",
		file: "packages/embedder/src/model-download.ts",
		function: "waitForLock",
		site_id: "embedder.model.download.waitforlock.6",
	});
	process.stderr.write("  Waiting for another download to finish...\n");

	while (Date.now() < deadline) {
		// Lock released?
		if (!existsSync(lockPath)) return;
		// Download finished while we waited?
		if (isModelCached(cacheDir, expectedRevision, expectedDtype)) return;
		// Stale lock from a crashed process?
		if (isLockStale(cacheDir)) {
			log.warn("breaking stale download lock", { cacheDir }, {
				event_name: "embedder.model.download.waitforlock",
				file: "packages/embedder/src/model-download.ts",
				function: "waitForLock",
				site_id: "embedder.model.download.waitforlock.7",
			});
			releaseLock(cacheDir);
			return;
		}
		await sleep(LOCK_POLL_INTERVAL_MS);
	}

	// Throw instead of breaking the lock — a slow but active download would
	// have its lock removed, leading to concurrent writers corrupting the cache.
	throw new Error(
		`Timed out (${LOCK_WAIT_TIMEOUT_MS / 1000}s) waiting for model download lock. ` +
			`Another process may still be downloading. ` +
			`Check ${join(cacheDir, DOWNLOAD_LOCK_FILE)}`,
	);
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Ensure the local ONNX embedding model is downloaded. Idempotent.
 *
 * - If .download-complete marker + .onnx files exist in cacheDir, logs "already cached" and returns.
 * - Otherwise, downloads with progress output to stderr.
 * - Resets `env.allowRemoteModels = false` after download to prevent
 *   surprise network calls during inference.
 */
export async function ensureModelDownloaded(
	opts?: EnsureModelDownloadedOptions,
): Promise<void> {
	const cacheDir = opts?.cacheDir ?? LOCAL_EMBEDDING_CACHE_DIR_DEFAULT;
	const ramGB = getSystemRamGB();
	const dtype = opts?.dtype ?? (LOCAL_EMBEDDING_DTYPE_DEFAULT as Dtype);

	// Already cached — fast path (validates revision + dtype match)
	if (isModelCached(cacheDir, LOCAL_EMBEDDING_MODEL_REVISION, dtype)) {
		const sizeMB = getDirSizeMB(cacheDir);
		log.info("local embedding model already cached", { sizeMB, cacheDir }, {
			event_name: "embedder.model.download.ensuremodeldownloaded",
			file: "packages/embedder/src/model-download.ts",
			function: "ensureModelDownloaded",
			site_id: "embedder.model.download.ensuremodeldownloaded.8",
		});
		return;
	}

	// Offline hosts load (or fail on) the staged cache exactly as the provider does; never fetch here.
	if (opts?.offline) return;
	// A lock left behind with no marker is the only evidence of an interrupted download.
	const lockWasPresent = existsSync(join(cacheDir, DOWNLOAD_LOCK_FILE));

	// Cross-process serialization: if another process is already downloading,
	// wait for it instead of racing to write the same files.
	if (!tryAcquireLock(cacheDir)) {
		await waitForLock(cacheDir, LOCAL_EMBEDDING_MODEL_REVISION, dtype);
		// Re-check: the other process may have completed the download.
		if (isModelCached(cacheDir, LOCAL_EMBEDDING_MODEL_REVISION, dtype)) {
			const sizeMB = getDirSizeMB(cacheDir);
			log.info("local embedding model already cached (downloaded by another process)", {
					sizeMB,
					cacheDir,
				}, {
					event_name: "embedder.model.download.ensuremodeldownloaded",
					file: "packages/embedder/src/model-download.ts",
					function: "ensureModelDownloaded",
					site_id: "embedder.model.download.ensuremodeldownloaded.9",
				});
			return;
		}
		// Other process failed or lock was stale — acquire and download ourselves.
		if (!tryAcquireLock(cacheDir)) {
			throw new Error(
				"Failed to acquire model download lock after waiting. " +
					"Another process may still be downloading. " +
					`Check ${join(cacheDir, DOWNLOAD_LOCK_FILE)}`,
			);
		}
	}

	// Outer try/finally: ensures lock is ALWAYS released, even if banner/log/env
	// setup throws (defensive — these are non-throwing in practice).
	const modelDir = join(cacheDir, LOCAL_EMBEDDING_MODEL);
	let completed = false;
	let startedEmpty = false;
	const lockHeartbeat = setInterval(
		() => heartbeatLock(cacheDir),
		LOCK_HEARTBEAT_INTERVAL_MS,
	);
	try {
		heartbeatLock(cacheDir);
		if (lockWasPresent) {
			// An earlier holder died mid-download: its partial model would load truncated and fail on
			// every later run.
			rmSync(join(cacheDir, DOWNLOAD_COMPLETE_MARKER), { force: true });
			rmSync(modelDir, { recursive: true, force: true });
		} else if (!existsSync(join(cacheDir, DOWNLOAD_COMPLETE_MARKER)) && existsSync(modelDir) &&
			existsSync(join(modelDir, "onnx")) && readdirSync(join(modelDir, "onnx")).some((e) => e.endsWith(".onnx"))) {
			// A cache the loader or a deploy script filled has no marker; adopt it rather than refetch.
			writeFileSync(join(cacheDir, DOWNLOAD_COMPLETE_MARKER), JSON.stringify({
				model: LOCAL_EMBEDDING_MODEL, revision: LOCAL_EMBEDDING_MODEL_REVISION, dtype,
				completedAt: new Date().toISOString(),
			}));
			completed = true;
			return;
		}
		startedEmpty = !existsSync(modelDir);
		// User-facing banner to stderr
		const banner = [
			"",
			"Downloading local embedding model (first run only)",
			`${"─".repeat(52)}`,
			`  Model:     ${LOCAL_EMBEDDING_MODEL}`,
			`  Revision:  ${LOCAL_EMBEDDING_MODEL_REVISION.slice(0, 12)}`,
			`  Dtype:     ${dtype} (${getDtypeDisplaySize(dtype)})`,
			`  RAM:       ${ramGB}GB`,
			`  Cache dir: ${cacheDir}`,
			"",
			"  This may take a few minutes on the first run...",
			"",
		];
		process.stderr.write(`${banner.join("\n")}\n`);

		log.info("starting model download", {
			model: LOCAL_EMBEDDING_MODEL,
			revision: LOCAL_EMBEDDING_MODEL_REVISION,
			dtype,
			cacheDir,
		}, {
			event_name: "embedder.model.download.ensuremodeldownloaded",
			file: "packages/embedder/src/model-download.ts",
			function: "ensureModelDownloaded",
			site_id: "embedder.model.download.ensuremodeldownloaded.10",
		});

		const { env, pipeline } = await import("@huggingface/transformers");
		// Save current transformer env state so we can restore it after download.
		// Only allowRemoteModels is security-critical, but cacheDir and localModelPath
		// should also be restored to avoid side effects in shared runtime contexts.
		const prevCacheDir = env.cacheDir;
		const prevAllowRemote = env.allowRemoteModels;
		const prevLocalModelPath = env.localModelPath;
		const prevRemoteHost = env.remoteHost;
		const prevRemotePathTemplate = env.remotePathTemplate;

		// Allow remote models ONLY for this download
		env.cacheDir = cacheDir;
		env.allowRemoteModels = true;
		env.localModelPath = cacheDir;
		// Same pinning as LocalEmbedProvider: transformers 4.3.0 drops `revision` when listing files.
		env.remotePathTemplate = `{model}/resolve/${LOCAL_EMBEDDING_MODEL_REVISION}/`;
		if (opts?.mirror) env.remoteHost = opts.mirror.endsWith("/") ? opts.mirror : `${opts.mirror}/`;

		let lastProgress = 0;
		const startTime = performance.now();

		try {
			await pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL, {
				dtype,
				device: "cpu",
				progress_callback: (progress: {
					status: string;
					progress?: number;
					file?: string;
				}) => {
					if (
						progress.status === "progress" &&
						typeof progress.progress === "number"
					) {
						const pct = Math.round(progress.progress);
						if (pct >= lastProgress + 10) {
							lastProgress = pct;
							process.stderr.write(`  ${pct}% — ${progress.file ?? ""}\n`);
						}
					} else if (progress.status === "done" && progress.file) {
						process.stderr.write(`  done ${progress.file}\n`);
					}
				},
			});
		} finally {
			// Restore all transformer env properties regardless of success/failure.
			// allowRemoteModels is security-critical (prevents surprise network
			// calls during inference), but restoring all three avoids side effects.
			env.cacheDir = prevCacheDir;
			env.allowRemoteModels = prevAllowRemote;
			env.localModelPath = prevLocalModelPath;
			env.remoteHost = prevRemoteHost;
			env.remotePathTemplate = prevRemotePathTemplate;
		}

		// Write completion marker so isModelCached() can distinguish a complete
		// download from an interrupted one. Written AFTER pipeline() succeeds.
		writeFileSync(
			join(cacheDir, DOWNLOAD_COMPLETE_MARKER),
			JSON.stringify({
				model: LOCAL_EMBEDDING_MODEL,
				revision: LOCAL_EMBEDDING_MODEL_REVISION,
				dtype,
				completedAt: new Date().toISOString(),
			}),
		);
		completed = true;

		const elapsedSec = Math.round((performance.now() - startTime) / 1000);
		const finalSizeMB = getDirSizeMB(cacheDir);

		const summary = [
			"",
			"  Download complete!",
			`  Size: ${finalSizeMB}MB | Time: ${elapsedSec}s`,
			`  Location: ${cacheDir}`,
			"",
		];
		process.stderr.write(`${summary.join("\n")}\n`);

		log.info("model download complete", {
			model: LOCAL_EMBEDDING_MODEL,
			revision: LOCAL_EMBEDDING_MODEL_REVISION,
			dtype,
			sizeMB: finalSizeMB,
			elapsedSec,
			cacheDir,
		}, {
			event_name: "embedder.model.download.ensuremodeldownloaded",
			file: "packages/embedder/src/model-download.ts",
			function: "ensureModelDownloaded",
			site_id: "embedder.model.download.ensuremodeldownloaded.11",
		});
	} finally {
		// Always release the lock — on success (after marker is written) or
		// failure (so future processes can retry without waiting for stale lock).
		clearInterval(lockHeartbeat);
		// A failed fetch into an empty folder leaves a partial model with no lock; remove it so the
		// next run downloads again instead of adopting it.
		if (!completed && startedEmpty) rmSync(modelDir, { recursive: true, force: true });
		releaseLock(cacheDir);
	}
}
