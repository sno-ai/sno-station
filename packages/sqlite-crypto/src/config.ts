import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { KEYCHAIN_SERVICE_DEFAULT, type SnoStationCoreConfigPaths } from "./types.js";

export const KEY_FILE_ENV = "SNO_STATION_CORE_KEY_FILE";

function canonicalPolicyPath(path: string): string {
	let cursor = resolve(path);
	const missingSegments: string[] = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) break;
		missingSegments.unshift(basename(cursor));
		cursor = parent;
	}
	const canonicalBase = existsSync(cursor)
		? realpathSync.native(cursor)
		: cursor;
	return resolve(canonicalBase, ...missingSegments);
}

function isAtOrBelow(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * Reject key placement in locations that normal cleanup may erase.
 */
export function assertDurableKeyFilePath(
	path: string,
	additionalDisposableRoots: readonly string[] = [],
): string {
	const candidate = canonicalPolicyPath(path);
	const disposableRoots = [
		tmpdir(),
		"/var/tmp",
		"/run",
		"/var/run",
		join(homedir(), ".cache"),
		...additionalDisposableRoots,
	].map(canonicalPolicyPath);
	if (disposableRoots.some((root) => isAtOrBelow(candidate, root))) {
		throw new Error(
			`key file path is temporary or disposable: ${candidate}; provision a durable operator key with \`sno-station-core lock --provision-key\``,
		);
	}
	return candidate;
}

/**
 * Resolve the XDG-honoring configuration directory. Honors
 * `XDG_CONFIG_HOME` (XDG Base Directory Specification, also documented in
 * design.md D18 as a test-isolation hook) and falls back to `~/.config`.
 *
 * Read once per call. Production callers cache via `getConfigPaths()`; tests
 * reset between cases by re-importing or calling `resolveConfigPaths()` again.
 */
export function resolveConfigPaths(): SnoStationCoreConfigPaths {
	const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
	const defaultConfigBase = join(homedir(), ".config");
	const configBase = xdg && xdg.length > 0 ? xdg : defaultConfigBase;
	const configDir = join(configBase, "sno-station-core");
	const explicitKeyFile = process.env[KEY_FILE_ENV]?.trim();
	const keyFile =
		explicitKeyFile || join(defaultConfigBase, "sno-station-core", "key");
	return {
		configDir,
		keyFile: assertDurableKeyFilePath(keyFile),
		manifestFile: join(configDir, "dbs.json"),
		markerFile: join(configDir, ".manifest-rename-marker"),
	};
}

/**
 * Resolve the OS-keychain service identifier. Honors `SNO_STATION_CORE_KEYCHAIN_SERVICE`
 * (test-isolation hook from design.md D18) so concurrent / parallel test runs
 * never collide on the same keychain entry. Production default is the locked
 * PRD value `ai.sno.sno-station-core`.
 */
export function resolveKeychainService(): string {
	const override = process.env["SNO_STATION_CORE_KEYCHAIN_SERVICE"]?.trim();
	if (override && override.length > 0) return override;
	return KEYCHAIN_SERVICE_DEFAULT;
}

export function hasExplicitKeyFile(): boolean {
	return Boolean(process.env[KEY_FILE_ENV]?.trim());
}
