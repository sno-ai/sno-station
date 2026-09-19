/** @file data-bootstrap.ts
 * @purpose Drive the boot flow: ensure data dir exists, probe
 *   filesystem, then resolve or create the install manifest
 *   and return the DB path the rest of the runtime should open.
 * @boundary Called once at plugin register-time, AFTER `initSqliteRuntimeSync()`
 *   resolves the DEK. Returns `{ dbPath, manifest, manifestPath }`.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE_DEFAULT } from "@snoai/sno-station-core-crypto";
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
	resolveDbPath,
	writeInstallManifestAtomic,
} from "./install-manifest";

const log = createLogger("sno-station-mem:data-bootstrap");

const DEFAULT_RELATIVE_DB_PATH = "./sno-station-mem.sqlite";

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

export interface BootstrapOptions {
	/**
	 * User-configured DB path from `PluginConfig.dbPath`. When provided AND
	 * absolute AND no manifest yet exists, this is recorded into the
	 * fresh manifest verbatim so the plugin honors the user's location.
	 * Manifest's recorded `dbPath` always wins on subsequent boots.
	 */
	configuredDbPath?: string | undefined;
}

/**
 * PRD §3.3 branches:
 *   1. manifest exists → read + validate, resolve DB path.
 *   2. manifest missing AND data dir contains user data → refuse.
 *   3. manifest missing, dir empty → fresh install.
 */
export function bootstrapDataLayout(options: BootstrapOptions = {}): BootstrapResult {
	const dataDir = getSnoStationMemDataDir();
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	assertLocalFilesystem(dataDir);

	const manifestPath = getInstallManifestPath();

	// Branch 1: manifest present.
	if (existsSync(manifestPath)) {
		const manifest = readInstallManifest(manifestPath);
		const dbPath = resolveDbPath(manifest, dataDir);
		log.info("manifest loaded", {
			installationId: manifest.installationId,
			dataFormatVersion: manifest.dataFormatVersion,
			dbPath,
		}, {
			event_name: "sno_station_mem.data-bootstrap.manifest.loaded",
			file: "packages/sno-station-mem/src/store/data-bootstrap.ts",
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
	const dbPath =
		options.configuredDbPath !== undefined && isAbsolute(options.configuredDbPath)
			? options.configuredDbPath
			: DEFAULT_RELATIVE_DB_PATH;
	const manifest = freshInstallManifest({
		dbPath,
		keyServiceName: KEYCHAIN_SERVICE_DEFAULT,
		keyAccount: KEYCHAIN_ACCOUNT,
	});
	writeInstallManifestAtomic(manifestPath, manifest);
	const resolved = resolveDbPath(manifest, dataDir);
	log.info("fresh install bootstrapped", {
		installationId: manifest.installationId,
		dataFormatVersion: manifest.dataFormatVersion,
		dbPath: resolved,
	}, {
		event_name: "sno_station_mem.data-bootstrap.fresh.install.bootstrapped",
		file: "packages/sno-station-mem/src/store/data-bootstrap.ts",
		function: "bootstrapDataLayout",
		site_id: "data-bootstrap.bootstrapDataLayout.4af3189946",
	});
	return { dbPath: resolved, manifest, manifestPath, dataDir };
}
