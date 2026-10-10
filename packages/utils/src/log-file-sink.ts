import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { LogLevel } from "./log-encoder.js";

export const MAX_LOG_QUEUE_BYTES: number = 1024 * 1024;
const RETENTION_BYTES = 10 * 1024 ** 3;
const RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const LOCK_WAIT_MS = 1000;
const CLOSE_WAIT_MS = 2000;

interface OwnedFile { name: string; dev: number; ino: number }
interface Ownership { day: string; current: OwnedFile; rotated: OwnedFile[] }
interface RotationIntent { owner: Ownership; replacement: OwnedFile; rotated: OwnedFile; day: string }
interface PendingRecord { line: string; level: LogLevel; bytes: number }
export type SinkNotice = (reason: string, fields?: Record<string, unknown>) => string;

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function validOwnedFile(value: unknown): value is OwnedFile {
	return typeof value === "object" && value !== null && "name" in value
		&& typeof value.name === "string" && value.name === basename(value.name)
		&& "dev" in value && typeof value.dev === "number"
		&& "ino" in value && typeof value.ino === "number";
}

function parseOwnership(raw: string): Ownership {
	const value: unknown = JSON.parse(raw);
	if (typeof value !== "object" || value === null || !("day" in value)
		|| typeof value.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
		|| !("current" in value) || !validOwnedFile(value.current)
		|| !("rotated" in value) || !Array.isArray(value.rotated)
		|| !value.rotated.every(validOwnedFile)) throw new Error("Invalid diagnostic ownership");
	return { day: value.day, current: value.current, rotated: value.rotated };
}

export class LogFileSink {
	private readonly queue: PendingRecord[] = [];
	private queuedBytes = 0;
	private draining: Promise<void> | undefined;
	private initialized = false;
	private disabled = false;
	private closing = false;
	private closed = false;
	private readonly notices = new Set<string>();
	private readonly dropped: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private dailyTimer: ReturnType<typeof setInterval> | undefined;
	private readonly lockPath: string;
	private readonly rotationPath: string;

	constructor(readonly path: string, private readonly notice: SinkNotice, private readonly retention = true) {
		this.lockPath = `${path}.lock`;
		this.rotationPath = `${path}.rotation`;
	}

	status(): { destination: string | null; reason: string | null } {
		return { destination: this.disabled ? null : this.path, reason: this.disabled ? "file_sink_failed" : null };
	}

	enqueue(line: string, level: LogLevel): void {
		if (this.disabled || (this.closing && !this.closed)) return;
		if (this.closed) {
			this.closing = false;
			this.closed = false;
			this.initialized = false;
		}
		const bytes = Buffer.byteLength(line) + 1;
		if (bytes > MAX_LOG_QUEUE_BYTES) { this.dropped[level]++; return; }
		while (this.queuedBytes + bytes > MAX_LOG_QUEUE_BYTES && level !== "debug" && level !== "info") {
			const index = this.queue.findIndex((item) => item.level === "debug" || item.level === "info");
			if (index < 0) break;
			const [removed] = this.queue.splice(index, 1);
			if (removed) { this.queuedBytes -= removed.bytes; this.dropped[removed.level]++; }
		}
		if (this.queuedBytes + bytes > MAX_LOG_QUEUE_BYTES) { this.dropped[level]++; return; }
		this.queue.push({ line, level, bytes });
		this.queuedBytes += bytes;
		this.startDrain();
	}

	private startDrain(): void {
		if (this.draining || !this.queue.length || this.disabled) return;
		this.draining = this.drain().finally(() => {
			this.draining = undefined;
			if (this.queue.length) this.startDrain();
		});
	}

	private report(reason: string, fields?: Record<string, unknown>): void {
		if (this.notices.has(reason)) return;
		this.notices.add(reason);
		const line = this.notice(reason, fields);
		if (reason !== "file_sink_failed" && reason !== "append_lock_timeout") this.enqueue(line, "warn");
	}

	private scheduleRetry(): void {
		if (this.retryTimer || this.closing || this.disabled || !this.retention) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.maintain().catch(() => { this.report("retention_failed"); this.scheduleRetry(); });
		}, RETRY_MS);
		this.retryTimer.unref();
	}

	private async locked<T>(exclusive: boolean, work: (lock: FileHandle) => Promise<T>): Promise<T | undefined> {
		const { tryLock, unlock } = await import("fs-native-extensions");
		const lock = await open(this.lockPath, constants.O_RDWR | constants.O_CREAT
			| constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
		let held = false;
		const deadline = performance.now() + (exclusive ? 0 : LOCK_WAIT_MS);
		try {
			if (!(await lock.stat()).isFile()) throw new Error("Diagnostic lock is not regular");
			do {
				held = tryLock(lock.fd, { shared: !exclusive });
				if (held) return await work(lock);
				if (exclusive || performance.now() >= deadline) break;
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			} while (!this.disabled);
			if (exclusive) this.scheduleRetry();
			else this.report("append_lock_timeout");
			return undefined;
		} finally {
			try { if (held) unlock(lock.fd); } finally { await lock.close(); }
		}
	}

	private async openCurrent(): Promise<FileHandle> {
		const file = await open(this.path, constants.O_WRONLY | constants.O_APPEND
			| constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
		if (!(await file.stat()).isFile()) { await file.close(); throw new Error("Diagnostic file is not regular"); }
		return file;
	}

	private async ownership(lock: FileHandle): Promise<Ownership> {
		const size = (await lock.stat()).size;
		if (size > 1024 * 1024) throw new Error("Diagnostic ownership exceeds bound");
		const raw = Buffer.alloc(size);
		await lock.read(raw, 0, size, 0);
		if (size) return parseOwnership(raw.toString("utf8"));
		const file = await this.openCurrent();
		try {
			const stats = await file.stat();
			return {
				day: stats.mtime.toISOString().slice(0, 10),
				current: { name: basename(this.path), dev: stats.dev, ino: stats.ino }, rotated: [],
			};
		} finally { await file.close(); }
	}

	private async saveOwnership(lock: FileHandle, owner: Ownership): Promise<void> {
		const bytes = Buffer.from(JSON.stringify(owner));
		await lock.write(bytes, 0, bytes.length, 0);
		await lock.truncate(bytes.length);
		await lock.sync();
	}

	private async syncDirectory(): Promise<void> {
		const directory = await open(dirname(this.path), constants.O_RDONLY);
		try { await directory.sync(); } finally { await directory.close(); }
	}

	private async readRotationIntent(): Promise<RotationIntent | undefined> {
		let file: FileHandle;
		try { file = await open(this.rotationPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
		try {
			const stats = await file.stat();
			if (!stats.isFile() || stats.size > 1024 * 1024) throw new Error("Invalid diagnostic rotation intent");
			const value: unknown = JSON.parse(await file.readFile("utf8"));
			if (typeof value !== "object" || value === null || !("owner" in value)
				|| !("replacement" in value) || !validOwnedFile(value.replacement)
				|| !("rotated" in value) || !validOwnedFile(value.rotated)
				|| !("day" in value) || typeof value.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)) {
				throw new Error("Invalid diagnostic rotation intent");
			}
			const owner = parseOwnership(JSON.stringify(value.owner));
			const prefix = `${basename(this.path)}.`;
			if (owner.current.name !== basename(this.path)
				|| !value.replacement.name.startsWith(`${basename(this.path)}.next-`)
				|| !value.rotated.name.startsWith(prefix)
				|| !/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/.test(value.rotated.name.slice(prefix.length))
				|| value.rotated.dev !== owner.current.dev || value.rotated.ino !== owner.current.ino) {
				throw new Error("Invalid diagnostic rotation ownership");
			}
			return { owner, replacement: value.replacement, rotated: value.rotated, day: value.day };
		} finally { await file.close(); }
	}

	private async saveRotationIntent(intent: RotationIntent): Promise<void> {
		const temporary = `${this.rotationPath}.${randomUUID()}.tmp`;
		const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try { await file.writeFile(JSON.stringify(intent)); await file.sync(); }
		finally { await file.close(); }
		await rename(temporary, this.rotationPath);
		await this.syncDirectory();
	}

	private async matches(path: string, owned: OwnedFile): Promise<boolean> {
		try {
			const stats = await lstat(path);
			return stats.isFile() && stats.dev === owned.dev && stats.ino === owned.ino;
		} catch (error) { if (hasCode(error, "ENOENT")) return false; throw error; }
	}

	private async datedName(day: string): Promise<string> {
		const names = new Set(await readdir(dirname(this.path)));
		const dated = `${basename(this.path)}.${day}`;
		let name = dated;
		for (let suffix = 1; names.has(name); suffix++) name = `${dated}.${suffix}`;
		return name;
	}

	private async completeRotation(lock: FileHandle, intent: RotationIntent): Promise<Ownership> {
		const replacementPath = join(dirname(this.path), intent.replacement.name);
		if (await this.matches(this.path, intent.owner.current)) {
			if (!(await this.matches(replacementPath, intent.replacement))) throw new Error("Diagnostic replacement ownership changed");
			let rotatedPath = join(dirname(this.path), intent.rotated.name);
			if (!(await this.matches(rotatedPath, intent.rotated))) {
				try { await link(this.path, rotatedPath); }
				catch (error) {
					if (!hasCode(error, "EEXIST")) throw error;
					intent.rotated.name = await this.datedName(intent.owner.day);
					await this.saveRotationIntent(intent);
					rotatedPath = join(dirname(this.path), intent.rotated.name);
					await link(this.path, rotatedPath);
				}
			}
			// rotation-crash-seam: dated-link-created; the current name still owns the old inode.
			if (!(await this.matches(rotatedPath, intent.rotated)) || !(await this.matches(this.path, intent.owner.current))) {
				throw new Error("Diagnostic rotation ownership changed");
			}
			await rename(replacementPath, this.path);
			// rotation-crash-seam: current-switched; both old and new inodes are recorded in the intent.
		} else if (!(await this.matches(this.path, intent.replacement))) {
			throw new Error("Diagnostic destination ownership changed");
		}
		await this.syncDirectory();
		const owner: Ownership = { day: intent.day,
			current: { ...intent.replacement, name: basename(this.path) },
			rotated: [...intent.owner.rotated, intent.rotated] };
		await this.saveOwnership(lock, owner);
		// rotation-crash-seam: ownership-saved; replay remains idempotent until intent removal.
		await unlink(this.rotationPath);
		await this.syncDirectory();
		return owner;
	}

	private async rotate(lock: FileHandle, owner: Ownership): Promise<Ownership> {
		if (!(await this.matches(this.path, owner.current))) throw new Error("Diagnostic destination ownership changed");
		const name = `${basename(this.path)}.next-${randomUUID()}`;
		const file = await open(join(dirname(this.path), name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		let replacement: OwnedFile;
		try {
			const stats = await file.stat();
			replacement = { name, dev: stats.dev, ino: stats.ino };
			await file.sync();
		} finally { await file.close(); }
		const intent: RotationIntent = { owner, replacement,
			rotated: { ...owner.current, name: await this.datedName(owner.day) },
			day: new Date().toISOString().slice(0, 10) };
		await this.saveRotationIntent(intent);
		// rotation-crash-seam: intent-persisted; no existing log data has moved yet.
		return this.completeRotation(lock, intent);
	}

	private async retain(owner: Ownership): Promise<boolean> {
		const now = Date.now();
		const files: Array<OwnedFile & { size: number; mtimeMs: number }> = [];
		for (const entry of owner.rotated) {
			const prefix = `${basename(this.path)}.`;
			if (!entry.name.startsWith(prefix) || !/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/.test(entry.name.slice(prefix.length))) continue;
			try {
				const stats = await lstat(join(dirname(this.path), entry.name));
				if (stats.isFile() && stats.dev === entry.dev && stats.ino === entry.ino) {
					files.push({ ...entry, size: stats.size, mtimeMs: stats.mtimeMs });
				}
			} catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
		}
		const dateOffset = basename(this.path).length + 1;
		const rotatedDay = (file: OwnedFile): string => file.name.slice(dateOffset, dateOffset + 10);
		files.sort((a, b) => rotatedDay(a).localeCompare(rotatedDay(b)) || a.mtimeMs - b.mtimeMs);
		let total = (await lstat(this.path)).size + files.reduce((sum, file) => sum + file.size, 0);
		const kept: OwnedFile[] = [];
		for (const file of files) {
			const quiescent = now - file.mtimeMs >= RETRY_MS;
			const age = now - Date.parse(`${rotatedDay(file)}T00:00:00.000Z`);
			if (quiescent && (total > RETENTION_BYTES || age > RETENTION_DAYS * DAY_MS)) {
				try { await unlink(join(dirname(this.path), file.name)); total -= file.size; }
				catch { kept.push(file); this.report("retention_delete_failed"); this.scheduleRetry(); }
			} else kept.push(file);
		}
		owner.rotated = kept.map(({ name, dev, ino }) => ({ name, dev, ino }));
		if (total > RETENTION_BYTES) {
			this.report("retention_overrun", { total_bytes: total, limit_bytes: RETENTION_BYTES });
			this.scheduleRetry();
		} else this.notices.delete("retention_overrun");
		return total <= RETENTION_BYTES;
	}

	private async maintain(): Promise<void> {
		if (this.disabled || !this.retention) return;
		await this.locked(true, async (lock) => {
			const intent = await this.readRotationIntent();
			let owner = intent ? await this.completeRotation(lock, intent) : await this.ownership(lock);
			if (owner.day !== new Date().toISOString().slice(0, 10)
				|| (await lstat(this.path)).size > RETENTION_BYTES) owner = await this.rotate(lock, owner);
			await this.retain(owner);
			await this.saveOwnership(lock, owner);
		}).catch(() => { this.report("retention_failed"); this.scheduleRetry(); });
	}

	private async rotateIfNeeded(): Promise<void> {
		if (!this.retention) return;
		const needed = await this.locked(false, async (lock) => {
			if (await this.readRotationIntent()) return true;
			const owner = await this.ownership(lock);
			return owner.day !== new Date().toISOString().slice(0, 10)
				|| (await lstat(this.path)).size > RETENTION_BYTES;
		}).catch(() => { this.report("retention_ownership_unavailable"); this.scheduleRetry(); return false; });
		if (needed) await this.maintain();
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		if (this.retention) {
			await this.maintain();
			this.dailyTimer = setInterval(() => {
				void this.maintain().catch(() => { this.report("retention_failed"); this.scheduleRetry(); });
			}, DAY_MS);
			this.dailyTimer.unref();
		}
		this.initialized = true;
	}

	private async append(line: string): Promise<boolean> {
		for (let pass = 0; pass < 2; pass++) {
			const result = await this.locked(false, async (lock) => {
				if (this.retention && pass === 0) {
					try {
						if (await this.readRotationIntent()) return "rotate";
						const owner = await this.ownership(lock);
						if (owner.day !== new Date().toISOString().slice(0, 10)
							|| (await lstat(this.path)).size > RETENTION_BYTES) return "rotate";
					} catch { this.report("retention_ownership_unavailable"); this.scheduleRetry(); }
				}
				const file = await this.openCurrent();
				try { await file.writeFile(`${line}\n`); } finally { await file.close(); }
				return "written";
			});
			if (result !== "rotate") return result === "written";
			await this.maintain();
		}
		return false;
	}

	private async drain(): Promise<void> {
		try {
			await this.initialize();
			while (this.queue.length && !this.disabled) {
				const record = this.queue.shift();
				if (!record) break;
				try {
					if (!(await this.append(record.line))) this.dropped[record.level]++;
				} finally { this.queuedBytes -= record.bytes; }
				if (Object.values(this.dropped).some((count) => count > 0)) {
					const summary = this.notice("records_dropped", { ...this.dropped });
					if (await this.append(summary)) for (const level of Object.keys(this.dropped) as LogLevel[]) this.dropped[level] = 0;
				}
			}
			await this.rotateIfNeeded();
		} catch {
			this.disabled = true;
			this.report("file_sink_failed");
			this.queue.length = 0;
			this.queuedBytes = 0;
		}
	}

	async close(): Promise<void> {
		this.closing = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		if (this.dailyTimer) clearInterval(this.dailyTimer);
		this.retryTimer = undefined;
		this.dailyTimer = undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let expired = false;
		const deadline = new Promise<void>((resolve) => {
			timer = setTimeout(() => { expired = true; resolve(); }, CLOSE_WAIT_MS);
		});
		try {
			while (!expired && (this.draining || this.queue.length)) {
				this.startDrain();
				await Promise.race([this.draining, deadline]);
			}
		} finally { if (timer) clearTimeout(timer); }
		for (const record of this.queue) this.dropped[record.level]++;
		this.queue.length = 0;
		this.queuedBytes = 0;
		if (Object.values(this.dropped).some((count) => count > 0)) this.report("records_dropped", { ...this.dropped });
		this.closed = true;
	}
}
