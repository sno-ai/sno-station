import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema.ts";
import { writeSettingsFixture } from "../../../packages/memory/fixtures/settings-file-fixture.ts";

const ownedProfiles = new Map<string, string>();
const discoverySchema = z.object({ pid: z.number().int().positive() });
const settingsStoreSchema = z.object({ store: z.object({ path: z.string() }) });

/**
 * Writes `<profileRoot>/settings.json` the way `sno` does, with the store at `dbPath`; a profile whose
 * file already names this store keeps it, and one that names another store refuses. `encryptionKey`
 * is the key the store was created with; without one the file carries a fresh key, which suits only
 * a store the service creates.
 */
export function bindTestMemory(profileRoot: string, dbPath: string, input: unknown, encryptionKey?: string): void {
	const settingsPath = join(profileRoot, "settings.json");
	if (existsSync(settingsPath)) {
		const settings = settingsStoreSchema.parse(JSON.parse(readFileSync(settingsPath, "utf8")));
		if (resolve(settings.store.path) !== resolve(dbPath)) {
			throw new Error(`test profile already names another store: ${profileRoot}`);
		}
	} else {
		const config = pluginConfigSchema.parse(input);
		writeSettingsFixture(profileRoot, {
			mode: config.mode,
			store: { path: resolve(dbPath), ...(encryptionKey === undefined ? {} : { encryptionKey }) },
			embedding: { cacheDir: "" },
			rerank: { mode: config.retrieval.rerank },
			recall: { prompt: { timeoutMs: config.autoRecallTimeoutMs } },
			rem: { operations: config.remOperations, tick: config.remEnhanced?.trigger.tick ?? true },
		});
	}
	ownedProfiles.set(profileRoot, resolve(dbPath));
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
	// A service this process started stays a zombie while the synchronous wait below blocks the event
	// loop that would reap it; an exited zombie is stopped.
	return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.[0] !== "Z";
}

/** Synchronous fixture cleanup must stop the daemon before its SQLite files are removed. */
export function stopTestMemory(dbPath?: string): void {
	for (const [profileRoot, storePath] of ownedProfiles) {
		if (dbPath !== undefined && storePath !== resolve(dbPath)) continue;
		const discoveryPath = join(profileRoot, "station", "sidecar.json");
		if (existsSync(discoveryPath)) {
			const { pid } = discoverySchema.parse(JSON.parse(readFileSync(discoveryPath, "utf8")));
			if (alive(pid)) {
				const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
				if (!environment.includes(`SNO_PROFILE_DIR=${profileRoot}`)) {
					throw new Error(`refusing to stop a foreign sidecar: ${pid}`);
				}
				process.kill(pid, "SIGTERM");
				const deadline = Date.now() + 10_000;
				const sleeper = new Int32Array(new SharedArrayBuffer(4));
				while (alive(pid) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 20);
				if (alive(pid)) throw new Error(`owned test sidecar did not stop: ${pid}`);
			}
		}
		ownedProfiles.delete(profileRoot);
	}
}
