import { describe, expect, it } from "vitest";
import { computeRemDailyDue } from "../../../../packages/memory/src/sidecar/rem-trigger.ts";

describe("REM daily schedule", () => {
	it("computes the next pinned-zone instant strictly after the stored pass", () => {
		expect(computeRemDailyDue("2026-11-01T06:30:00.000Z", "America/New_York").toISOString()).toBe(
			"2026-11-01T08:00:00.000Z",
		);
		expect(computeRemDailyDue("2026-11-01T08:00:00.000Z", "America/New_York").toISOString()).toBe(
			"2026-11-02T08:00:00.000Z",
		);
		expect(computeRemDailyDue("2027-03-27T12:00:00.000Z", "Europe/Helsinki").toISOString()).toBe(
			"2027-03-28T01:00:00.000Z",
		);
	});
});
