import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _resetDekCache } from "@snoai/nodix-crypto";

const RECOVERY_FIXTURE_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
);

/**
 * Per-test isolation helper.
 *
 * The production code reads `process.env.XDG_CONFIG_HOME` and
 * `process.env.NODIX_KEYCHAIN_SERVICE` (see design.md D18). Tests use this
 * helper to redirect both away from the real host state.
 *
 * Each test run gets:
 *   - a fresh `XDG_CONFIG_HOME` under `os.tmpdir()/nodix-test-<runId>`
 *   - a unique `NODIX_KEYCHAIN_SERVICE` so concurrent runs / parallel tests
 *     never collide on the same keychain entry
 *
 * Caller is responsible for `cleanup()` in `afterEach`. The helper deliberately
 * does NOT remove keychain entries on its own — entry removal is part of the
 * production API surface (`getDek` / `setPassphrase`) and tests assert against it.
 */
export interface TestEnv {
	readonly runId: string;
	readonly xdgConfigHome: string;
	readonly nodixConfigDir: string;
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

export function makeTestEnv(label = "nodix"): TestEnv {
	const runId = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
	const xdgConfigHome = mkdtempSync(join(tmpdir(), `${label}-test-`));
	const nodixConfigDir = join(xdgConfigHome, "nodix");
	const keyFile = join(nodixConfigDir, "key");
	const manifestFile = join(nodixConfigDir, "dbs.json");
	const markerFile = join(nodixConfigDir, ".manifest-rename-marker");
	const keychainService = `ai.sno.nodix.test-${runId}`;

	setEnv("XDG_CONFIG_HOME", xdgConfigHome);
	setEnv("NODIX_KEYCHAIN_SERVICE", keychainService);
	setEnv("NODIX_TESTING", "1");
	// Drop the in-process DEK promise cache — each test gets a fresh resolver.
	_resetDekCache();

	return {
		runId,
		xdgConfigHome,
		nodixConfigDir,
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
			restoreEnv("XDG_CONFIG_HOME");
			restoreEnv("NODIX_KEYCHAIN_SERVICE");
			restoreEnv("NODIX_TESTING");
			_resetDekCache();
		},
	};
}

export function uniqueDbPath(env: TestEnv, name = "test"): string {
	return join(env.nodixConfigDir, "dbs", `${name}-${env.runId}.db`);
}

/**
 * Build node CLI args for spawning a child that imports the workspace package
 * `@snoai/nodix-crypto`. The package's `exports.import` points at `./src/index.ts`,
 * so children must be launched with the `tsx` loader to strip types on import.
 */
export function childNodeArgs(fixturePath: string): string[] {
	return ["--import", "tsx", fixturePath];
}

const HELPER_DIR = fileURLToPath(new URL(".", import.meta.url));
/** Absolute path to the production CLI source — the bin's `dist/cli/nodix.js` is built from this. */
export const CLI_SRC_PATH = join(
	HELPER_DIR,
	"..",
	"..",
	"..",
	"packages",
	"nodix-crypto",
	"src",
	"cli",
	"nodix.ts",
);

export interface CliResult {
	status: number | null;
	stdout: string;
	stderr: string;
	signal: NodeJS.Signals | null;
}

/**
 * Spawn the production `nodix` CLI from source via `tsx`. The XDG /
 * `NODIX_KEYCHAIN_SERVICE` env from `makeTestEnv()` MUST already be set in
 * `process.env` — this helper inherits it. Pass `stdin` to feed prompts.
 */
/**
 * Recover the DEK in a child process so passphrase prompts can be fed via
 * stdin (production interactive recovery path). Returns the resolved DEK as
 * a 32-byte Buffer. Throws on child failure.
 *
 * If `passphrase` is provided, sets `NODIX_PASSPHRASE_STDIN=1` and feeds it.
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
		import { getDek } from "@snoai/nodix-crypto";
		const dek = await getDek();
		process.stdout.write("DEK_HEX:" + Buffer.from(dek).toString("hex") + "\\n");
		`,
	);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		XDG_CONFIG_HOME: env.xdgConfigHome,
		NODIX_KEYCHAIN_SERVICE: env.keychainService,
	};
	if (passphrase !== undefined) {
		childEnv.NODIX_PASSPHRASE_STDIN = "1";
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
