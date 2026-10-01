/**
 * Sanity unit test on exported types/constants. Catches accidental constant
 * drift away from the PRD-locked values (canary, export magic, manifest schema).
 */

import {
	CANARY_SENTINEL,
	CANARY_TABLE,
	EXPORT_MAGIC,
	EXPORT_VERSION,
	MANIFEST_SCHEMA_VERSION,
} from "@snoai/sqlite-crypto";
import { describe, expect, it } from "vitest";

describe("exported constants match PRD locked values", () => {
	it("canary table + sentinel are stable", () => {
		expect(CANARY_TABLE).toBe("_sno_station_core_canary");
		expect(CANARY_SENTINEL.length).toBeGreaterThanOrEqual(8);
	});

	it("export magic and version match PRD §6.3 / D17", () => {
		expect(EXPORT_MAGIC).toBe("SNO_STATION_CORE01");
		expect(EXPORT_VERSION).toBe(0x01);
	});

	it("manifest schema version is stable", () => {
		expect(MANIFEST_SCHEMA_VERSION).toBe(1);
	});
});
