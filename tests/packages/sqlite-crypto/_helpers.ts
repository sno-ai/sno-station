import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _resetDekCache } from "@snoai/sno-station-core-crypto";
import { KEY_FILE_ENV } from "../../../packages/sno-station-core-crypto/src/config.ts";
import { _provisionKey } from "../../../packages/sno-station-core-crypto/src/dek.ts";

const RECOVERY_FIXTURE_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);

/**
 * Per-test isolation helper.
 *
 * The production code reads the manifest root, explicit key path, and
 * keychain namespace from the environment. Tests isolate all three from real
 * host state.
 *
 * Each test run gets:
 *   - a disposable manifest/database root under `os.tmpdir()`
 *   - a separately and explicitly provisioned fake key under the test user's home
 *   - a unique `SNO_STATION_CORE_KEYCHAIN_SERVICE` so concurrent runs / parallel tests
 *     never collide on the same keychain entry
 *
 * Caller is responsible for `cleanup()` in `afterEach`. The helper deliberately
 * does NOT remove keychain entries on its own — entry removal is part of the
 * production API surface (`getDek` / `setPassphrase`) and tests assert against it.
 */
export interface TestEnv {
	readonly runId: string;
	readonly xdgConfigHome: string;
	readonly durableKeyRoot: string;
	readonly snoStationCoreConfigDir: string;
	readonly keyFile: string;
	readonly manifestFile: string;
	readonly markerFile: string;
	readonly keychainService: string;
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

export function makeTestEnv(
	label = "sno-station-core",
	options: { provisionKey?: boolean } = {},
): TestEnv {
	const runId = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const xdgConfigHome = mkdtempSync(join(tmpdir(), `${label}-test-`));
	const durableKeyRoot = mkdtempSync(
		join(homedir(), ".sno-station-core-test-"),
	);
	const snoStationCoreConfigDir = join(xdgConfigHome, "sno-station-core");
	const keyFile = join(durableKeyRoot, "key");
	const manifestFile = join(snoStationCoreConfigDir, "dbs.json");
	const markerFile = join(snoStationCoreConfigDir, ".manifest-rename-marker");
	const keychainService = `ai.sno.sno-station-core.test-${runId}`;

	mkdirSync(snoStationCoreConfigDir, { recursive: true, mode: 0o700 });
	setEnv("XDG_CONFIG_HOME", xdgConfigHome);
	setEnv("SNO_STATION_CORE_KEYCHAIN_SERVICE", keychainService);
	setEnv(KEY_FILE_ENV, keyFile);
	setEnv("SNO_STATION_CORE_TESTING", "1");
	// Drop the in-process DEK promise cache — each test gets a fresh resolver.
	_resetDekCache();
	if (options.provisionKey !== false) {
		_provisionKey();
	}

	return {
		runId,
		xdgConfigHome,
		durableKeyRoot,
		snoStationCoreConfigDir,
		keyFile,
		manifestFile,
		markerFile,
		keychainService,
		cleanup(): void {
			try {
				rmSync(xdgConfigHome, { recursive: true, force: true });
			} catch {
				// best-effort
			}
			try {
				rmSync(durableKeyRoot, { recursive: true, force: true });
			} catch {
				// best-effort
			}
			restoreEnv("XDG_CONFIG_HOME");
			restoreEnv("SNO_STATION_CORE_KEYCHAIN_SERVICE");
			restoreEnv(KEY_FILE_ENV);
			restoreEnv("SNO_STATION_CORE_TESTING");
			_resetDekCache();
		},
	};
}

export function uniqueDbPath(env: TestEnv, name = "test"): string {
	return join(env.snoStationCoreConfigDir, "dbs", `${name}-${env.runId}.db`);
}

/**
 * Build node CLI args for spawning a child that imports the workspace package
 * `@snoai/sno-station-core-crypto`. The package's `exports.import` points at `./src/index.ts`,
 * so children must be launched with the `tsx` loader to strip types on import.
 */
export function childNodeArgs(fixturePath: string): string[] {
	return ["--import", "tsx", fixturePath];
}

const HELPER_DIR = fileURLToPath(new URL(".", import.meta.url));
/** Absolute path to the production CLI source — the bin's `dist/cli/sno-station-core.js` is built from this. */
export const CLI_SRC_PATH = join(
	HELPER_DIR,
	"..",
	"..",
	"..",
	"packages",
	"sno-station-core-crypto",
	"src",
	"cli",
	"sno-station-core.ts",
);

export interface CliResult {
	status: number | null;
	stdout: string;
	stderr: string;
	signal: NodeJS.Signals | null;
}

/**
 * Spawn the production `sno-station-core` CLI from source via `tsx`. The XDG /
 * `SNO_STATION_CORE_KEYCHAIN_SERVICE` env from `makeTestEnv()` MUST already be set in
 * `process.env` — this helper inherits it. Pass `stdin` to feed prompts.
 */
/**
 * Recover the DEK in a child process so passphrase prompts can be fed via
 * stdin (production interactive recovery path). Returns the resolved DEK as
 * a 32-byte Buffer. Throws on child failure.
 *
 * If `passphrase` is provided, sets `SNO_STATION_CORE_PASSPHRASE_STDIN=1` and feeds it.
 */
export function recoverDek(env: TestEnv, passphrase?: string): Buffer {
	mkdirSync(RECOVERY_FIXTURE_DIR, { recursive: true });
	const fixture = join(
		RECOVERY_FIXTURE_DIR,
		`recover-dek-${env.runId}-${randomBytes(2).toString("hex")}.mjs`,
	);
	writeFileSync(
		fixture,
		`
		import { getDek } from "@snoai/sno-station-core-crypto";
		const dek = await getDek();
		process.stdout.write("DEK_HEX:" + Buffer.from(dek).toString("hex") + "\\n");
		`,
	);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		XDG_CONFIG_HOME: env.xdgConfigHome,
		SNO_STATION_CORE_KEYCHAIN_SERVICE: env.keychainService,
	};
	if (passphrase !== undefined) {
		childEnv["SNO_STATION_CORE_PASSPHRASE_STDIN"] = "1";
	}
	try {
		const child = spawnSync(process.execPath, childNodeArgs(fixture), {
			input: passphrase !== undefined ? `${passphrase}\n` : "",
			encoding: "utf8",
			timeout: 30_000,
			env: childEnv as NodeJS.ProcessEnv,
		});
		if (child.status !== 0) {
			throw new Error(
				`recoverDek child exited ${child.status} signal=${child.signal}: stdout=${child.stdout} stderr=${child.stderr}`,
			);
		}
		const m = child.stdout.match(/DEK_HEX:([0-9a-f]{64})/i);
		if (!m?.[1]) {
			throw new Error(
				`recoverDek: no DEK in stdout: ${child.stdout} (stderr=${child.stderr})`,
			);
		}
		return Buffer.from(m[1], "hex");
	} finally {
		rmSync(fixture, { force: true });
	}
}

export function runCli(
	args: readonly string[],
	options: {
		stdin?: string;
		timeoutMs?: number;
		env?: Record<string, string>;
	} = {},
): CliResult {
	const child: SpawnSyncReturns<string> = spawnSync(
		process.execPath,
		[...childNodeArgs(CLI_SRC_PATH), ...args],
		{
			input: options.stdin ?? "",
			encoding: "utf8",
			timeout: options.timeoutMs ?? 30_000,
			env: { ...process.env, ...(options.env ?? {}) },
		},
	);
	return {
		status: child.status,
		stdout: child.stdout ?? "",
		stderr: child.stderr ?? "",
		signal: child.signal ?? null,
	};
}
