import { writeTestInstallationConfig } from "../helpers/module-config-fixture";
/** @file rem-sidecar.test.ts
 * @purpose Proves the standalone REM sidecar over real processes, HTTP, files, and audit logs.
 * @boundary Built-in loopback HTTP server plus isolated profile and OpenClaw state directories.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendAuditEntryStrict,
	getAuditPath,
} from "../../../../packages/memory/src/engine/operations/runtime-audit-log.ts";
import { getRemTraceLogPath } from "../../../../packages/memory/src/sidecar/config.ts";
import { prepareRemEntryArtifactFixture } from "../helpers/rem-entry-artifact-fixture.ts";
import { createRemOwnerNullOperationalConfiguration } from "../helpers/rem-entry-config-fixture.ts";
import {
	startQcg17ScriptedInvalidResponseFixture,
	type Qcg17ScriptedInvalidResponseFixture,
} from "../helpers/rem-qcg17-scripted-invalid-response-fixture.ts";
import { createTestDb } from "../helpers/test-db.ts";
import { startRemScriptedModelFixture, type RemScriptedModelFixture } from "../helpers/rem-scripted-model-fixture.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const appRoot = join(repoRoot, "packages/memory");
const cleanupPaths: string[] = [];
const databaseCleanups: Array<() => void> = [];
const personaDbPaths = new Map<string, string>();
const personaDatabases = new Map<
	string,
	ReturnType<typeof createTestDb>["sqlite"]
>();
const children: ChildProcess[] = [];
const qcg17Fixtures: Qcg17ScriptedInvalidResponseFixture[] = [];
const hostModels: RemScriptedModelFixture[] = [];

interface Discovery {
	port: number;
	token: string;
	pid: number;
}

interface StartedSidecar {
	child: ChildProcess;
	stateRoot: string;
	profileRoot: string;
	discovery: Discovery;
	stderr: () => string;
}

afterEach(async () => {
	for (const model of hostModels.splice(0)) await model.close();
	for (const fixture of qcg17Fixtures.splice(0)) await fixture.close();
	for (const child of children.splice(0)) {
		await stopChild(child, "SIGKILL");
	}
	for (const path of cleanupPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
	for (const cleanup of databaseCleanups.splice(0)) cleanup();
	personaDbPaths.clear();
	personaDatabases.clear();
});

describe("REM sidecar", () => {
	it(
		"serves loopback REM jobs with audit and redacted request logs",
		{ timeout: 15_000 },
		async () => {
			const sidecar = await startSidecar();
			let requestCount = 1; // The real /v1/init registration is logged too.
			const call = async (path: string, init?: RequestInit): Promise<Response> => {
				requestCount += 1;
				return fetch(`http://127.0.0.1:${sidecar.discovery.port}${path}`, {
					...init,
					signal: AbortSignal.timeout(2_000),
				});
			};

			expect((await call("/healthz")).status).toBe(200);
			expect((await call("/rem/jobs/missing")).status).toBe(404);

			const start = await call("/rem/run", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Sidecar-Token": sidecar.discovery.token,
					"X-Rem-Correlation-Id": "corr-sidecar-019f8da3",
				},
				body: JSON.stringify({ type: "rem-replace", scope: "persona:test-68a19d8c" }),
			});
			expect(start.status, await start.clone().text()).toBe(202);
			const started = (await start.json()) as { job_id: string };

			const terminal = await waitForJob(sidecar.discovery, started.job_id, () => {
				requestCount += 1;
			});
			expect(terminal).toMatchObject({
				state: "done",
				type: "rem-replace",
				scope: "persona:test-68a19d8c",
				stats: { operations: 0 },
			});

			const missing = await call("/rem/jobs/missing", {
				headers: { "X-Sidecar-Token": sidecar.discovery.token },
			});
			expect(missing.status).toBe(404);

			const stateDir = join(sidecar.stateRoot, "sno-station-mem");
			const audit = await waitForJsonl(getAuditPath(stateDir), (entries) =>
				entries.some(
					(entry) =>
						entry.event === "rem_completed" &&
						entry.details?.["job_id"] === started.job_id,
				),
			);
			const remEvents = audit.filter((entry) => entry.details?.["job_id"] === started.job_id);
			expect(remEvents.map((entry) => entry.event)).toEqual([
				"rem_triggered",
				"rem_completed",
			]);
			expect(remEvents[1]?.details).toMatchObject({
				type: "rem-replace",
				scope: "persona:test-68a19d8c",
				source: "sidecar",
				stats: { operations: 0 },
				correlation_id: "corr-sidecar-019f8da3",
			});

			const requestLogPath = getRemTraceLogPath(sidecar.stateRoot);
			const requestLines = await waitForLines(
				requestLogPath,
				(lines) => lines.filter((line) => line.includes("http_request")).length === requestCount,
			);
			const requestLinesOnly = requestLines.filter((line) => line.includes("http_request"));
			expect(requestLinesOnly).toHaveLength(requestCount);
			expect(requestLinesOnly.join("\n")).toContain('"method":"POST"');
			const requests = requestLinesOnly.map(line => JSON.parse(line));
			expect(requests.some(row => row.attributes.path?.sha256 === createHash("sha256").update("/rem/run").digest("hex"))).toBe(true);
			expect(requestLinesOnly.join("\n")).toContain('"status":202');
			expect(requests.some(row => row.attributes.correlation_id?.sha256 === createHash("sha256").update("corr-sidecar-019f8da3").digest("hex"))).toBe(true);
			expect(requestLinesOnly.join("\n")).not.toContain("corr-sidecar-019f8da3");
			expect(requestLines.map(line => JSON.parse(line)).some(row => row.body === "job_allocated" && row.attributes.job_id === started.job_id)).toBe(true);
			expect(requestLinesOnly.join("\n")).not.toContain('"error_code":"unauthorized"');
			expect(requestLinesOnly.join("\n")).toContain('"error_code":"job_not_found"');
			expect(requestLinesOnly.join("\n")).not.toContain(sidecar.discovery.token);
			expect(JSON.stringify(audit)).not.toContain('"method"');
		},
	);







	it("records the scanned empty scope and candidate count on a completed REM pass", async () => {
		const testDb = createTestDb();
		let sidecar: StartedSidecar | undefined;
		try {
			const stateRoot = createTempRoot("mem-claw-rem-empty-scan-state-");
			const profileRoot = stateRoot;
			const scope = `persona:empty-rem-scan-${Date.now()}`;
			writeTestInstallationConfig(stateRoot, {
					plugins: {
						entries: {
							"sno-mem-claw": {
								config: {
									dbPath: testDb.dbPath,
									embedding: { provider: "local-onnx", dimensions: 1024 },
								},
							},
						},
					},
			}, testDb.encryptionKey);
			const gateDir = join(stateRoot, "sno-station-mem", "rem-gates");
			mkdirSync(gateDir, { recursive: true });
			const gateBytes = `${JSON.stringify({
				schema_version: 1,
				job_type: "rem-replace",
				implementation_version: "1.2.3",
				corpus_sha256: "a".repeat(64),
				baseline_sha256: "b".repeat(64),
				result: "pass",
				evaluated_at: "2026-07-31T07:00:00.000Z",
				expires_at: "2027-07-31T07:00:00.000Z",
			})}\n`;
			writeFileSync(join(gateDir, "rem-replace.json"), gateBytes, { mode: 0o600 });
			sidecar = await startSidecar({
				stateRoot,
				profileRoot,
				extraEnv: {
					MEM_CLAW_DATA_DIR_ROOT: dirname(testDb.dbPath),
					SNO_STATION_MEM_REM_EXPECTED_DB_PATH: testDb.dbPath,
					SNO_STATION_MEM_REM_CONFIG_JSON: prepareRemEntryArtifactFixture(stateRoot, "valid"),
				},
			});
			const response = await fetch(
				`http://127.0.0.1:${sidecar.discovery.port}/rem/run`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Sidecar-Token": sidecar.discovery.token,
					},
					body: JSON.stringify({ type: "rem-replace", scope }),
					signal: AbortSignal.timeout(2_000),
				},
			);
			expect(response.status).toBe(202);
			const started = (await response.json()) as { job_id: string };
			const terminal = await waitForJob(
				sidecar.discovery,
				started.job_id,
				() => undefined,
				15_000,
			);
			expect(terminal).toMatchObject({
				state: "done",
				type: "rem-replace",
				scope,
				stats: { operations: 0, scan: { scope, candidate_count: 0 } },
			});

			const durableJobs = readFileSync(join(stateRoot, "sno-station-mem", "rem-wave-jobs.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const durableDone = durableJobs
				.filter((job) => job["waveId"] === started.job_id && job["state"] === "done")
				.at(-1);
			expect(durableDone).toMatchObject({
				state: "done",
				requestedOperations: ["rem-replace"],
				scope,
				stats: { operations: 0, scan: { scope, candidate_count: 0 } },
			});
		} finally {
			if (sidecar) await stopChild(sidecar.child, "SIGKILL");
			testDb.cleanup();
		}
	});

	it("fails a REM job when the configured database does not exist", async () => {
		const stateRoot = createTempRoot("mem-claw-rem-missing-db-state-");
		const profileRoot = stateRoot;
		const missingDbPath = join(stateRoot, "never-created", "mem-claw.sqlite");
		const scope = `persona:missing-rem-db-${Date.now()}`;
		expect(existsSync(missingDbPath)).toBe(false);
		writeTestInstallationConfig(stateRoot, {
				plugins: {
					entries: {
						"sno-mem-claw": {
							config: {
								dbPath: missingDbPath,
								embedding: { provider: "local-onnx", dimensions: 1024 },
							},
						},
					},
				},
			});
		const gateDir = join(stateRoot, "sno-station-mem", "rem-gates");
		mkdirSync(gateDir, { recursive: true });
		const gateBytes = `${JSON.stringify({
			schema_version: 1,
			job_type: "rem-replace",
			implementation_version: "1.2.3",
			corpus_sha256: "a".repeat(64),
			baseline_sha256: "b".repeat(64),
			result: "pass",
			evaluated_at: "2026-07-31T07:00:00.000Z",
			expires_at: "2027-07-31T07:00:00.000Z",
		})}\n`;
		writeFileSync(join(gateDir, "rem-replace.json"), gateBytes, { mode: 0o600 });
		const sidecar = await startSidecar({
			stateRoot,
			profileRoot,
			extraEnv: {
				MEM_CLAW_DATA_DIR_ROOT: join(stateRoot, "mem-claw-data"),
				SNO_STATION_MEM_REM_EXPECTED_DB_PATH: missingDbPath,
				SNO_STATION_MEM_REM_CONFIG_JSON: prepareRemEntryArtifactFixture(stateRoot, "valid"),
			},
		});

		const response = await fetch(`http://127.0.0.1:${sidecar.discovery.port}/rem/run`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Sidecar-Token": sidecar.discovery.token,
			},
			body: JSON.stringify({ type: "rem-replace", scope }),
			signal: AbortSignal.timeout(2_000),
		});
		expect(response.status).toBe(202);
		const started = (await response.json()) as { job_id: string };
		const terminal = await waitForJob(
			sidecar.discovery,
			started.job_id,
			() => undefined,
			15_000,
		);
		// The scenario is a database file that does not exist, which the next line asserts. A file
		// that is not there cannot be opened, so the failure comes from the open — the manifest
		// check this case used to expect is reached only after a successful open, on a file that
		// exists but is unregistered. Asserting that message here made the case unable to pass while
		// its own `existsSync` assertion said why.
		expect(terminal).toMatchObject({
			state: "failed",
			type: "rem-replace",
			scope,
			stats: { operations: 0 },
		});
		expect(String((terminal as { error?: unknown }).error)).toContain(missingDbPath);
		expect(existsSync(missingDbPath)).toBe(false);

		const audit = await waitForJsonl(
			getAuditPath(join(stateRoot, "sno-station-mem")),
			(entries) =>
				entries.some(
					(entry) =>
						entry.event === "rem_failed" && entry.details?.["job_id"] === started.job_id,
				),
		);
		const jobAudit = audit.filter((entry) => entry.details?.["job_id"] === started.job_id);
		expect(jobAudit).toContainEqual(
			expect.objectContaining({
				event: "rem_failed",
				details: expect.objectContaining({
					error: expect.stringContaining(missingDbPath),
				}),
			}),
		);
		expect(jobAudit.some((entry) => entry.event === "rem_completed")).toBe(false);
	});



















	it("rem-job-stats-five-fields", async () => {
		await expectEmptyBuiltOperationCompletes(
			"rem-replace",
			"persona:qcg-13-empty-statistics",
		);
	});



	it.runIf(process.env["REM_QCG17_SCRIPTED_INVALID_APPROVED"] === "1")(
		"rem-per-write-degraded-outcome-preserved through the real sidecar and SQLite adapter",
		{ timeout: 90_000 },
		async () => {
			const marker = "QCG17_SCRIPTED_INVALID_RESPONSE_ONLY";
			const fixture = await startQcg17ScriptedInvalidResponseFixture({
				invalidPromptMarker: marker,
				upstreamUrl: "http://localhost:8070/codex/v1/chat/completions",
			});
			qcg17Fixtures.push(fixture);
			const stateRoot = createTempRoot("mem-claw-qcg17-state-");
			const profileRoot = stateRoot;
			const configuration = createRemOwnerNullOperationalConfiguration();
			configuration["modelRoute"] = fixture.url;
			const configurationSource = prepareRemEntryArtifactFixture(
				stateRoot,
				"valid",
				configuration,
			);
			const sidecar = await startSidecar({
				stateRoot,
				profileRoot,
				extraEnv: { SNO_STATION_MEM_REM_CONFIG_JSON: configurationSource },
			});
			const personaDb = personaDatabases.get(stateRoot);
			if (!personaDb) throw new Error(`persona database missing for ${stateRoot}`);
			const scope = "persona:qcg17-scripted-invalid";
			for (const [id, text] of [
				[
					"qcg17-invalid-row",
					`${marker}: Project Atlas now has a budget of $18,000, updated from $15,000.`,
				],
				[
					"qcg17-live-control-row",
					"Project Borealis now has a budget of $22,000, updated from $19,000.",
				],
			] as const) {
				personaDb
					.prepare(
						`INSERT INTO nodix_memories(
							id, text, category, project_id, importance, timestamp, timezone, metadata,
							content_hash, fact_id, lane
						) VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?, ?)`,
					)
					.run(
						id,
						text,
						"profile",
						scope,
						0.9,
						1_754_636_400_000,
						JSON.stringify({ section_name: id }),
						createHash("sha256").update(text).digest("hex"),
						`fact-${id}`,
						"active",
					);
			}

			const started = await startJob(sidecar.discovery, scope, "rem-update");
			const terminal = await waitForJob(
				sidecar.discovery,
				started.job_id,
				() => undefined,
				80_000,
			);
			expect(terminal["state"]).toBe("done");
			const observation = fixture.observation();
			expect(observation.injectedCalls, "scripted invalid response count").toBe(1);
			expect(observation.forwardedCalls, "paired live model control calls").toBeGreaterThan(0);
			const degradedRows = personaDb
				.prepare(
					"SELECT outcome, row_id FROM nodix_rem_journal WHERE job_id = ? AND outcome = 'degraded'",
				)
				.all(started.job_id) as Array<Record<string, unknown>>;
			expect(degradedRows).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ outcome: "degraded", row_id: "qcg17-invalid-row" }),
				]),
			);
			process.stdout.write(
				"QCG17_SCRIPTED_INVALID_RESPONSE integration-only; acceptance also requires Chapter0 and the final QCG11 live E2E.\n",
			);
		},
	);







	it(
		"fails queued jobs but resumes interrupted running jobs with the same wave",
		{ timeout: 20_000 },
		async () => {
			const stateRoot = createTempRoot("mem-claw-rem-state-");
			const profileRoot = stateRoot;
			const first = await startSidecar({ stateRoot, profileRoot });
			const queued = await startJob(first.discovery, "persona:queued-restart");
			await stopChild(first.child, "SIGKILL");

			const second = await startSidecar({ stateRoot, profileRoot, holdMs: 2_000 });
			const queuedStatus = await readJob(second.discovery, queued.job_id);
			expect(queuedStatus).toMatchObject({ state: "failed", error: "sidecar_restart" });

			const running = await startJob(second.discovery, "persona:running-restart");
			await waitForJsonl(getAuditPath(join(stateRoot, "sno-station-mem")), (entries) =>
				entries.some(
					(entry) =>
						entry.event === "rem_triggered" && entry.details?.["job_id"] === running.job_id,
				),
			);
			await stopChild(second.child, "SIGKILL");

			const third = await startSidecar({ stateRoot, profileRoot });
			const runningStatus = await waitForJob(third.discovery, running.job_id, () => undefined);
			expect(runningStatus).toMatchObject({ state: "done" });
			expect(runningStatus).not.toHaveProperty("error");
			expect(third.stderr()).toContain("job_recovery_resuming");

			const audit = await waitForJsonl(
				getAuditPath(join(stateRoot, "sno-station-mem")),
				(entries) =>
					entries.some(
						(entry) =>
							entry.event === "rem_failed" && entry.details?.["job_id"] === queued.job_id,
					),
			);
			expect(
				audit.some(
					(entry) =>
						entry.event === "rem_failed" && entry.details?.["job_id"] === running.job_id,
				),
			).toBe(false);
			expect(
				audit.filter(
					(entry) =>
						entry.event === "rem_triggered" &&
						entry.details?.["job_id"] === queued.job_id,
				),
			).toEqual([]);
			expect(
				audit.filter(
					(entry) =>
						entry.event === "rem_triggered" &&
						entry.details?.["job_id"] === running.job_id,
				),
			).toHaveLength(1);
		},
	);

	it("recovers a job as done when its completion audit survived the crash", async () => {
		const stateRoot = createTempRoot("mem-claw-rem-state-");
		const profileRoot = stateRoot;
		const scope = "persona:completed-before-crash";
		const stateDir = join(stateRoot, "sno-station-mem");
		const configJson = prepareRemEntryArtifactFixture(stateRoot, "valid");
		const first = await startSidecar({
			stateRoot,
			profileRoot,
			holdMs: 2_000,
			extraEnv: { SNO_STATION_MEM_REM_CONFIG_JSON: configJson },
		});
		const response = await fetch(`http://127.0.0.1:${first.discovery.port}/rem/run`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Sidecar-Token": first.discovery.token,
			},
			body: JSON.stringify({ type: "rem-replace", scope }),
			signal: AbortSignal.timeout(2_000),
		});
		expect(response.status).toBe(202);
		const started = (await response.json()) as { job_id: string };
		await waitForJsonl(getAuditPath(stateDir), (entries) =>
			entries.some(
				(entry) =>
					entry.event === "rem_triggered" && entry.details?.["job_id"] === started.job_id,
			),
		);
		await appendAuditEntryStrict(stateDir, {
			event: "rem_completed",
			scope,
			resultStatus: "ok",
			details: {
				job_id: started.job_id,
				type: "rem-replace",
				stats: {
					operations: 2,
					applied_count: 2,
					actionable_candidate_count: 2,
					applied_fraction: 1,
					parse_failure_count: 0,
					top_refusal_reasons: [],
					scan: {
						scope,
						candidate_count: 5,
						stamped_skipped_count: 1,
						actionable_candidate_count: 2,
					},
					measured: {
						rows_considered: 5,
						pairs_built: 3,
						pair_cap_binding: false,
						model_calls: 2,
						model_tokens: 42,
						wall_ms: 120,
					},
					by_operation: [
						{
							operation: "rem-replace",
							applied_count: 2,
							actionable_candidate_count: 2,
							candidate_count: 5,
							parse_failure_count: 0,
							top_refusal_reasons: [],
							measured: {
								rows_considered: 5,
								pairs_built: 3,
								pair_cap_binding: false,
								model_calls: 2,
								model_tokens: 42,
								wall_ms: 120,
							},
						},
					],
				},
			},
		});
		await stopChild(first.child, "SIGKILL");

		const second = await startSidecar({
			stateRoot,
			profileRoot,
			extraEnv: { SNO_STATION_MEM_REM_CONFIG_JSON: configJson },
		});
		const recovered = await readJob(second.discovery, started.job_id);
		expect(recovered).toMatchObject({
			state: "done",
			type: "rem-replace",
			scope,
			stats: {
				operations: 2,
				scan: { scope, candidate_count: 5, stamped_skipped_count: 1 },
				measured: { pairs_built: 3, model_calls: 2, model_tokens: 42 },
				by_operation: [
					expect.objectContaining({ operation: "rem-replace", applied_count: 2 }),
				],
			},
		});
		expect(recovered).not.toHaveProperty("error");
		const durableJobs = readFileSync(join(stateDir, "rem-wave-jobs.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(
			durableJobs
				.filter((job) => job["waveId"] === started.job_id && job["state"] === "done")
				.at(-1),
		).toMatchObject({
			state: "done",
			requestedOperations: ["rem-replace"],
			scope,
			stats: {
				operations: 2,
				scan: { scope, candidate_count: 5, stamped_skipped_count: 1 },
				measured: { pairs_built: 3, model_calls: 2, model_tokens: 42 },
				by_operation: [
					expect.objectContaining({ operation: "rem-replace", applied_count: 2 }),
				],
			},
		});
		const audit = await waitForJsonl(getAuditPath(stateDir), (entries) =>
			entries.some(
				(entry) =>
					entry.event === "rem_completed" && entry.details?.["job_id"] === started.job_id,
			),
		);
		expect(
			audit.some(
				(entry) =>
					entry.event === "rem_failed" && entry.details?.["job_id"] === started.job_id,
			),
		).toBe(false);
	});





	it("keeps the durable done state when the completion audit cannot be written", async () => {
		const sidecar = await startSidecar({ holdMs: 500 });
		const started = await startJob(sidecar.discovery, "persona:audit-write-failure");
		const auditPath = getAuditPath(join(sidecar.stateRoot, "sno-station-mem"));
		await waitForJsonl(auditPath, (entries) =>
			entries.some(
				(entry) =>
					entry.event === "rem_triggered" && entry.details?.["job_id"] === started.job_id,
			),
		);
		rmSync(auditPath);
		mkdirSync(auditPath);

		const job = await waitForJob(sidecar.discovery, started.job_id, () => undefined);

		expect(job["state"]).toBe("done");
		expect(sidecar.stderr()).toContain("memory.audit.append.failed");
		expect(sidecar.stderr()).not.toContain('"event":"rem_failed"');
	});



	it("serves done from the completion receipt when the job transition cannot be journaled", async () => {
		const sidecar = await startSidecar({ holdMs: 500 });
		const started = await startJob(sidecar.discovery, "persona:completion-journal-failure");
		const stateDir = join(sidecar.stateRoot, "sno-station-mem");
		const auditPath = getAuditPath(stateDir);
		await waitForJsonl(auditPath, (entries) =>
			entries.some(
				(entry) =>
					entry.event === "rem_triggered" && entry.details?.["job_id"] === started.job_id,
			),
		);
		const journalPath = join(stateDir, "rem-wave-jobs.jsonl");
		renameSync(journalPath, `${journalPath}.saved`);
		mkdirSync(journalPath);

		await waitFor(
			() => sidecar.stderr().includes("rem.journal.failed"),
			() => `journal transition failure was not logged: ${sidecar.stderr()}`,
		);
		const job = await readJob(sidecar.discovery, started.job_id);
		expect(job["state"]).toBe("done");
		const audit = readFileSync(auditPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as AuditRecord);
		const terminalAudit = audit.filter(
				(entry) =>
					(entry["event"] === "rem_completed" || entry["event"] === "rem_failed") &&
					(entry["details"] as Record<string, unknown> | undefined)?.["job_id"] === started.job_id,
			);
		expect(terminalAudit).toHaveLength(1);
		expect(terminalAudit[0]?.event).toBe("rem_completed");
		expect(sidecar.stderr()).not.toContain('"event":"rem_failed"');
	});




});

function createTempRoot(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	cleanupPaths.push(path);
	return path;
}

async function startSidecar(
	options: {
		stateRoot?: string;
		profileRoot?: string;
		holdMs?: number;
		extraEnv?: Record<string, string>;
		withoutOperationalConfig?: boolean;
		withoutPersonaDb?: boolean;
	} = {},
): Promise<StartedSidecar> {
	const stateRoot = options.stateRoot ?? createTempRoot("mem-claw-rem-state-");
	const profileRoot = options.profileRoot ?? stateRoot;
	const discoveryPath = join(profileRoot, "station", "sidecar.json");
	const previousPid = readDiscovery(discoveryPath)?.pid;
	const started = spawnSidecar({ ...options, stateRoot, profileRoot });

	await waitFor(
		() => {
			const discovery = readDiscovery(discoveryPath);
			return discovery !== undefined && discovery.pid !== previousPid;
		},
		() => `sidecar did not write discovery; stderr=${started.stderr()}`,
	);
	const discovery = readDiscovery(discoveryPath);
	if (!discovery) throw new Error(`sidecar discovery disappeared at ${discoveryPath}`);
	const host = await startRemScriptedModelFixture([]);
	hostModels.push(host);
	const connected = await fetch(`http://127.0.0.1:${discovery.port}/v1/init`, {
		method: "POST",
		headers: { "x-sno-station-mem-skin": "rem-test" },
		body: JSON.stringify({
			scope: { principal: "test", project: "global", session: "rem-test" },
			registration: { skinId: "rem-test", model: {
				baseUrl: host.url.replace(/\/chat\/completions$/, ""),
				credential: "loopback-credential", model: "loopback-model",
			} },
		}),
		signal: AbortSignal.timeout(30_000),
	});
	expect(connected.status, await connected.clone().text()).toBe(200);
	return { ...started, discovery };
}

function spawnSidecar(options: {
	stateRoot: string;
	profileRoot: string;
	holdMs?: number;
	extraEnv?: Record<string, string>;
	withoutOperationalConfig?: boolean;
	withoutPersonaDb?: boolean;
}): Omit<StartedSidecar, "discovery"> {
	const extraEnv = { ...options.extraEnv };
	if (
		options.withoutOperationalConfig !== true &&
		extraEnv["SNO_STATION_MEM_REM_CONFIG_JSON"] === undefined
	) {
		extraEnv["SNO_STATION_MEM_REM_CONFIG_JSON"] = prepareRemEntryArtifactFixture(
			options.stateRoot,
			"valid",
		);
	}
	if (
		options.withoutPersonaDb !== true &&
		!existsSync(join(options.profileRoot, "settings.json"))
	) {
		const database = createTestDb();
		databaseCleanups.push(database.cleanup);
		writeTestInstallationConfig(options.profileRoot, {
				plugins: {
					entries: {
						"sno-mem-claw": {
							config: {
								dbPath: database.dbPath,
								embedding: { provider: "local-onnx", dimensions: 1024 },
							},
						},
					},
				},
			}, database.encryptionKey);
		personaDbPaths.set(options.stateRoot, database.dbPath);
		personaDatabases.set(options.stateRoot, database.sqlite);
		extraEnv["MEM_CLAW_DATA_DIR_ROOT"] = dirname(database.dbPath);
		extraEnv["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = database.dbPath;
	}
	const personaDbPath = personaDbPaths.get(options.stateRoot);
	if (personaDbPath !== undefined) {
		extraEnv["MEM_CLAW_DATA_DIR_ROOT"] ??= dirname(personaDbPath);
		extraEnv["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] ??= personaDbPath;
	}
	const stderrChunks: Buffer[] = [];
	const child = spawn(process.execPath, ["--import", "tsx", "src/sidecar/main.ts"], {
		cwd: appRoot,
		detached: process.platform !== "win32",
			env: {
				...process.env,
				NODE_ENV: "production",
				SNO_STATION_MEM_NODE_ENV: "production",
				VITEST: undefined,
				VITEST_WORKER_ID: undefined,
				LOG_FILE: undefined,
				SNO_STATION_HOME: options.stateRoot,
				LOG_LEVEL: "info",
				SNO_STATION_MEM_REM_TRACE: "1",
				SNO_PROFILE_DIR: options.profileRoot,
				HOME: join(options.stateRoot, "home"),
				...extraEnv,
			...(options.holdMs === undefined
				? {}
				: { SNO_STATION_MEM_REM_TEST_HOLD_MS: String(options.holdMs) }),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	children.push(child);
	child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
	return {
		child,
		stateRoot: options.stateRoot,
		profileRoot: options.profileRoot,
		stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
	};
}

function readDiscovery(path: string): Discovery | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Discovery;
	} catch {
		return undefined;
	}
}

async function startJob(
	discovery: Discovery,
	scope: string,
	jobType: "rem-update" | "rem-replace" = "rem-replace",
): Promise<{ job_id: string }> {
	const response = await fetch(`http://127.0.0.1:${discovery.port}/rem/run`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Sidecar-Token": discovery.token,
		},
		body: JSON.stringify({ type: jobType, scope }),
		signal: AbortSignal.timeout(2_000),
	});
	expect(response.status).toBe(202);
	return (await response.json()) as { job_id: string };
}

async function expectEmptyBuiltOperationCompletes(
	jobType: "rem-update" | "rem-replace",
	scope: string,
): Promise<void> {
	const sidecar = await startSidecar();
	const response = await fetch(`http://127.0.0.1:${sidecar.discovery.port}/rem/run`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Sidecar-Token": sidecar.discovery.token,
		},
		body: JSON.stringify({ type: jobType, scope }),
		signal: AbortSignal.timeout(2_000),
	});
	expect(response.status).toBe(202);
	const started = (await response.json()) as { job_id: string };
	const terminal = await waitForJob(sidecar.discovery, started.job_id, () => undefined);
	if (
		scope === "persona:qcg-13-empty-statistics" &&
		(terminal["stats"] as Record<string, unknown> | undefined)?.["applied_fraction"] !== null
	) {
		throw new Error(
			`QCG26_ASSERT_EMPTY_APPLIED_FRACTION: ${JSON.stringify(terminal)}`,
		);
	}
	expect(terminal).toMatchObject({
		job_id: started.job_id,
		state: "done",
		type: jobType,
		scope,
		stats: {
			operations: 0,
			scan: { scope, candidate_count: 0 },
			applied_count: 0,
			actionable_candidate_count: 0,
			applied_fraction: null,
			parse_failure_count: 0,
			top_refusal_reasons: [],
		},
	});
	const durableJobs = await waitForLines(
		join(sidecar.stateRoot, "sno-station-mem", "rem-wave-jobs.jsonl"),
		(lines) =>
			lines.some(
				(line) => line.includes(started.job_id) && line.includes('"state":"done"'),
			),
	);
	expect(durableJobs.join("\n")).toContain('"applied_fraction":null');
	const audit = await waitForJsonl(
		getAuditPath(join(sidecar.stateRoot, "sno-station-mem")),
		(entries) =>
			entries.some(
				(entry) =>
					entry.event === "rem_completed" && entry.details?.["job_id"] === started.job_id,
			),
	);
	expect(audit).toContainEqual(
		expect.objectContaining({
			event: "rem_completed",
			details: expect.objectContaining({ job_id: started.job_id, type: jobType }),
		}),
	);
}

async function readJob(discovery: Discovery, jobId: string): Promise<Record<string, unknown>> {
	const response = await fetch(`http://127.0.0.1:${discovery.port}/rem/jobs/${jobId}`, {
		headers: { "X-Sidecar-Token": discovery.token },
		signal: AbortSignal.timeout(2_000),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as Record<string, unknown>;
}

async function waitForJob(
	discovery: Discovery,
	jobId: string,
	onRequest: () => void,
	timeoutMs = 4_000,
): Promise<Record<string, unknown>> {
	let latest: Record<string, unknown> = {};
	await waitFor(async () => {
		onRequest();
		latest = await readJob(discovery, jobId);
		return latest["state"] === "done" || latest["state"] === "failed";
	}, () => `REM job did not reach terminal state: ${JSON.stringify(latest)}`, timeoutMs);
	return latest;
}

interface AuditRecord {
	event?: string;
	details?: Record<string, unknown>;
	reason_code?: string;
}

async function waitForJsonl(
	path: string,
	predicate: (entries: AuditRecord[]) => boolean,
): Promise<AuditRecord[]> {
	let entries: AuditRecord[] = [];
	await waitFor(() => {
		if (!existsSync(path)) return false;
		entries = readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as AuditRecord);
		return predicate(entries);
	}, () => `expected audit records did not appear at ${path}`);
	return entries;
}

async function waitForLines(
	path: string,
	predicate: (lines: string[]) => boolean,
	failureMarker?: string,
): Promise<string[]> {
	let lines: string[] = [];
	await waitFor(() => {
		if (!existsSync(path)) return false;
		lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		return predicate(lines);
	}, () => `${failureMarker ? `${failureMarker}: ` : ""}expected lines did not appear at ${path}`);
	return lines;
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	message: () => string,
	timeoutMs = 4_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	throw new Error(message());
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
	const index = children.indexOf(child);
	if (index >= 0) children.splice(index, 1);
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	const exited = once(child, "exit");
	try {
		if (process.platform === "win32") {
			child.kill(signal);
		} else {
			process.kill(-child.pid, signal);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await Promise.race([
		exited,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`child ${child.pid} did not exit`)), 2_000),
		),
	]);
}
