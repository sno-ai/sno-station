/** @file version-metadata.ts
 * @purpose Resolves SNO Station Core workspace and sno-station-mem package version metadata.
 * @boundary Reads local version files/build-time env only; does not fetch release metadata.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_ENV_KEYS = ["SNO_STATION_MEM_VERSION", "SNO_STATION_MEM_VERSION"] as const;
const VERSION_LINE_RE = /^version:\s*["']?([^"'\s]+)["']?\s*$/m;

export function readSnoStationCoreWorkspaceVersion(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	for (const key of VERSION_ENV_KEYS) {
		const value = env[key]?.trim();
		if (value) return value;
	}
	for (const startDir of versionSearchRoots()) {
		const version = readVersionYamlUpward(startDir);
		if (version) return version;
	}
	return undefined;
}

/** The nearest manifest above this module: the installed plugin's own package.json. */
export function readInstalledPackageVersion(): string | undefined {
	return readPackageVersionUpward(dirname(fileURLToPath(import.meta.url)));
}

/** The manifest named `expectedName` above `startDir`; a host reads its own version from its entry file. */
export function readNamedPackageVersion(startDir: string, expectedName: string): string | undefined {
	return readPackageVersionUpward(startDir, expectedName);
}

function versionSearchRoots(): string[] {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	return [process.cwd(), moduleDir];
}

function readVersionYamlUpward(startDir: string): string | undefined {
	let dir = startDir;
	for (let depth = 0; depth < 10; depth += 1) {
		const candidate = join(dir, "VERSION.yaml");
		if (existsSync(candidate)) {
			const match = VERSION_LINE_RE.exec(readFileSync(candidate, "utf8"));
			return match?.[1];
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function readPackageVersionUpward(startDir: string, expectedName?: string): string | undefined {
	let dir = startDir;
	for (let depth = 0; depth < 10; depth += 1) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) {
			try {
				const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
					name?: unknown;
					version?: unknown;
				};
				if (
					(expectedName === undefined || parsed.name === expectedName) &&
					typeof parsed.version === "string" &&
					parsed.version.trim()
				) {
					return parsed.version.trim();
				}
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}
