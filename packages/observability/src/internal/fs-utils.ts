import {
	chmodSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { logger } from "./log.js";

export function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

export function readJsonFile<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			logger.warnRateLimited(`read-json:${path}`, "Sno Observe optional JSON file is unreadable", { path, error }, {
				event_name: "observe.optional_file.unreadable",
				file: "packages/sno-observe/src/internal/fs-utils.ts",
				function: "readJsonFile",
				site_id: "observe.fs_utils.read_json.failed",
			});
		}
		return null;
	}
}

export function atomicWrite(path: string, contents: string | Uint8Array, mode = 0o600): void {
	ensureDir(dirname(path));
	const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmpPath, contents, { mode });
	chmodSync(tmpPath, mode);
	renameSync(tmpPath, path);
	chmodSync(path, mode);
}

export function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
	atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function removeFile(path: string): void {
	rmSync(path, { force: true });
}

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;
const STALE_LOCK_MS = 60_000;

// Cross-process exclusion via O_EXCL + stale-lock breaking. If a holder dies
// (kill -9, VM crash) the lock file persists and would otherwise wedge every
// caller forever; on timeout we treat any lock older than STALE_LOCK_MS as
// abandoned, remove it, and retry once.
export function withFileLock<T>(lockPath: string, fn: () => T): T {
	ensureDir(dirname(lockPath));
	const fd = acquireLock(lockPath);
	try {
		return fn();
	} finally {
		closeSync(fd);
		removeFile(lockPath);
	}
}

function acquireLock(lockPath: string): number {
	const start = Date.now();
	let breakAttempted = false;
	while (true) {
		try {
			return openSync(lockPath, "wx", 0o600);
		} catch (error) {
			if (Date.now() - start <= LOCK_WAIT_MS) {
				sleepSync(LOCK_POLL_MS);
				continue;
			}
			if (!breakAttempted && isLockStale(lockPath)) {
				breakAttempted = true;
				removeFile(lockPath);
				continue;
			}
			throw error;
		}
	}
}

function isLockStale(lockPath: string): boolean {
	try {
		const stat = statSync(lockPath);
		return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
	} catch {
		// Lock vanished between EEXIST and stat — treat as stale, retry.
		return true;
	}
}

function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, end - Date.now()));
	}
}
