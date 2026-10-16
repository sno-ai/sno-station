/**
 * Downloads a model's files into <cacheDir>/<model>/<revision>/, the one place the loaders read a model from.
 *
 * A revision directory is complete when its marker lists the same revision and every file has its expected size;
 * the marker is written last, so an interrupted download is never mistaken for a complete one. One process
 * downloads a directory at a time (an O_EXCL lock with a heartbeat; a dead holder's lock is broken at once).
 */

import { closeSync, createWriteStream, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
	unlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createLogger } from "@snoai/utils/logger";

const log = createLogger("embedder:downloader");

export interface ModelFile {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

export interface ModelSpec {
	readonly id: string;
	readonly revision: string;
	readonly files: readonly ModelFile[];
}

export interface DownloadOptions {
	cacheDir: string;
	/** Hugging Face mirror host, e.g. https://hf-mirror.com. */
	mirror?: string | undefined;
	/** Never fetch: use what is on disk. */
	offline?: boolean | undefined;
}

const HUB = "https://huggingface.co/";
const MARKER = ".complete";
const MAX_REDIRECTS = 5;
/** A connection that sends nothing for this long is dropped (Node's own limit is five minutes). */
const STALL_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_POLL_MS = 2_000;
/** A lock not touched for this long belongs to a holder that hung or died. */
const LOCK_STALE_MS = 900_000;

export function modelDir(cacheDir: string, spec: Pick<ModelSpec, "id" | "revision">): string {
	return join(resolve(cacheDir), spec.id, spec.revision);
}

export function isDownloaded(cacheDir: string, spec: ModelSpec): boolean {
	const dir = modelDir(cacheDir, spec);
	try {
		const marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { revision?: unknown };
		return marker.revision === spec.revision &&
			spec.files.every((file) => statSync(join(dir, file.path), { throwIfNoEntry: false })?.size === file.size);
	} catch {
		return false;
	}
}

// Concurrent callers in one process share one download.
const downloads = new Map<string, Promise<string>>();

/** Makes the model's revision directory complete and returns it. */
export function downloadModel(spec: ModelSpec, options: DownloadOptions): Promise<string> {
	const dir = modelDir(options.cacheDir, spec);
	let download = downloads.get(dir);
	if (!download) {
		download = fetchModel(spec, options, dir).finally(() => downloads.delete(dir));
		downloads.set(dir, download);
	}
	return download;
}

async function fetchModel(spec: ModelSpec, options: DownloadOptions, dir: string): Promise<string> {
	if (isDownloaded(options.cacheDir, spec)) return dir;
	if (options.offline) throw new Error(`${spec.id}@${spec.revision.slice(0, 12)} is not in ${dir} and downloads are off`);
	const lock = `${dir}.lock`;
	await acquireLock(lock);
	const heartbeat = setInterval(() => touch(lock), LOCK_HEARTBEAT_MS);
	try {
		// Another process may have finished it while this one waited.
		if (isDownloaded(options.cacheDir, spec)) return dir;
		const started = performance.now();
		const host = hostOf(options.mirror);
		log.info("model download started", { model: spec.id, revision: spec.revision, cache_dir: dir }, {
			event_name: "embedder.downloader.started", file: "packages/embedder/src/downloader.ts",
			function: "fetchModel", site_id: "embedder.downloader.started",
		});
		adoptFlatFiles(spec, options.cacheDir, dir);
		for (const file of spec.files) {
			const target = join(dir, file.path);
			if (statSync(target, { throwIfNoEntry: false })?.size === file.size) continue;
			await fetchFile(`${host}${spec.id}/resolve/${spec.revision}/${file.path}`, target, file);
		}
		writeFileSync(join(dir, MARKER), JSON.stringify({ model: spec.id, revision: spec.revision, completedAt: new Date().toISOString() }));
		removeOlderCopies(spec, options.cacheDir);
		log.info("model download complete", { model: spec.id, revision: spec.revision,
			duration_ms: Math.round(performance.now() - started) }, {
			event_name: "embedder.downloader.complete", file: "packages/embedder/src/downloader.ts",
			function: "fetchModel", site_id: "embedder.downloader.complete",
		});
		return dir;
	} finally {
		clearInterval(heartbeat);
		rmSync(lock, { force: true });
	}
}

/**
 * Releases before the revision directories kept one copy at <cacheDir>/<model>/<file>: a file of the expected size
 * there moves into the revision directory instead of being fetched again.
 */
function adoptFlatFiles(spec: ModelSpec, cacheDir: string, dir: string): void {
	for (const file of spec.files) {
		const flat = join(resolve(cacheDir), spec.id, file.path);
		const target = join(dir, file.path);
		if (statSync(target, { throwIfNoEntry: false })?.size === file.size) continue;
		if (statSync(flat, { throwIfNoEntry: false })?.size !== file.size) continue;
		mkdirSync(dirname(target), { recursive: true });
		renameSync(flat, target);
	}
}

/** Everything else under <cacheDir>/<model>/ is an older copy; a copy that cannot be removed only costs disk. */
function removeOlderCopies(spec: ModelSpec, cacheDir: string): void {
	const root = join(resolve(cacheDir), spec.id);
	const keep = new Set([spec.revision, `${spec.revision}.lock`]);
	const older = readdirSync(root).filter((entry) => !keep.has(entry)).map((entry) => join(root, entry));
	// The marker the flat layout kept at the cache root.
	older.push(join(resolve(cacheDir), ".download-complete"));
	for (const path of older) {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch (error) {
			log.warn("older model copy not removed", { path, error }, {
				event_name: "embedder.downloader.cleanup_failed", file: "packages/embedder/src/downloader.ts",
				function: "removeOlderCopies", site_id: "embedder.downloader.cleanup_failed",
			});
		}
	}
}

function hostOf(mirror: string | undefined): string {
	const host = mirror?.trim() || HUB;
	return host.endsWith("/") ? host : `${host}/`;
}

async function fetchFile(url: string, target: string, file: ModelFile): Promise<void> {
	mkdirSync(dirname(target), { recursive: true });
	const part = `${target}.part`;
	await get(url, part);
	const size = statSync(part).size;
	if (size !== file.size) throw new Error(`${file.path}: got ${size} bytes, expected ${file.size} (${url})`);
	renameSync(part, target);
}

/** Streams one URL into `part`, following redirects. */
function get(url: string, part: string, redirects = 0): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const client = url.startsWith("https:") ? https : http;
		// HTTP(S)_PROXY and NO_PROXY apply to this request only. `proxyEnv` exists from Node 22.21 and 24.5;
		// @types/node 22.20 does not list it yet.
		const agent = new client.Agent({ proxyEnv: process.env } as http.AgentOptions);
		const request = client.get(url, { agent, headers: { "user-agent": "sno-station" } }, (response) => {
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			if (status >= 300 && status < 400 && location) {
				response.resume();
				if (redirects >= MAX_REDIRECTS) return reject(new Error(`too many redirects (${url})`));
				return get(new URL(location, url).toString(), part, redirects + 1).then(resolvePromise, reject);
			}
			if (status !== 200) {
				response.resume();
				return reject(new Error(`HTTP ${status} (${url})`));
			}
			// Closes the file and the response on either side's error.
			pipeline(response, createWriteStream(part)).then(resolvePromise, reject);
		});
		request.setTimeout(STALL_MS, () => request.destroy(new Error(`no data for ${STALL_MS / 1000} s (${url})`)));
		request.on("error", reject);
	});
}

function touch(lock: string): void {
	try {
		const now = new Date();
		utimesSync(lock, now, now);
	} catch {
		// The lock is gone; the next poll of a waiter treats that as released.
	}
}

function tryLock(lock: string): boolean {
	mkdirSync(dirname(lock), { recursive: true });
	try {
		const fd = openSync(lock, "wx");
		writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
		closeSync(fd);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
		throw error;
	}
}

function lockIsStale(lock: string): boolean {
	try {
		if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) return true;
		const pid = Number.parseInt(readFileSync(lock, "utf8").split("\n")[0] ?? "", 10);
		if (!Number.isInteger(pid) || pid <= 0) return false;
		process.kill(pid, 0);
		return false;
	} catch (error) {
		// No such process: the holder died. Any other error (the lock vanished) also lets the caller try again.
		return !(error instanceof Error && "code" in error && error.code === "EPERM");
	}
}

/** Waits while a live holder keeps its lock fresh; breaks the lock of a holder that died or hung. */
async function acquireLock(lock: string): Promise<void> {
	while (!tryLock(lock)) {
		if (lockIsStale(lock)) {
			try {
				unlinkSync(lock);
			} catch {
				// Another waiter broke it first.
			}
			continue;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
	}
}
