/**
 * Downloads a model's files into <cacheDir>/<model>/<revision>/, the one place the loaders read a model from.
 *
 * A revision directory is complete when its marker names the same revision and file hashes and every file has its
 * expected size; the marker is written last, so an interrupted download is never mistaken for a complete one. One process
 * downloads a directory at a time (an O_EXCL lock with a heartbeat; a dead holder's lock is broken at once).
 */

import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
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
	/** Pinned in code for the bundled models; for other models the hub's LFS hash, when it has one. */
	readonly sha256?: string | undefined;
	/** The hub's git blob id, which changes with every edit; only models resolved from the hub carry it. */
	readonly oid?: string | undefined;
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
const HUB_HOSTS = new Set(["huggingface.co", "hf.co"]);
const MARKER = ".complete";
const MAX_REDIRECTS = 5;
/** A connection that sends nothing for this long is dropped (Node's own limit is five minutes). */
const STALL_MS = 30_000;
/** Tries per file; network errors, stalls, 408, 429 and 5xx wait 1, 2, 4, 8 s (or the server's Retry-After). */
const ATTEMPTS = 5;
const RETRY_AFTER_CAP_MS = 60_000;
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_POLL_MS = 2_000;
/** A lock not touched for this long belongs to a holder that hung or died. */
const LOCK_STALE_MS = 900_000;

export function modelDir(cacheDir: string, spec: Pick<ModelSpec, "id" | "revision">): string {
	return join(resolve(cacheDir), spec.id, revisionDirName(spec.revision));
}

/** One directory level per revision, so a ref such as `refs/pr/1` is not nested (and not mistaken for an older copy). */
function revisionDirName(revision: string): string {
	return revision.replaceAll("/", "--");
}

/** Complete: the marker names this revision and the same hashes, and every file has its expected size. */
export function isDownloaded(cacheDir: string, spec: ModelSpec): boolean {
	const dir = modelDir(cacheDir, spec);
	try {
		const marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { revision?: unknown };
		if (marker.revision !== spec.revision) return false;
		// A branch revision such as `main` can change a file without changing its size.
		const recorded = new Map((readMarkerFiles(dir) ?? []).map((file) => [file.path, file]));
		return spec.files.every((file) => statSync(join(dir, file.path), { throwIfNoEntry: false })?.size === file.size &&
			sameIdentity(file, recorded.get(file.path)));
	} catch {
		return false;
	}
}

function sameIdentity(file: ModelFile, recorded: ModelFile | undefined): boolean {
	return (!file.sha256 || recorded?.sha256 === file.sha256) && (!file.oid || recorded?.oid === file.oid);
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
		const recorded = new Map((readMarkerFiles(dir) ?? []).map((file) => [file.path, file]));
		for (const file of spec.files) {
			const target = join(dir, file.path);
			// A file already here (an earlier release's copy, a try that stopped before the marker) is checked once;
			// offline, a file of the right size is used as it is.
			// A blob id the last download did not record means the file changed on its branch.
			const present = statSync(target, { throwIfNoEntry: false })?.size === file.size &&
				(!file.oid || recorded.get(file.path)?.oid === file.oid);
			if (present && (options.offline || (await matches(target, file)))) continue;
			if (options.offline) throw new Error(`${spec.id}@${spec.revision.slice(0, 12)}: ${file.path} is not in ${dir} and downloads are off`);
			// The working file stays until its replacement is complete: the rename replaces it in one step.
			await fetchFile(spec, `${host}${spec.id}/resolve/${encodeURIComponent(spec.revision)}/${file.path}`, target, file);
		}
		writeFileSync(join(dir, MARKER), JSON.stringify({ model: spec.id, revision: spec.revision, files: spec.files,
			completedAt: new Date().toISOString() }));
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
	const keep = new Set([revisionDirName(spec.revision), `${revisionDirName(spec.revision)}.lock`]);
	// A revision another process is still downloading keeps its directory and its live lock.
	const downloading = (entry: string) => !lockIsStale(join(root, entry.endsWith(".lock") ? entry : `${entry}.lock`));
	const older = readdirSync(root).filter((entry) => !keep.has(entry) && !downloading(entry)).map((entry) => join(root, entry));
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

// transformers.js file names for each dtype: onnx/model<suffix>.onnx, plus onnx/model<suffix>.onnx_data* if large.
const DTYPE_SUFFIX: Readonly<Record<string, string>> = { fp32: "", fp16: "_fp16", int8: "_int8", uint8: "_uint8",
	q8: "_quantized", q4: "_q4", q4f16: "_q4f16", bnb4: "_bnb4" };
const LOADER_FILES = new Set(["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]);

/**
 * The files transformers.js loads for a model that is not pinned in code, as the hub lists them at `revision`;
 * offline, as the marker of the last complete download lists them.
 */
export async function hubModelSpec(id: string, revision: string, dtype: string, options: DownloadOptions): Promise<ModelSpec> {
	const dir = modelDir(options.cacheDir, { id, revision });
	if (options.offline) {
		const files = readMarkerFiles(dir);
		if (!files) throw new Error(`${id}@${revision} is not in ${dir} and downloads are off`);
		return { id, revision, files };
	}
	const weights = `onnx/model${DTYPE_SUFFIX[dtype] ?? ""}.onnx`;
	const url = `${hostOf(options.mirror)}api/models/${id}/tree/${encodeURIComponent(revision)}?recursive=true`;
	// With a complete copy on disk, one try: a hub that is down must not hold the model back.
	const cached = readMarkerFiles(dir);
	let tree: string;
	try {
		tree = cached ? await getText(url) : await withRetries(`${id} file list`, () => getText(url));
	} catch (error) {
		if (!cached) throw error;
		log.warn("hub file list unavailable; using the copy on disk", { model: id, revision, error }, {
			event_name: "embedder.downloader.hub_unavailable", file: "packages/embedder/src/downloader.ts",
			function: "hubModelSpec", site_id: "embedder.downloader.hub_unavailable",
		});
		return { id, revision, files: cached };
	}
	const listed = parseTree(tree);
	const files = listed.filter((file) => LOADER_FILES.has(file.path) || file.path === weights || file.path.startsWith(`${weights}_data`));
	if (!files.some((file) => file.path === weights)) throw new Error(`${id}@${revision} has no ${weights}`);
	return { id, revision, files };
}

function readMarkerFiles(dir: string): ModelFile[] | undefined {
	try {
		const marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { files?: unknown };
		return Array.isArray(marker.files) ? parseTree(marker.files.map((file) => ({ type: "file", ...file }))) : undefined;
	} catch {
		return undefined;
	}
}

/** The hub's tree listing: [{ type, path, size, lfs?: { oid } }]; anything else is not a file it can serve. */
function parseTree(raw: unknown): ModelFile[] {
	const entries = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
	if (!Array.isArray(entries)) throw new Error("the hub's file list is not a list");
	return entries.flatMap((entry: unknown) => {
		if (typeof entry !== "object" || entry === null) return [];
		const { type, path, size, lfs, sha256, oid } = entry as { type?: unknown; path?: unknown; size?: unknown; lfs?: { oid?: unknown }; sha256?: unknown; oid?: unknown };
		if (type !== "file" || typeof path !== "string" || typeof size !== "number") return [];
		const hash = typeof sha256 === "string" ? sha256 : typeof lfs?.oid === "string" ? lfs.oid : undefined;
		return [{ path, size, ...(hash ? { sha256: hash } : {}), ...(typeof oid === "string" ? { oid } : {}) }];
	});
}

function hostOf(mirror: string | undefined): string {
	const host = mirror?.trim() || HUB;
	return host.endsWith("/") ? host : `${host}/`;
}

async function fetchFile(spec: ModelSpec, url: string, target: string, file: ModelFile): Promise<void> {
	mkdirSync(dirname(target), { recursive: true });
	// A part file survives a failed try and a killed process; the next request resumes it.
	const part = `${target}.part`;
	let mismatches = 0;
	await withRetries(`${spec.id} ${file.path}`, async () => {
		if ((statSync(part, { throwIfNoEntry: false })?.size ?? 0) < file.size) await get(url, part);
		const size = statSync(part).size;
		if (size > file.size) rmSync(part, { force: true });
		if (size !== file.size) throw new Error(`got ${size} bytes, expected ${file.size} (${url})`);
		if (!(await matches(part, file)) && ++mismatches === 1) {
			rmSync(part, { force: true });
			throw new Error(`content does not match its SHA-256 (${url})`);
		}
		renameSync(part, target);
	});
}

/**
 * Whether a file has its pinned SHA-256. The check never blocks the model: a second fresh download that still
 * differs is kept with an error in the log, and a check that fails to run counts as a match.
 */
async function matches(path: string, file: ModelFile): Promise<boolean> {
	if (!file.sha256) return true;
	try {
		const hash = createHash("sha256");
		await pipeline(createReadStream(path), hash);
		const actual = hash.digest("hex");
		if (actual === file.sha256) return true;
		log.error("model file SHA-256 differs", { path: file.path, expected_sha256: file.sha256, actual_sha256: actual }, {
			event_name: "embedder.downloader.sha256_mismatch", file: "packages/embedder/src/downloader.ts",
			function: "matches", site_id: "embedder.downloader.sha256_mismatch",
		});
		return false;
	} catch (error) {
		log.warn("model file SHA-256 not checked", { path: file.path, error }, {
			event_name: "embedder.downloader.sha256_unchecked", file: "packages/embedder/src/downloader.ts",
			function: "matches", site_id: "embedder.downloader.sha256_unchecked",
		});
		return true;
	}
}

/** Runs `attemptOnce` until it succeeds, another try cannot help, or ATTEMPTS run out; the error names `label`. */
async function withRetries<T>(label: string, attemptOnce: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await attemptOnce();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const delay = attempt < ATTEMPTS ? retryDelay(error, attempt) : undefined;
			if (delay === undefined) throw new Error(`${label}: ${message} after ${attempt} attempt${attempt === 1 ? "" : "s"}`, { cause: error });
			log.warn("model download failed; retrying", { download_label: label, attempt, delay_ms: delay, error }, {
				event_name: "embedder.downloader.retry", file: "packages/embedder/src/downloader.ts",
				function: "withRetries", site_id: "embedder.downloader.retry",
			});
			await new Promise((resolveWait) => setTimeout(resolveWait, delay));
		}
	}
}

class HttpError extends Error {
	constructor(readonly status: number, readonly retryAfterMs: number | undefined, url: string) {
		super(`HTTP ${status} (${url})`);
	}
}

/** Milliseconds before the next try, or undefined when another try cannot help (404, 401, 403 and other 4xx). */
function retryDelay(error: unknown, attempt: number): number | undefined {
	if (error instanceof HttpError) {
		if (error.status !== 408 && error.status !== 429 && error.status < 500) return undefined;
		if (error.retryAfterMs !== undefined) return Math.min(error.retryAfterMs, RETRY_AFTER_CAP_MS);
	}
	return 1000 * 2 ** (attempt - 1);
}

/** Retry-After in seconds or as an HTTP date. */
function retryAfterMs(header: string | undefined): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
	return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/** The response to `url` after redirects. A socket silent for STALL_MS errors the request and its response. */
function open(url: string, headers: Record<string, string>, redirects = 0): Promise<http.IncomingMessage> {
	return new Promise((resolvePromise, reject) => {
		const client = url.startsWith("https:") ? https : http;
		// HTTP(S)_PROXY and NO_PROXY apply to this request only. `proxyEnv` exists from Node 22.21 and 24.5;
		// @types/node 22.20 does not list it yet.
		const agent = new client.Agent({ proxyEnv: process.env } as http.AgentOptions);
		// A private or gated model needs the user's token; it goes to the hub itself, never to a mirror or the CDN.
		const token = HUB_HOSTS.has(new URL(url).hostname) ? (process.env["HF_TOKEN"] ?? process.env["HF_ACCESS_TOKEN"]) : undefined;
		const auth = token ? { authorization: `Bearer ${token}` } : {};
		const request = client.get(url, { agent, headers: { "user-agent": "sno-station", ...auth, ...headers } }, (response) => {
			const location = response.headers.location;
			const status = response.statusCode ?? 0;
			if (status < 300 || status >= 400 || !location) return resolvePromise(response);
			response.resume();
			if (redirects >= MAX_REDIRECTS) return reject(new Error(`too many redirects (${url})`));
			open(new URL(location, url).toString(), headers, redirects + 1).then(resolvePromise, reject);
		});
		request.setTimeout(STALL_MS, () => request.destroy(new Error(`no data for ${STALL_MS / 1000} s (${url})`)));
		request.on("error", reject);
	});
}

/** Streams one URL into `part`, resuming after the bytes already there. */
async function get(url: string, part: string): Promise<void> {
	const start = statSync(part, { throwIfNoEntry: false })?.size ?? 0;
	const response = await open(url, start > 0 ? { range: `bytes=${start}-` } : {});
	const status = response.statusCode ?? 0;
	const resumed = status === 206 && response.headers["content-range"]?.startsWith(`bytes ${start}-`) === true;
	if (status === 416 || (status === 206 && !resumed)) {
		// The host will not continue this part: start the file over on the next try.
		response.resume();
		rmSync(part, { force: true });
		throw new Error(`HTTP ${status}: the host did not resume at byte ${start} (${url})`);
	}
	if (status !== 200 && status !== 206) {
		response.resume();
		throw new HttpError(status, retryAfterMs(response.headers["retry-after"]), url);
	}
	// Closes the file and the response on either side's error.
	await pipeline(response, createWriteStream(part, { flags: resumed ? "a" : "w" }));
}

async function getText(url: string): Promise<string> {
	const response = await open(url, { accept: "application/json" });
	if (response.statusCode !== 200) {
		response.resume();
		throw new HttpError(response.statusCode ?? 0, retryAfterMs(response.headers["retry-after"]), url);
	}
	let text = "";
	for await (const chunk of response) text += String(chunk);
	return text;
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
