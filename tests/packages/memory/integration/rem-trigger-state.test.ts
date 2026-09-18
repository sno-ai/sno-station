/** @file rem-trigger-state.test.ts
 * @purpose Proves the automatic REM scheduler stores exactly one strict six-field state per scope.
 * @boundary Real filesystem durability and schema validation; no storage mock.
 * @acceptance ACC-38
 * @class repair
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			missed_window: null,
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
	it("ACC-38 round-trips a missed window and rejects a malformed missed window", async () => {
		stateDir = mkdtempSync(join(tmpdir(), "rem-trigger-missed-"));
		const { state } = ensureRemTriggerScope({ version: 1, scopes: {} }, {
			scope: "scope-a", now: new Date("2026-09-10T03:00:00Z"), candidateCount: 0, resolveScheduleZone: () => "UTC",
		});
		const scope = state.scopes["scope-a"];
		if (!scope) throw new Error("scope missing");
		scope.missed_window = { due_at: "2026-09-11T03:00:00.000Z", trigger: "daily", recorded_at: "2026-09-11T04:00:00.000Z" };
		await writeRemTriggerStateAtomic(stateDir, state);
		expect(await loadRemTriggerState(stateDir)).toEqual(state);
		const truncated = { ...scope, missed_window: { trigger: "daily" } };
		writeFileSync(remTriggerStatePath(stateDir), JSON.stringify({ version: 1, scopes: { "scope-a": truncated } }));
		await expect(loadRemTriggerState(stateDir)).rejects.toThrow(/invalid/i);
	});

	it("reads five-field version 1 scopes after a store rotation and persists the new field", async () => {
		stateDir = mkdtempSync(join(tmpdir(), "rem-trigger-old-state-"));
		const oldScope = {
			last_pass_at: "2026-09-10T03:00:00.000Z",
			schedule_zone: "America/Los_Angeles",
			last_covered_count: 123,
			last_volume_pass_date: "2026-09-10",
			attempts: { identity: "rem-auto-daily-existing", count: 2 },
		};
		writeFileSync(join(stateDir, "rem-trigger-state.json"), JSON.stringify({
			version: 1,
			scopes: {
				"agent:provider-native-memory": oldScope,
				"01a083fc-b5e6-7707-86d4-636a9ace990a": oldScope,
			},
		}));
		const loaded = await loadRemTriggerState(stateDir);
		expect(Object.keys(loaded.scopes)).toEqual([
			"agent:provider-native-memory", "01a083fc-b5e6-7707-86d4-636a9ace990a",
		]);
		for (const scope of Object.values(loaded.scopes)) {
			expect(scope).toEqual({
				last_pass_at: "2026-09-10T03:00:00.000Z",
				schedule_zone: "America/Los_Angeles",
				last_covered_count: 123,
				last_volume_pass_date: "2026-09-10",
				attempts: { identity: "rem-auto-daily-existing", count: 2 },
				missed_window: null,
			});
		}
		await writeRemTriggerStateAtomic(stateDir, loaded);
		const persisted = JSON.parse(readFileSync(join(stateDir, "rem-trigger-state.json"), "utf8"));
		expect(persisted.scopes["agent:provider-native-memory"].missed_window).toBeNull();
		expect(persisted.scopes["01a083fc-b5e6-7707-86d4-636a9ace990a"].missed_window).toBeNull();
	});

});
