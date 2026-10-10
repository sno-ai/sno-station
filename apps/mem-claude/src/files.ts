import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tryLock, unlock } from "fs-native-extensions";

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
}

export interface PidFileLock {
	release(): Promise<void>;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

export async function acquirePidFileLock(path: string, staleAfterMs: number): Promise<PidFileLock | undefined> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const reclaimPath = `${path}.reclaim`;
	const guard = await open(
		reclaimPath,
		constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
		0o600,
	);
	let held = false;
	const closeGuard = async (): Promise<void> => {
		try {
			if (held) unlock(guard.fd);
		} finally {
			held = false;
			await guard.close();
		}
	};
	try {
		if (!(await guard.stat()).isFile()) throw new Error("Lock guard is not a regular file");
		held = tryLock(guard.fd);
		if (!held) {
			await closeGuard();
			return undefined;
		}
		const [contents, lockStat] = await Promise.all([
			readFile(path, "utf8").catch(() => undefined),
			stat(path).catch(() => undefined),
		]);
		if (contents === "" && lockStat && Date.now() - lockStat.mtimeMs <= staleAfterMs) {
			await closeGuard();
			return undefined;
		}
		// A holder from before an upgrade took its guard with flock, which this lock cannot see on Linux; its fresh pid
		// file is the only sign it still runs.
		const holder = Number(contents?.split(" ")[0]);
		if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && lockStat
			&& Date.now() - lockStat.mtimeMs <= staleAfterMs && alive(holder)) {
			await closeGuard();
			return undefined;
		}
		await unlink(path).catch(error => {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		});
		await writeFile(path, `${process.pid} ${Date.now()}\n`, { flag: "wx", mode: 0o600 });
		return {
			async release() {
				try {
					await unlink(path);
				} finally {
					await closeGuard();
				}
			},
		};
	} catch (error) {
		await closeGuard();
		throw error;
	}
}
