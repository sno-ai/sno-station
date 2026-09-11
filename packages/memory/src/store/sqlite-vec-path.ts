/** @file sqlite-vec-path.ts
 * @purpose Resolves and loads the symbol-isolated sqlite-vec extension shipped with sno-station-mem.
 * @boundary Path selection only; Linux x64 must use the bundled binary.
 */

import { existsSync } from "node:fs";
import { arch, platform } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getLoadablePath } from "sqlite-vec";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_KEY = `${platform}-${arch}`;

interface SqliteExtensionLoader {
	loadExtension(path: string): void;
}

export function resolveSqliteVecPath(): string {
	if (PLATFORM_KEY !== "linux-x64") return resolve(getLoadablePath());
	const candidates = [
		join(HERE, "..", "..", "sqlite-extensions", PLATFORM_KEY, "vec0.so"),
		join(HERE, "..", "sqlite-extensions", PLATFORM_KEY, "vec0.so"),
		join(HERE, "..", "..", "..", "sqlite-extensions", PLATFORM_KEY, "vec0.so"),
	];
	for (const candidate of candidates) {
		const extensionPath = resolve(candidate);
		if (existsSync(extensionPath)) return extensionPath;
	}
	throw new Error(
		`Symbol-isolated sqlite-vec binary missing for ${PLATFORM_KEY}. Looked under: ${candidates.join(", ")}. Run scripts/build-sqlite-vec.sh from the plugin directory.`,
	);
}

export function loadSqliteVecExtension(database: SqliteExtensionLoader): void {
	database.loadExtension(resolveSqliteVecPath());
}
