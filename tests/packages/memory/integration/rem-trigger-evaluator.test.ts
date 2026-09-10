import { testInstallationConfigPath } from "../../../apps/mem-claw/helpers/module-config-fixture";
/** @file rem-trigger-evaluator.test.ts
 * @purpose Proves automatic REM decisions, dispatch ordering, retry state, and audit evidence.
 * @boundary Real encrypted SQLite, durable state/audit files, and a real local HTTP boundary.
 * @acceptance ACC-24, ACC-25, ACC-37, ACC-38, ACC-40, ACC-42, ACC-44, ACC-45, ACC-46
 * @class integration
 */

import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateKillSwitch } from "../../../../packages/sno-station-mem/src/engine/operations/runtime-audit-log.ts";
import {
	computeRemDailyDue,
	evaluateRemAutomaticTriggers,
	remAutomaticCorrelationId,
	readRemAutomaticOperations,
} from "../../../../packages/sno-station-mem/src/sidecar/rem-trigger.ts";
import {
	loadRemTriggerState,
	writeRemTriggerStateAtomic,
} from "../../../../packages/sno-station-mem/src/sidecar/rem-trigger-state.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

type AuditRow = {
	event: string;
	scope?: string;
	resultStatus: string;
	details?: Record<string, unknown>;
};

describe("REM automatic trigger", () => {
	const databases: TestDb[] = [];
	const temporaryDirectories: string[] = [];
	let server: Server | undefined;

	afterEach(async () => {
		if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
		for (const database of databases.splice(0)) database.cleanup();
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
		server = undefined;
	});

	it("initializes an absent scope and continues into the waiting decision", async () => {
		const fixture = createFixture(1);
		const now = new Date("2026-08-12T12:00:00.000Z");
		const report = await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace", "rem-update"],
			now,
			resolveScheduleZone: () => "America/Los_Angeles",
		});

		expect(report).toEqual({ evaluations: 1, dispatches: 0 });
		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]).toEqual({
			last_pass_at: now.toISOString(),
			schedule_zone: "America/Los_Angeles",
			last_covered_count: 1,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});
		expect(readAudit(fixture.stateDir)).toContainEqual(
			expect.objectContaining({
				event: "rem_trigger_evaluated",
				scope: fixture.scope,
				details: expect.objectContaining({ row: "waiting-for-schedule" }),
			}),
		);
	});

	it("does not dispatch while the kill switch is active", async () => {
		const fixture = createFixture(101);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 202);
		activateKillSwitch(fixture.stateDir, "operator pause", "test");

		const report = await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now: new Date("2026-08-12T12:00:00.000Z"),
			discoveryPath,
		});

		expect(report).toEqual({ evaluations: 0, dispatches: 0 });
		expect(requests).toEqual([]);
		expect(readAudit(fixture.stateDir)).toContainEqual(
			expect.objectContaining({
				event: "rem_trigger_evaluated",
				details: { row: "automatic-trigger-skipped", reason: "kill-switch-active" },
			}),
		);
	});

	it("advances daily state only after the accepted job completes", async () => {
		const fixture = createFixture(1);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 202);
		const now = new Date("2026-08-12T12:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: "2026-08-11T12:00:00.000Z",
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});

		const report = await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace", "rem-update"],
			now,
			discoveryPath,
		});

		expect(report).toEqual({ evaluations: 1, dispatches: 1 });
		expect(requests).toEqual([
			{
				body: { types: ["rem-replace", "rem-update"], scope: fixture.scope },
				correlationId: remAutomaticCorrelationId(
					"daily",
					fixture.scope,
					"2026-08-12T03:00:00.000Z",
				),
			},
		]);
		const correlationId = requests[0]?.correlationId;
		const acceptedState = (await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope];
		expect(acceptedState?.last_pass_at).toBe("2026-08-11T12:00:00.000Z");
		expect(acceptedState?.attempts).toEqual({ identity: correlationId, count: 1 });
		const audit = readAudit(fixture.stateDir);
		expect(audit).toHaveLength(1);
		expect(audit[0]?.details).toMatchObject({
			row: "dispatch",
			trigger: "daily",
			correlation_id: correlationId,
		});

		appendTerminalAudit(fixture.stateDir, "rem_completed", fixture.scope, correlationId);
		const completionReport = await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace", "rem-update"],
			now,
			discoveryPath,
		});

		expect(completionReport).toEqual({ evaluations: 1, dispatches: 0 });
		expect(requests).toHaveLength(1);
		const completedState = (await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope];
		expect(completedState?.last_pass_at).toBe(now.toISOString());
		expect(completedState?.attempts).toEqual({ identity: null, count: 0 });
	});

	it("retries an accepted job after its terminal failure", async () => {
		const fixture = createFixture(1);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 202);
		const now = new Date("2026-08-12T12:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: "2026-08-11T12:00:00.000Z",
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-update"],
			now,
			discoveryPath,
		});
		appendTerminalAudit(
			fixture.stateDir,
			"rem_failed",
			fixture.scope,
			requests[0]?.correlationId,
		);

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-update"],
			now,
			discoveryPath,
		});

		expect(requests).toHaveLength(2);
		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]).toMatchObject({
			last_pass_at: "2026-08-11T12:00:00.000Z",
			attempts: { identity: requests[0]?.correlationId, count: 2 },
		});
	});

	it("uses a separate volume identity without moving the daily clock", async () => {
		const fixture = createFixture(101);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 202);
		const now = new Date("2026-08-12T01:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: now.toISOString(),
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-update"],
			now,
			discoveryPath,
		});

		const state = (await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope];
		expect(state?.last_pass_at).toBe(now.toISOString());
		expect(state?.last_volume_pass_date).toBeNull();
		expect(requests[0]?.correlationId).toBe(
			remAutomaticCorrelationId("volume", fixture.scope, "2026-08-12"),
		);
		expect(requests[0]?.correlationId).not.toContain("daily");
	});

	it("persists three failed daily attempts across evaluations and abandons only that instant", async () => {
		const fixture = createFixture(1);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 503);
		const now = new Date("2026-08-12T12:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: "2026-08-11T12:00:00.000Z",
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});

		for (let attempt = 1; attempt <= 3; attempt++) {
			await evaluateRemAutomaticTriggers({
				database: fixture.database.runtime.db,
				stateDir: fixture.stateDir,
				requestedOperations: ["rem-replace"],
				now,
				discoveryPath,
			});
		}

		expect(requests).toHaveLength(3);
		const state = (await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope];
		expect(state?.last_pass_at).toBe(now.toISOString());
		expect(state?.last_volume_pass_date).toBeNull();
		expect(state?.attempts).toEqual({ identity: null, count: 0 });
		expect(readAudit(fixture.stateDir).at(-1)?.details).toMatchObject({
			outcome: "deadline-missed",
		});
	});

	it("exhausts volume attempts without delaying the daily guarantee", async () => {
		const fixture = createFixture(100);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 503);
		const now = new Date("2026-08-12T01:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: now.toISOString(),
			schedule_zone: "UTC",
			last_covered_count: 0,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});

		for (let attempt = 1; attempt <= 3; attempt++) {
			await evaluateRemAutomaticTriggers({
				database: fixture.database.runtime.db,
				stateDir: fixture.stateDir,
				requestedOperations: ["rem-replace"],
				now,
				discoveryPath,
			});
		}

		const state = (await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope];
		expect(state?.last_pass_at).toBe(now.toISOString());
		expect(state?.last_volume_pass_date).toBe("2026-08-12");
		expect(readAudit(fixture.stateDir).at(-1)?.details).toMatchObject({
			outcome: "volume-attempts-spent",
		});
	});

	it("recovers a persisted third attempt and still evaluates later scopes", async () => {
		const fixture = createFixture(100);
		const laterScope = `${fixture.scope}:later`;
		seedCandidateRows(fixture.database, laterScope, 1);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 503);
		const now = new Date("2026-08-12T01:00:00.000Z");
		const correlationId = remAutomaticCorrelationId("volume", fixture.scope, "2026-08-12");
		await writeRemTriggerStateAtomic(fixture.stateDir, {
			version: 1,
			scopes: {
				[fixture.scope]: {
					last_pass_at: now.toISOString(),
					schedule_zone: "UTC",
					last_covered_count: 0,
					last_volume_pass_date: null,
					attempts: { identity: correlationId, count: 3 },
				},
			},
		});

		const report = await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now,
			discoveryPath,
			resolveScheduleZone: () => "UTC",
		});

		expect(report).toEqual({ evaluations: 2, dispatches: 1 });
		expect((await loadRemTriggerState(fixture.stateDir)).scopes).toMatchObject({
			[fixture.scope]: {
				last_volume_pass_date: "2026-08-12",
				attempts: { identity: null, count: 0 },
			},
			[laterScope]: { last_covered_count: 1 },
		});
	});

	it("lets daily win when daily and volume are due together", async () => {
		const fixture = createFixture(100);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 202);
		const now = new Date("2026-08-12T12:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: "2026-08-11T12:00:00.000Z",
			schedule_zone: "UTC",
			last_covered_count: 0,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now,
			discoveryPath,
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.correlationId).toContain("rem-auto-daily-");
		expect(readAudit(fixture.stateDir)).toHaveLength(1);
		expect(readAudit(fixture.stateDir)[0]?.details).toMatchObject({ trigger: "daily" });
	});

	it("records unreadable state without dispatch and no scopes without inventing a scope", async () => {
		const fixture = createFixture(1);
		writeFileSync(path.join(fixture.stateDir, "rem-trigger-state.json"), "{", "utf8");
		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now: new Date("2026-08-12T12:00:00.000Z"),
		});
		expect(readAudit(fixture.stateDir)).toContainEqual(
			expect.objectContaining({
				scope: fixture.scope,
				resultStatus: "error",
				details: expect.objectContaining({
					row: "state-unreadable",
					consecutive_idle: 1,
				}),
			}),
		);

		const empty = createFixture(0);
		await evaluateRemAutomaticTriggers({
			database: empty.database.runtime.db,
			stateDir: empty.stateDir,
			requestedOperations: ["rem-replace"],
			now: new Date("2026-08-12T12:00:00.000Z"),
		});
		expect(readAudit(empty.stateDir)).toEqual([
			expect.objectContaining({
				event: "rem_trigger_evaluated",
				details: expect.objectContaining({ row: "no-scopes" }),
			}),
		]);
		expect(readAudit(empty.stateDir)[0]).not.toHaveProperty("scope");
	});

	it("records one scope-less decision when the real storage latch rejects enumeration", async () => {
		const fixture = createFixture(1);
		fixture.database.runtime.db.markFailed("integration control");

		const report = await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now: new Date("2026-08-12T12:00:00.000Z"),
		});

		expect(report).toEqual({ evaluations: 1, dispatches: 0 });
		expect(readAudit(fixture.stateDir)).toEqual([
			expect.objectContaining({
				resultStatus: "error",
				details: expect.objectContaining({ row: "enumeration-failed" }),
			}),
		]);
		expect(readAudit(fixture.stateDir)[0]).not.toHaveProperty("scope");
	});

	it("contains a strict decision append failure before attempt persistence and POST", async () => {
		const fixture = createFixture(1);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 202);
		const now = new Date("2026-08-12T12:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: "2026-08-11T12:00:00.000Z",
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});
		mkdirSync(path.join(fixture.stateDir, "audit.jsonl"));

		await expect(
			evaluateRemAutomaticTriggers({
				database: fixture.database.runtime.db,
				stateDir: fixture.stateDir,
				requestedOperations: ["rem-replace"],
				now,
				discoveryPath,
			}),
		).resolves.toEqual({ evaluations: 1, dispatches: 0 });

		expect(requests).toHaveLength(0);
		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]?.attempts).toEqual({
			identity: null,
			count: 0,
		});
	});

	it("times out an unconfirmed dispatch and leaves the same identity due", async () => {
		const fixture = createFixture(1);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 0);
		const now = new Date("2026-08-12T12:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: "2026-08-11T12:00:00.000Z",
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now,
			discoveryPath,
			dispatchTimeoutMs: 20,
		});

		expect(requests).toHaveLength(1);
		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]?.attempts).toEqual({
			identity: requests[0]?.correlationId,
			count: 1,
		});
		expect(readAudit(fixture.stateDir).at(-1)?.details).toMatchObject({
			outcome: "dispatch-failed",
		});
	});

	it("serially records each candidate-bearing scope exactly once", async () => {
		const fixture = createFixture(1);
		const otherScope = `persona:${randomUUID()}`;
		seedCandidateRows(fixture.database, otherScope, 1);

		const report = await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now: new Date("2026-08-12T12:00:00.000Z"),
			resolveScheduleZone: () => "UTC",
		});

		expect(report).toEqual({ evaluations: 2, dispatches: 0 });
		expect(readAudit(fixture.stateDir).map((entry) => entry.scope).sort()).toEqual(
			[fixture.scope, otherScope].sort(),
		);
	});

	it("consumes only a correlated non-binding completion as an absolute baseline", async () => {
		const fixture = createFixture(101);
		const now = new Date("2026-08-12T01:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: now.toISOString(),
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: "2026-08-12",
			attempts: { identity: null, count: 0 },
		});
		const correlationId = remAutomaticCorrelationId("volume", fixture.scope, "2026-08-11");
		writeFileSync(
			path.join(fixture.stateDir, "audit.jsonl"),
			[
				JSON.stringify({
					timestamp: "2026-08-11T01:00:00.000Z",
					event: "rem_trigger_evaluated",
					resultStatus: "ok",
					scope: fixture.scope,
					details: { row: "dispatch", correlation_id: correlationId },
				}),
				"{malformed",
				JSON.stringify({
					timestamp: "2026-08-11T01:01:00.000Z",
					event: "rem_completed",
					resultStatus: "ok",
					scope: fixture.scope,
					details: {
						correlation_id: correlationId,
						stats: { measured: { rows_considered: 101, pair_cap_binding: false } },
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now,
		});

		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]?.last_covered_count).toBe(
			101,
		);
		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now,
		});
		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]?.last_covered_count).toBe(
			101,
		);
	});

	it("reads completions from the canonical audit directory", async () => {
		const fixture = createFixture(101);
		const auditStateDir = temporaryDirectory("rem-trigger-audit-");
		const now = new Date("2026-08-12T01:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: now.toISOString(),
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: "2026-08-12",
			attempts: { identity: null, count: 0 },
		});
		const correlationId = remAutomaticCorrelationId("volume", fixture.scope, "2026-08-11");
		writeCompletionAudit(auditStateDir, fixture.scope, correlationId, 101);

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			auditStateDir,
			requestedOperations: ["rem-replace"],
			now,
		});

		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]?.last_covered_count).toBe(
			101,
		);
	});

	it("bounds completion replay to the audit tail", async () => {
		const fixture = createFixture(101);
		const now = new Date("2026-08-12T01:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: now.toISOString(),
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: "2026-08-12",
			attempts: { identity: null, count: 0 },
		});
		const correlationId = remAutomaticCorrelationId("volume", fixture.scope, "2026-08-11");
		writeCompletionAudit(fixture.stateDir, fixture.scope, correlationId, 101, "x".repeat(17 * 1024 * 1024));

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now,
		});

		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]?.last_covered_count).toBe(
			1,
		);
	});

	it("leaves the baseline unchanged when the matching completion reports truncation", async () => {
		const fixture = createFixture(100);
		const now = new Date("2026-08-12T01:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: now.toISOString(),
			schedule_zone: "UTC",
			last_covered_count: 0,
			last_volume_pass_date: "2026-08-12",
			attempts: { identity: null, count: 0 },
		});
		const correlationId = remAutomaticCorrelationId("volume", fixture.scope, "2026-08-11");
		writeFileSync(
			path.join(fixture.stateDir, "audit.jsonl"),
			[
				JSON.stringify({
					timestamp: "2026-08-11T01:00:00.000Z",
					event: "rem_trigger_evaluated",
					resultStatus: "ok",
					scope: fixture.scope,
					details: { row: "dispatch", correlation_id: correlationId },
				}),
				JSON.stringify({
					timestamp: "2026-08-11T01:01:00.000Z",
					event: "rem_completed",
					resultStatus: "ok",
					scope: fixture.scope,
					details: {
						correlation_id: correlationId,
						stats: { measured: { rows_considered: 100, pair_cap_binding: true } },
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now,
		});

		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]?.last_covered_count).toBe(
			0,
		);
	});

	it("leaves the baseline unchanged and fires again when completion audit is unreadable", async () => {
		const fixture = createFixture(101);
		const requests: Array<{ body: unknown; correlationId: string }> = [];
		const discoveryPath = await startSidecar(requests, 202);
		const now = new Date("2026-08-12T01:00:00.000Z");
		await seedState(fixture, {
			last_pass_at: now.toISOString(),
			schedule_zone: "UTC",
			last_covered_count: 1,
			last_volume_pass_date: null,
			attempts: { identity: null, count: 0 },
		});
		const auditPath = path.join(fixture.stateDir, "audit.jsonl");
		writeFileSync(auditPath, "unreadable completion\n", "utf8");
		chmodSync(auditPath, 0o200);

		await evaluateRemAutomaticTriggers({
			database: fixture.database.runtime.db,
			stateDir: fixture.stateDir,
			requestedOperations: ["rem-replace"],
			now,
			discoveryPath,
		});

		chmodSync(auditPath, 0o600);
		expect(requests).toHaveLength(1);
		expect((await loadRemTriggerState(fixture.stateDir)).scopes[fixture.scope]).toMatchObject({
			last_covered_count: 1,
			last_volume_pass_date: null,
		});
	});

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

	it("reads the dispatched operations through the production plugin schema", () => {
		const configDir = temporaryDirectory("rem-trigger-config-");
		const configPath = testInstallationConfigPath(configDir);
		writeFileSync(
			configPath,
			JSON.stringify({
				plugins: {
					entries: {
						"sno-mem-claw": {
							config: { mode: "rem-enhanced", remOperations: ["rem-update"] },
						},
					},
				},
			}),
			"utf8",
		);
		expect(readRemAutomaticOperations(configPath)).toEqual(["rem-update"]);

		writeFileSync(
			configPath,
			JSON.stringify({
				plugins: { entries: { "sno-mem-claw": { config: { mode: "rem-enhanced" } } } },
			}),
			"utf8",
		);
		expect(readRemAutomaticOperations(configPath)).toEqual(["rem-replace", "rem-update"]);

		writeFileSync(
			configPath,
			JSON.stringify({ plugins: { entries: { "sno-mem-claw": { config: {} } } } }),
			"utf8",
		);
		expect(readRemAutomaticOperations(configPath)).toEqual([]);
	});

	function createFixture(candidateCount: number): { database: TestDb; stateDir: string; scope: string } {
		const database = createTestDb();
		const stateDir = temporaryDirectory("rem-trigger-");
		databases.push(database);
		const scope = `persona:${randomUUID()}`;
		seedCandidateRows(database, scope, candidateCount);
		return { database, stateDir, scope };
	}

	function seedCandidateRows(database: TestDb, scope: string, candidateCount: number): void {
		const insert = database.runtime.raw.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata,
				content_hash, fact_id, lane, raw_candidate_json
			) VALUES (?, ?, 'profile', ?, 0.8, 1, 'UTC', '{}', ?, ?, 'active', '{}')`,
		);
		for (let index = 0; index < candidateCount; index++) {
			const id = `${scope}:${index}`;
			insert.run(id, `Candidate ${index}`, scope, createHash("sha256").update(id).digest("hex"), id);
		}
	}

	function temporaryDirectory(prefix: string): string {
		const directory = mkdtempSync(path.join(tmpdir(), prefix));
		temporaryDirectories.push(directory);
		return directory;
	}

	async function seedState(
		fixture: { stateDir: string; scope: string },
		scopeState: Awaited<ReturnType<typeof loadRemTriggerState>>["scopes"][string],
	): Promise<void> {
		await writeRemTriggerStateAtomic(fixture.stateDir, {
			version: 1,
			scopes: { [fixture.scope]: scopeState },
		});
	}

	async function startSidecar(
		requests: Array<{ body: unknown; correlationId: string }>,
		status: number,
	): Promise<string> {
		server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				requests.push({
					body: JSON.parse(body) as unknown,
					correlationId: String(request.headers["x-rem-correlation-id"]),
				});
				if (status === 0) return;
				response.writeHead(status, { "content-type": "application/json" });
				response.end(status === 202 ? JSON.stringify({ job_id: "job-1", waveId: "job-1" }) : "{}");
			});
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("test server did not bind");
		const profileDir = temporaryDirectory("rem-discovery-");
		mkdirSync(path.join(profileDir, "station"), { recursive: true });
		const discoveryPath = path.join(profileDir, "station", "sidecar.json");
		writeFileSync(
			discoveryPath,
			JSON.stringify({ pid: process.pid, port: address.port, token: "test-token" }),
			"utf8",
		);
		return discoveryPath;
	}
});

function readAudit(stateDir: string): AuditRow[] {
	const content = readFileSync(path.join(stateDir, "audit.jsonl"), "utf8").trim();
	return content === "" ? [] : content.split("\n").map((line) => JSON.parse(line) as AuditRow);
}

function appendTerminalAudit(
	stateDir: string,
	event: "rem_completed" | "rem_failed",
	scope: string,
	correlationId: string | undefined,
): void {
	appendFileSync(
		path.join(stateDir, "audit.jsonl"),
		`${JSON.stringify({
			timestamp: "2026-08-12T12:01:00.000Z",
			event,
			resultStatus: event === "rem_completed" ? "ok" : "error",
			scope,
			details: {
				correlation_id: correlationId,
				stats: { measured: { rows_considered: 1, pair_cap_binding: false } },
			},
		})}\n`,
		"utf8",
	);
}

function writeCompletionAudit(
	stateDir: string,
	scope: string,
	correlationId: string,
	rowsConsidered: number,
	suffix = "",
): void {
	writeFileSync(
		path.join(stateDir, "audit.jsonl"),
		[
			JSON.stringify({
				timestamp: "2026-08-11T01:00:00.000Z",
				event: "rem_trigger_evaluated",
				resultStatus: "ok",
				scope,
				details: { row: "dispatch", correlation_id: correlationId },
			}),
			JSON.stringify({
				timestamp: "2026-08-11T01:01:00.000Z",
				event: "rem_completed",
				resultStatus: "ok",
				scope,
				details: {
					correlation_id: correlationId,
					stats: { measured: { rows_considered: rowsConsidered, pair_cap_binding: false } },
				},
			}),
			suffix,
		].join("\n") + "\n",
		"utf8",
	);
}
