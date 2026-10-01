import { homedir } from "node:os";
import { join } from "node:path";
import type { SnoStationCoreConfigPaths } from "./types.js";

export function resolveConfigPaths(): SnoStationCoreConfigPaths {
	const configDir = join(homedir(), ".config", "sno-station-core");
	return {
		configDir,
		manifestFile: join(configDir, "dbs.json"),
		markerFile: join(configDir, ".manifest-rename-marker"),
	};
}
