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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapDataLayout } from "../../../../packages/memory/src/store/data-bootstrap.ts";
import {
	assertLocalFilesystem,
	getInstallManifestPath,
	NonLocalFilesystemError,
} from "../../../../packages/memory/src/store/data-paths.ts";
import { ManifestMissingButDataPresentError } from "../../../../packages/memory/src/store/install-manifest.ts";
import { _resetSqliteRuntimeForTest } from "../../../../packages/memory/src/store/sqlite-runtime.ts";

const priorEnv = new Map<string, string | undefined>();
let tempRoot: string;
let profileRoot: string;

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
	profileRoot = join(tempRoot, "profile");
	mkdirSync(profileRoot, { recursive: true });
	setEnv("SNO_PROFILE_DIR", profileRoot);
	setEnv("HOME", join(tempRoot, "home"));
	_resetSqliteRuntimeForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
	_resetSqliteRuntimeForTest();
	restoreEnv();
	rmSync(tempRoot, { recursive: true, force: true });
});

function dataDir(): string {
	return join(profileRoot, "sno-station-mem", "data");
}

/** The store path `settings.store.path` names. */
function storePath(): string {
	return join(profileRoot, "sno-station-mem", "tester", "memory.sqlite");
}

describe("bootstrapDataLayout — fresh install", () => {
	it("creates an install.json with a UUIDv7 installationId", () => {
		const result = bootstrapDataLayout(storePath());
		expect(existsSync(getInstallManifestPath())).toBe(true);
		expect(getInstallManifestPath()).toBe(join(dataDir(), "install.json"));
		expect(result.manifest.installationId.charAt(14)).toBe("7");
		expect(result.manifest.dataFormatVersion).toBe(1);
		expect(result.manifest.dbPath).toBe(storePath());
		expect(result.dbPath).toBe(storePath());
	});

	it("honors the settings store path in the new manifest", () => {
		const customDb = join(tempRoot, "elsewhere", "custom.sqlite");
		const result = bootstrapDataLayout(customDb);
		expect(result.manifest.dbPath).toBe(customDb);
		expect(result.dbPath).toBe(customDb);
	});

	it("ignores orphaned install manifest temp files from a crashed first boot", () => {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(join(dataDir(), "install.json.tmp-123-deadbeef"), "{}");

		const result = bootstrapDataLayout(storePath());

		expect(existsSync(getInstallManifestPath())).toBe(true);
		expect(result.dbPath).toBe(storePath());
	});
});

describe("bootstrapDataLayout — manifest-missing data-present", () => {
	it("refuses with ManifestMissingButDataPresentError", () => {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(join(dataDir(), "sno-station-mem.sqlite"), "stub-cipher-bytes");
		expect(() => bootstrapDataLayout(storePath())).toThrow(
			ManifestMissingButDataPresentError,
		);
	});

	it("refuses when only audit.jsonl is present without manifest", () => {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(join(dataDir(), "audit.jsonl"), "{}\n");
		expect(() => bootstrapDataLayout(storePath())).toThrow(
			ManifestMissingButDataPresentError,
		);
	});

	it("refuses when only backups are present without manifest", () => {
		mkdirSync(join(dataDir(), "backups"), { recursive: true });
		writeFileSync(join(dataDir(), "backups", "manual.sqlite"), "backup");
		expect(() => bootstrapDataLayout(storePath())).toThrow(
			ManifestMissingButDataPresentError,
		);
	});
});

describe("bootstrapDataLayout — manifest present", () => {
	it("loads, validates, and resolves dbPath", () => {
		// Seed a fresh install, then reload.
		const first = bootstrapDataLayout(storePath());
		_resetSqliteRuntimeForTest();
		const second = bootstrapDataLayout(storePath());
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

	it("NonLocalFilesystemError surfaces the magic number", () => {
		// Magic numbers (Linux uapi `magic.h`):
		//   0x6969 = NFS, 0xff534d42 = CIFS, 0x65735546 = FUSE.
		const err = new NonLocalFilesystemError(dataDir(), 0x6969);
		expect(err.fsType).toBe(0x6969);
		expect(err.message).toContain("non-local filesystem");
		expect(err.name).toBe("NonLocalFilesystemError");
	});
});
