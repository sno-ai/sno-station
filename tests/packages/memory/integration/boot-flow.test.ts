/** @file boot-flow.test.ts
 * @purpose PRD safe-uninstall §3.3 — manifest-missing-data-present refuses,
 *   fresh install creates manifest, statfs rejection.
 *
 * Real SQLCipher temp DBs via the chokepoint. statfs is mocked at the module
 * boundary (not the chokepoint) per the testing rules — see §3.3 risk row.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetDekCache,
	KEYCHAIN_ACCOUNT,
	KEYCHAIN_SERVICE_DEFAULT,
} from "@snoai/sno-station-core-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapDataLayout } from "../../../../packages/sno-station-mem/src/store/data-bootstrap.ts";
import {
	assertLocalFilesystem,
	getInstallManifestPath,
	NonLocalFilesystemError,
} from "../../../../packages/sno-station-mem/src/store/data-paths.ts";
import { ManifestMissingButDataPresentError } from "../../../../packages/sno-station-mem/src/store/install-manifest.ts";
import { _resetSqliteRuntimeForTest } from "../../../../packages/sno-station-mem/src/store/sqlite-runtime.ts";

const priorEnv = new Map<string, string | undefined>();
let tempRoot: string;
let snoaiRoot: string;
let xdgConfig: string;

function setEnv(name: string, value: string): void {
	if (!priorEnv.has(name)) priorEnv.set(name, process.env[name]);
	process.env[name] = value;
}

function restoreEnv(): void {
	for (const [name, value] of priorEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	priorEnv.clear();
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "mem-claw-boot-flow-"));
	snoaiRoot = join(tempRoot, "snoai");
	xdgConfig = join(tempRoot, "xdg-config");
	mkdirSync(snoaiRoot, { recursive: true });
	mkdirSync(xdgConfig, { recursive: true });
	setEnv("SNO_STATION_MEM_DATA_DIR_ROOT", join(snoaiRoot, "mem-claw"));
	setEnv("XDG_CONFIG_HOME", xdgConfig);
	setEnv(
		"SNO_STATION_CORE_KEYCHAIN_SERVICE",
		`ai.sno.sno-station-core.test-${Date.now()}-${process.pid}`,
	);
	_resetDekCache();
	_resetSqliteRuntimeForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	_resetDekCache();
	_resetSqliteRuntimeForTest();
	restoreEnv();
	rmSync(tempRoot, { recursive: true, force: true });
});

function dataDir(): string {
	return join(snoaiRoot, "mem-claw", "data");
}

describe("bootstrapDataLayout — fresh install", () => {
	it("creates an install.json with a UUIDv7 installationId", () => {
		const result = bootstrapDataLayout();
		expect(existsSync(getInstallManifestPath())).toBe(true);
		expect(result.manifest.installationId.charAt(14)).toBe("7");
		expect(result.manifest.dataFormatVersion).toBe(1);
		expect(result.manifest.dbPath).toBe("./mem-claw.sqlite");
		expect(result.manifest.keyServiceName).toBe(KEYCHAIN_SERVICE_DEFAULT);
		expect(result.manifest.keyAccount).toBe(KEYCHAIN_ACCOUNT);
		expect(result.dbPath).toBe(join(dataDir(), "mem-claw.sqlite"));
	});

	it("honors absolute config.dbPath in the new manifest", () => {
		const customDb = join(tempRoot, "elsewhere", "custom.sqlite");
		const result = bootstrapDataLayout({ configuredDbPath: customDb });
		expect(result.manifest.dbPath).toBe(customDb);
		expect(result.dbPath).toBe(customDb);
	});

	it("ignores relative config.dbPath so callers match the canonical default", () => {
		const result = bootstrapDataLayout({
			configuredDbPath: "legacy-relative.sqlite",
		});

		expect(result.manifest.dbPath).toBe("./mem-claw.sqlite");
		expect(result.dbPath).toBe(join(dataDir(), "mem-claw.sqlite"));
	});

	it("ignores orphaned install manifest temp files from a crashed first boot", () => {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(join(dataDir(), "install.json.tmp-123-deadbeef"), "{}");

		const result = bootstrapDataLayout();

		expect(existsSync(getInstallManifestPath())).toBe(true);
		expect(result.dbPath).toBe(join(dataDir(), "mem-claw.sqlite"));
	});
});

describe("bootstrapDataLayout — manifest-missing data-present", () => {
	it("refuses with ManifestMissingButDataPresentError", () => {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(join(dataDir(), "mem-claw.sqlite"), "stub-cipher-bytes");
		expect(() => bootstrapDataLayout()).toThrow(
			ManifestMissingButDataPresentError,
		);
	});

	it("refuses when only audit.jsonl is present without manifest", () => {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(join(dataDir(), "audit.jsonl"), "{}\n");
		expect(() => bootstrapDataLayout()).toThrow(
			ManifestMissingButDataPresentError,
		);
	});

	it("refuses when only backups are present without manifest", () => {
		mkdirSync(join(dataDir(), "backups"), { recursive: true });
		writeFileSync(join(dataDir(), "backups", "manual.sqlite"), "backup");
		expect(() => bootstrapDataLayout()).toThrow(
			ManifestMissingButDataPresentError,
		);
	});
});

describe("bootstrapDataLayout — manifest present", () => {
	it("loads, validates, and resolves dbPath", () => {
		// Seed a fresh install, then reload.
		const first = bootstrapDataLayout();
		_resetSqliteRuntimeForTest();
		const second = bootstrapDataLayout();
		expect(second.manifest.installationId).toBe(first.manifest.installationId);
		expect(second.manifest.dataFormatVersion).toBe(1);
		expect(second.dbPath).toBe(first.dbPath);
	});
});

describe("statfs — non-local filesystem rejection", () => {
	it("does not throw on a real local tmpfs/ext4 directory (smoke)", () => {
		mkdirSync(dataDir(), { recursive: true });
		expect(() => assertLocalFilesystem(dataDir())).not.toThrow();
	});

	it("NonLocalFilesystemError surfaces magic number and the env override hint", () => {
		// Magic numbers (Linux uapi `magic.h`):
		//   0x6969 = NFS, 0xff534d42 = CIFS, 0x65735546 = FUSE.
		const err = new NonLocalFilesystemError(dataDir(), 0x6969);
		expect(err.fsType).toBe(0x6969);
		expect(err.message).toContain("non-local filesystem");
		expect(err.message).toContain("SNO_STATION_MEM_DATA_DIR_ROOT");
		expect(err.name).toBe("NonLocalFilesystemError");
	});
});
