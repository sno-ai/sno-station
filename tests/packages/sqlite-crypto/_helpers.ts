import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetDekCache } from "@snoai/nodix-crypto";

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
