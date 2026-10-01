import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Dek, getDek } from "@snoai/sqlite-crypto";

/**
 * Per-test isolation helper.
 *
 * The store list (`dbs.json` manifest) resolves from the home directory, so
 * each test run points `HOME` at a disposable directory; children spawned with
 * `process.env` inherit it. The key is an explicit 64-hex value, as the caller
 * passes `settings.store.encryptionKey`.
 *
 * Caller is responsible for `cleanup()` in `afterEach`.
 */
export interface TestEnv {
	readonly runId: string;
	readonly root: string;
	readonly home: string;
	readonly snoStationCoreConfigDir: string;
	readonly manifestFile: string;
	readonly markerFile: string;
	readonly keyHex: string;
	readonly dek: Dek;
	cleanup(): void;
}

const previousEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
	if (!previousEnv.has(name)) {
		previousEnv.set(name, process.env[name]);
	}
	process.env[name] = value;
}

function restoreEnv(name: string): void {
	const prior = previousEnv.get(name);
	if (prior === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = prior;
	}
	previousEnv.delete(name);
}

export function makeTestEnv(label = "sno-station-core"): TestEnv {
	const runId = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const root = mkdtempSync(join(tmpdir(), `sqlite-crypto-test-${label}-`));
	const home = join(root, "home");
	const snoStationCoreConfigDir = join(home, ".config", "sno-station-core");
	const manifestFile = join(snoStationCoreConfigDir, "dbs.json");
	const markerFile = join(snoStationCoreConfigDir, ".manifest-rename-marker");
	const keyHex = randomBytes(32).toString("hex");

	mkdirSync(snoStationCoreConfigDir, { recursive: true, mode: 0o700 });
	setEnv("HOME", home);
	setEnv("SNO_STATION_CORE_TESTING", "1");

	return {
		runId,
		root,
		home,
		snoStationCoreConfigDir,
		manifestFile,
		markerFile,
		keyHex,
		dek: getDek(keyHex),
		cleanup(): void {
			restoreEnv("HOME");
			restoreEnv("SNO_STATION_CORE_TESTING");
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function uniqueDbPath(env: TestEnv, name = "test"): string {
	return join(env.snoStationCoreConfigDir, "dbs", `${name}-${env.runId}.db`);
}

/**
 * Build node CLI args for spawning a child that imports the workspace package
 * `@snoai/sqlite-crypto` with the `tsx` loader.
 */
export function childNodeArgs(fixturePath: string): string[] {
	return ["--import", "tsx", fixturePath];
}
