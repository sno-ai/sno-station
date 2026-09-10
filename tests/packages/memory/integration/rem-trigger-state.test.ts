/** @file rem-trigger-state.test.ts
 * @purpose Proves the automatic REM scheduler stores exactly one strict five-field state per scope.
 * @boundary Real filesystem durability and schema validation; no storage mock.
 * @acceptance ACC-38
 * @class repair
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensureRemTriggerScope,
	loadRemTriggerState,
	remTriggerStatePath,
	writeRemTriggerStateAtomic,
} from "../../../../packages/sno-station-mem/src/sidecar/rem-trigger-state.ts";

describe("REM trigger durable state", () => {
	let stateDir: string | undefined;

	afterEach(() => {
		if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
		stateDir = undefined;
	});

	it("ACC-38 initializes an absent scope atomically and preserves its pinned zone", async () => {
		stateDir = mkdtempSync(join(tmpdir(), "rem-trigger-state-"));
		const loaded = await loadRemTriggerState(stateDir);
		expect(loaded).toEqual({ version: 1, scopes: {} });

		const now = new Date("2026-08-12T06:00:00.000Z");
		const initialized = ensureRemTriggerScope(loaded, {
			scope: "scope-a",
			now,
			candidateCount: 12,
			resolveScheduleZone: () => "America/Los_Angeles",
		});
		expect(initialized.initialized).toBe(true);
		expect(initialized.scopeState).toEqual({
			last_pass_at: now.toISOString(),
			schedule_zone: "America/Los_Angeles",
			last_covered_count: 12,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});
		await writeRemTriggerStateAtomic(stateDir, initialized.state);

		const reopened = await loadRemTriggerState(stateDir);
		const existing = ensureRemTriggerScope(reopened, {
			scope: "scope-a",
			now: new Date("2026-08-13T06:00:00.000Z"),
			candidateCount: 99,
			resolveScheduleZone: () => "Asia/Tokyo",
		});
		expect(existing.initialized).toBe(false);
		expect(existing.scopeState).toEqual(initialized.scopeState);
	});

	it("ACC-38 rejects partial or corrupt state instead of filling defaults", async () => {
		stateDir = mkdtempSync(join(tmpdir(), "rem-trigger-state-invalid-"));
		writeFileSync(
			remTriggerStatePath(stateDir),
			JSON.stringify({
				version: 1,
				scopes: {
					"scope-a": {
						last_pass_at: "2026-08-12T06:00:00.000Z",
						schedule_zone: "UTC",
					},
				},
			}),
		);

		await expect(loadRemTriggerState(stateDir)).rejects.toThrow(/REM trigger state.*invalid/i);
	});
});
