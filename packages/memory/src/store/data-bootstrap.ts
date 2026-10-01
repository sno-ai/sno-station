/** @file data-bootstrap.ts
 * @purpose Drive the boot flow: ensure data dir exists, probe
 *   filesystem, then resolve or create the install manifest
 *   and return the settings-selected DB path the rest of the runtime should open.
 * @boundary Called once at plugin register-time, AFTER `initSqliteRuntime()`
 *   resolves the DEK. Returns `{ dbPath, manifest, manifestPath }`.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { createLogger } from "@snoai/utils/logger";
import {
	assertLocalFilesystem,
	getSnoStationMemDataDir,
	getInstallManifestPath,
} from "./data-paths";
import {
	freshInstallManifest,
	INSTALL_MANIFEST_TEMP_SUFFIX,
	type InstallManifest,
	ManifestMissingButDataPresentError,
	readInstallManifest,
	writeInstallManifestAtomic,
} from "./install-manifest";

const log = createLogger("sno-station-mem:data-bootstrap");

export interface BootstrapResult {
	dbPath: string;
	manifest: InstallManifest;
	manifestPath: string;
	dataDir: string;
}

/** Detect "data exists but manifest missing" — PRD §3.3. */
function newDirHasUserData(dataDir: string, manifestPath: string): boolean {
	const manifestTempPrefix = `${basename(manifestPath)}${INSTALL_MANIFEST_TEMP_SUFFIX}`;
	try {
		return readdirSync(dataDir, { withFileTypes: true }).some(
			(entry) => !(entry.isFile() && entry.name.startsWith(manifestTempPrefix)),
		);
	} catch {
		return false;
	}
}

/**
 * PRD §3.3 branches:
 *   1. manifest exists → read + validate.
 *   2. manifest missing AND data dir contains user data → refuse.
 *   3. manifest missing, dir empty → fresh install.
 */
export function bootstrapDataLayout(storePath: string): BootstrapResult {
	const dataDir = getSnoStationMemDataDir();
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	assertLocalFilesystem(dataDir);

	const manifestPath = getInstallManifestPath();

	// Branch 1: manifest present.
	if (existsSync(manifestPath)) {
		const manifest = readInstallManifest(manifestPath);
		const dbPath = storePath;
		log.info("manifest loaded", {
			installationId: manifest.installationId,
			dataFormatVersion: manifest.dataFormatVersion,
			dbPath,
		}, {
			event_name: "sno_station_mem.data-bootstrap.manifest.loaded",
			file: "packages/memory/src/store/data-bootstrap.ts",
			function: "bootstrapDataLayout",
			site_id: "data-bootstrap.bootstrapDataLayout.4fc42585ae",
		});
		return { dbPath, manifest, manifestPath, dataDir };
	}

	// Branch 2: data present without manifest → refuse-to-overwrite.
	if (newDirHasUserData(dataDir, manifestPath)) {
		throw new ManifestMissingButDataPresentError(dataDir);
	}

	// Branch 3: fresh install.
	const dbPath = storePath;
	const manifest = freshInstallManifest({
		dbPath,
	});
	writeInstallManifestAtomic(manifestPath, manifest);
	const resolved = storePath;
	log.info("fresh install bootstrapped", {
		installationId: manifest.installationId,
		dataFormatVersion: manifest.dataFormatVersion,
		dbPath: resolved,
	}, {
		event_name: "sno_station_mem.data-bootstrap.fresh.install.bootstrapped",
		file: "packages/memory/src/store/data-bootstrap.ts",
		function: "bootstrapDataLayout",
		site_id: "data-bootstrap.bootstrapDataLayout.4af3189946",
	});
	return { dbPath: resolved, manifest, manifestPath, dataDir };
}
