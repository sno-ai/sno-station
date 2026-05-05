import { homedir } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_SERVICE_DEFAULT, type NodixConfigPaths } from "./types.js";

/**
 * Resolve the XDG-honoring configuration directory. Honors
 * `XDG_CONFIG_HOME` (XDG Base Directory Specification, also documented in
 * design.md D18 as a test-isolation hook) and falls back to `~/.config`.
 *
 * Read once per call. Production callers cache via `getConfigPaths()`; tests
 * reset between cases by re-importing or calling `resolveConfigPaths()` again.
 */
export function resolveConfigPaths(): NodixConfigPaths {
	const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
	const configDir = join(base, "nodix");
	return {
		configDir,
		keyFile: join(configDir, "key"),
		manifestFile: join(configDir, "dbs.json"),
		markerFile: join(configDir, ".manifest-rename-marker"),
	};
}

/**
 * Resolve the OS-keychain service identifier. Honors `NODIX_KEYCHAIN_SERVICE`
 * (test-isolation hook from design.md D18) so concurrent / parallel test runs
 * never collide on the same keychain entry. Production default is the locked
 * PRD value `ai.sno.nodix`.
 */
export function resolveKeychainService(): string {
	const override = process.env["NODIX_KEYCHAIN_SERVICE"]?.trim();
	if (override && override.length > 0) return override;
	return KEYCHAIN_SERVICE_DEFAULT;
}
