/**
 * Couples the usage-event retention window to the purge-safety recall lookback
 * (DB-optimization Step 10). If a future change widens the purge-safety window
 * past retention, old recall evidence would be deleted before the cascade-purge
 * preview could count it — this test makes that drift a build failure.
 */

import { describe, expect, it } from "vitest";
import {
	MEMORY_EVENTS_USAGE_RETENTION_MS,
	OUTBOX_QUARANTINE_RETENTION_MS,
} from "../../../../packages/sno-station-mem/src/store/maintenance.ts";
import { RECENT_RECALL_WINDOW_MS } from "../../../../packages/sno-station-mem/src/engine/telemetry/memory-telemetry-purge.ts";

describe("maintenance retention constants", () => {
	it("keeps usage-event retention at or above the purge-safety recall lookback", () => {
		expect(MEMORY_EVENTS_USAGE_RETENTION_MS).toBeGreaterThanOrEqual(RECENT_RECALL_WINDOW_MS);
	});

	it("pins the owner-approved windows (90d usage retention, 30d quarantine)", () => {
		const DAY_MS = 24 * 60 * 60 * 1000;
		expect(MEMORY_EVENTS_USAGE_RETENTION_MS).toBe(90 * DAY_MS);
		expect(OUTBOX_QUARANTINE_RETENTION_MS).toBe(30 * DAY_MS);
	});
});
