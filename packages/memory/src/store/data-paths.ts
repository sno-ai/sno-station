/** @file data-paths.ts
 * @purpose Resolve the safe-uninstall data directory layout for
 *   `@snoai/memory`: persistent user data under
 *   `<profile root>/sno-station-mem/data/`, separate from service state. POSIX only.
 * @boundary Path resolution + filesystem-class assertion. No I/O beyond
 *   a single `statfs` probe in `assertLocalFilesystem`.
 */

import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSnoStationMemStateDir } from "../contract/profile";

/** File-system kinds that DO NOT guarantee atomic POSIX rename. */
const NON_LOCAL_FS_TYPES = new Set<number>([
	// Magic numbers per Linux uapi `magic.h` and BSD/macOS equivalents.
	0x6969, // NFS_SUPER_MAGIC
	0xff534d42, // CIFS_MAGIC_NUMBER (SMB1/2)
	0xfe534d42, // SMB2_MAGIC_NUMBER
	0x517b, // SMB_SUPER_MAGIC
	0x65735546, // FUSE_SUPER_MAGIC — covers sshfs/gcsfuse and iCloud-Drive
]);

/** Typed boundary error for refuse-to-operate when data dir is on NFS/SMB/FUSE. */
export class NonLocalFilesystemError extends Error {
	readonly kind = "NonLocalFilesystemError" as const;
	constructor(
		readonly dir: string,
		readonly fsType: number,
	) {
		super(
			`Refusing to operate on non-local filesystem (type=0x${fsType.toString(16)}) at ${dir}. ` +
				`Atomic rename is not guaranteed at ${dir}.`,
		);
		this.name = "NonLocalFilesystemError";
	}
}

export function getSnoStationMemDataDir(): string {
	return join(getSnoStationMemStateDir(), "data");
}

export function getSelfUpgradeStageRoot(): string {
	return join(homedir(), ".snoai", "sno-station-core", "sno-station-mem", "self-upgrade");
}

export function getInstallManifestPath(): string {
	return join(getSnoStationMemDataDir(), "install.json");
}

export function getAuditLogPath(): string {
	return join(getSnoStationMemDataDir(), "audit.jsonl");
}

export function getCostLogPath(): string {
	return join(getSnoStationMemDataDir(), "cost.jsonl");
}

export function getKillswitchPath(): string {
	return join(getSnoStationMemDataDir(), "killswitch");
}

export function getBackupsDir(): string {
	return join(getSnoStationMemDataDir(), "backups");
}

/**
 * `statfs(2)`-based check: throws `NonLocalFilesystemError` when `dir` sits on
 * NFS / SMB / FUSE (which includes iCloud-Drive-watched directories). POSIX
 * only — Windows is out of v1 projectId.
 */
export function assertLocalFilesystem(dir: string): void {
	let info: ReturnType<typeof statfsSync>;
	try {
		info = statfsSync(dir);
	} catch {
		// Directory may not exist yet; bubble nothing — the caller's `mkdirSync`
		// will surface real I/O errors.
		return;
	}
	if (NON_LOCAL_FS_TYPES.has(info.type)) {
		throw new NonLocalFilesystemError(dir, info.type);
	}
}
