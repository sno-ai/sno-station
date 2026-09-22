import { writeTestInstallationConfig } from "../../../apps/mem-claw/helpers/module-config-fixture";
/** @file rem-activation-measurement-transport.test.ts
 * @purpose Proves every supported automatic operation set persists explicit pair-cap measurements.
 * @boundary Real sidecar HTTP entry, strict job journal, and terminal audit JSONL.
 * @acceptance ACC-47
 * @class repair
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRemOperationalConfiguration } from "../../../../packages/memory/src/engine/rem/index.ts";
import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import {
	startRemProductionEntryFixture,
	seedProductionMemory,
} from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

describe("REM activation measurement transport", () => {
	it("ACC-47 records zero non-binding pairs for an update-only wave", { timeout: 20_000 }, async () => {
		const fixture = await startRemProductionEntryFixture();
		try {
			const correlationId = "correlation-activation-update-only";
			const started = await fixture.submitWave(
				["rem-update"],
				"persona:activation-update-only",
				correlationId,
			);
			const identity = started["waveId"] ?? started["job_id"];
			expect(identity).toBeTypeOf("string");
			const terminal = await fixture.waitForTerminal(String(identity), 10_000);
			expect(terminal).toMatchObject({
				state: "done",
				stats: {
					measured: {
						pairs_built: 0,
						pair_cap_binding: false,
					},
				},
			});

			const audit = readFileSync(join(fixture.stateRoot, "sno-station-mem", "audit.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(audit).toContainEqual(
				expect.objectContaining({
					event: "rem_completed",
					details: expect.objectContaining({
						correlation_id: correlationId,
						stats: expect.objectContaining({
							measured: expect.objectContaining({
								pairs_built: 0,
								pair_cap_binding: false,
							}),
						}),
					}),
				}),
			);
		} finally {
			await fixture.stop();
		}
	});

	it("ACC-47 distinguishes an exact pair cap from a binding cap", { timeout: 30_000 }, async () => {
		const exact = await runMeasuredReplace(2);
		const binding = await runMeasuredReplace(3);

		expect(exact).toEqual({ pairsBuilt: 1, pairCapBinding: false });
		expect(binding).toEqual({ pairsBuilt: 1, pairCapBinding: true });
	});

	it("keeps an older fact when clause carry falsely says it is already current", async () => {
		const database = createTestDb();
		const stateRoot = mkdtempSync(join(tmpdir(), "rem-clause-carry-floor-"));
		const priorEnvironment = {
			MEM_CLAW_DATA_DIR_ROOT: process.env["MEM_CLAW_DATA_DIR_ROOT"],
			SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
			SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
		};
		try {
			process.env["MEM_CLAW_DATA_DIR_ROOT"] = dirname(database.dbPath);
			process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = database.dbPath;
			process.env["SNO_PROFILE_DIR"] = stateRoot;
			writeTestInstallationConfig(stateRoot, {
					plugins: {
						entries: {
							"sno-mem-claw": {
								config: {
									dbPath: database.dbPath,
									embedding: { dimensions: 1024, provider: "local-onnx" },
								},
							},
						},
					},
				});
			const scope = "persona:clause-carry-floor";
			const olderText = "The researcher preferred tea. The researcher works late.";
			const newerText = "The researcher now prefers coffee.";
			seedProductionMemory(database.runtime.raw, {
				id: "clause-carry-older",
				scope,
				text: olderText,
				timestamp: "2026-08-09T08:00:00.000Z",
			});
			seedProductionMemory(database.runtime.raw, {
				id: "clause-carry-newer",
				scope,
				text: newerText,
				timestamp: "2026-08-10T08:00:00.000Z",
			});
			const configuration = parseRemOperationalConfiguration({
				...createRemOwnerDecidedOperationalConfiguration(),
				budgets: { maxPairs: 1 },
				retrieval: { neighborLimit: 2, similarityThreshold: 1 },
			});

			const result = await runRemBatchJob({
				jobId: "clause-carry-floor-wave",
				jobType: "rem-replace",
				scope,
				configuration,
				modelStageResponses: createRemModelStageResponsePort({
					respond: async ({ stage }) => {
						if (stage === "rem-replace-pair") return "replacement";
						if (stage === "rem-replace-clauses") {
							return JSON.stringify({ verdict: "replacement", retiring_clause_indices: [0] });
						}
						if (stage === "rem-replace-coverage") {
							return JSON.stringify({
								atoms: [{ clause_index: 0, class: "retired-fact", status: "covered" }],
							});
						}
						if (stage === "rem-replace-clause-carry") {
							return JSON.stringify({ already_current: [true] });
						}
						return JSON.stringify({
							faithful: true,
							retired_absent: true,
							all_facts_accounted: true,
						});
					},
				}),
			});

			const survivor = database.runtime.raw
				.prepare("SELECT text FROM nodix_memories WHERE id = ?")
				.get("clause-carry-newer") as { text: string };
			expect(result.actionsApplied).toBe(1);
			expect(survivor.text).toContain("The researcher works late.");
		} finally {
			restoreEnvironment("MEM_CLAW_DATA_DIR_ROOT", priorEnvironment.MEM_CLAW_DATA_DIR_ROOT);
			restoreEnvironment(
				"SNO_STATION_MEM_REM_EXPECTED_DB_PATH",
				priorEnvironment.SNO_STATION_MEM_REM_EXPECTED_DB_PATH,
			);
			restoreEnvironment("SNO_PROFILE_DIR", priorEnvironment.SNO_PROFILE_DIR);
			database.cleanup();
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});

async function runMeasuredReplace(candidateCount: number): Promise<{
	pairsBuilt: number;
	pairCapBinding: boolean;
}> {
	const database = createTestDb();
	const stateRoot = mkdtempSync(join(tmpdir(), "rem-measurement-"));
	const priorEnvironment = {
		MEM_CLAW_DATA_DIR_ROOT: process.env["MEM_CLAW_DATA_DIR_ROOT"],
		SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
		SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
	};
	try {
		process.env["MEM_CLAW_DATA_DIR_ROOT"] = dirname(database.dbPath);
		process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = database.dbPath;
		process.env["SNO_PROFILE_DIR"] = stateRoot;
		writeTestInstallationConfig(stateRoot, {
				plugins: {
					entries: {
						"sno-mem-claw": {
							config: {
								dbPath: database.dbPath,
								embedding: { dimensions: 1024, provider: "local-onnx" },
							},
						},
					},
				},
			});
		const scope = `persona:pair-cap-${candidateCount}`;
		for (let index = 0; index < candidateCount; index++) {
			seedProductionMemory(database.runtime.raw, {
				id: `pair-cap-${candidateCount}-${index}`,
				scope,
				text: `The researcher has been studying storage option ${index}.`,
				metadata: { section_name: "preferences.shared-pair-cap" },
			});
		}
		const rawConfiguration = createRemOwnerDecidedOperationalConfiguration();
		const configuration = parseRemOperationalConfiguration({
			...rawConfiguration,
			budgets: { maxPairs: 1 },
			retrieval: { neighborLimit: candidateCount, similarityThreshold: 1 },
		});
		const result = await runRemBatchJob({
			jobId: `pair-cap-wave-${candidateCount}-${createHash("sha256").update(scope).digest("hex").slice(0, 8)}`,
			jobType: "rem-replace",
			scope,
			configuration,
			modelStageResponses: createRemModelStageResponsePort({
				respond: async ({ stage }) => {
					if (stage === "rem-replace-pair") return "replacement";
					if (stage === "rem-replace-clauses") {
						return JSON.stringify({ verdict: "replacement", retiring_clause_indices: [0] });
					}
					return JSON.stringify({
						atoms: [{ clause_index: 0, class: "retired-fact", status: "covered" }],
					});
				},
			}),
		});
		return {
			pairsBuilt: result.measurements.pairsBuilt,
			pairCapBinding: result.measurements.pairCapBinding,
		};
	} finally {
		restoreEnvironment("MEM_CLAW_DATA_DIR_ROOT", priorEnvironment.MEM_CLAW_DATA_DIR_ROOT);
		restoreEnvironment(
			"SNO_STATION_MEM_REM_EXPECTED_DB_PATH",
			priorEnvironment.SNO_STATION_MEM_REM_EXPECTED_DB_PATH,
		);
		restoreEnvironment("SNO_PROFILE_DIR", priorEnvironment.SNO_PROFILE_DIR);
		database.cleanup();
		rmSync(stateRoot, { recursive: true, force: true });
	}
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
