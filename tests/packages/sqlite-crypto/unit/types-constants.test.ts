/**
 * Sanity unit test on exported types/constants. Catches accidental constant
 * drift away from the PRD-locked values (cipher selection, KDF params, magic).
 */

import {
	ARGON2ID_PARAMS,
	CANARY_SENTINEL,
	CANARY_TABLE,
	EXPORT_MAGIC,
	EXPORT_VERSION,
	KEY_STATE_VERSION,
	KEYCHAIN_ACCOUNT,
	KEYCHAIN_SERVICE_DEFAULT,
	MANIFEST_SCHEMA_VERSION,
} from "@snoai/sqlite-crypto";
import { describe, expect, it } from "vitest";

describe("exported constants match PRD locked values", () => {
	it("Argon2id parameters match design D4", () => {
		expect(ARGON2ID_PARAMS).toEqual({
			algorithm: "argon2id",
			memoryCost: 65536,
			timeCost: 3,
			parallelism: 4,
			hashLength: 32,
			saltLength: 16,
		});
	});

	it("canary table + sentinel are stable", () => {
		expect(CANARY_TABLE).toBe("_sno_station_core_canary");
		expect(CANARY_SENTINEL.length).toBeGreaterThanOrEqual(8);
	});

	it("keychain service default and account match PRD §7.1", () => {
		expect(KEYCHAIN_SERVICE_DEFAULT).toBe("ai.sno.sno-station-core");
		expect(KEYCHAIN_ACCOUNT).toBe("default-user");
	});

	it("export magic and version match PRD §6.3 / D17", () => {
		expect(EXPORT_MAGIC).toBe("SNO_STATION_CORE01");
		expect(EXPORT_VERSION).toBe(0x01);
	});

	it("manifest and key-state schema versions are stable", () => {
		expect(MANIFEST_SCHEMA_VERSION).toBe(1);
		expect(KEY_STATE_VERSION).toBe(1);
	});
});
