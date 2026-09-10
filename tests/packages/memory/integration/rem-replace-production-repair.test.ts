import { writeTestInstallationConfig } from "../../../apps/mem-claw/helpers/module-config-fixture";
/** @file rem-replace-production-repair.test.ts
 * @purpose Proves the durable REM replace repair through the production batch entry.
 * @boundary Real REM batch code and repository over one real SQLite database.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createRemModelStageResponsePort,
	runRemBatchJob,
	type RemModelStage,
} from "../../../../packages/sno-station-mem/src/sidecar/rem-batch-executor.ts";
import {
	createRemRepository,
	installRemSchema,
	parseRemOperationalConfiguration,
} from "../../../../packages/sno-station-mem/src/engine/rem/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { seedProductionMemory } from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const priorEnvironment = {
	SNO_STATION_MEM_DATA_DIR_ROOT: process.env["SNO_STATION_MEM_DATA_DIR_ROOT"],
	SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
	SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
};

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	restoreEnvironment("SNO_STATION_MEM_DATA_DIR_ROOT", priorEnvironment.SNO_STATION_MEM_DATA_DIR_ROOT);
	restoreEnvironment("SNO_STATION_MEM_REM_EXPECTED_DB_PATH", priorEnvironment.SNO_STATION_MEM_REM_EXPECTED_DB_PATH);
	restoreEnvironment("SNO_PROFILE_DIR", priorEnvironment.SNO_PROFILE_DIR);
});

describe("REM replace production repair", () => {
	it("persists and resumes the complete ordered pair queue across capped jobs", { timeout: 60_000 }, async () => {
		const fixture = prepareFixture();
		const scope = "persona:rem-replace-queue-repair";
		for (let index = 0; index < 3; index += 1) {
			seedProductionMemory(fixture.runtime.raw, {
				id: `replace-queue-row-${index}`,
				scope,
				text: `The researcher has been studying storage option ${index}.`,
				metadata: {
					fact_key: "profile:preferences.storage",
					section_name: "preferences.storage",
				},
				timestamp: `2026-08-0${index + 1}T08:00:00.000Z`,
			});
		}

		const result = await runReplace(fixture, {
			jobId: "rem-replace-queue-first",
			maxPairs: 2,
			scope,
		});
		const generations = fixture.runtime.raw
			.prepare("SELECT generation_id FROM nodix_rem_scan_generations ORDER BY rowid")
			.all() as Array<{ generation_id: string }>;
		const pairs = fixture.runtime.raw
			.prepare(
				`SELECT pair_id, claim_state, progress_state
				FROM nodix_rem_scan_pairs WHERE generation_id = ? ORDER BY sort_key`,
			)
			.all(generations[0]?.generation_id) as Array<{
				pair_id: string;
				claim_state: string;
				progress_state: string;
			}>;

		expect(result.measurements.pairCapBinding).toBe(true);
		expect(generations).toHaveLength(1);
		expect(pairs, "all three ordered pairs must exist before two pairs are claimed").toHaveLength(3);
		expect(pairs.filter((pair) => pair.claim_state === "done")).toHaveLength(2);
		expect(pairs.filter((pair) => pair.claim_state === "unvisited")).toHaveLength(1);

		await runReplace(fixture, {
			jobId: "rem-replace-queue-second",
			maxPairs: 2,
			scope,
		});
		const resumedGenerations = fixture.runtime.raw
			.prepare("SELECT generation_id FROM nodix_rem_scan_generations ORDER BY rowid")
			.all() as Array<{ generation_id: string }>;
		const resumedPairs = fixture.runtime.raw
			.prepare(
				`SELECT claim_state, progress_state FROM nodix_rem_scan_pairs
				WHERE generation_id = ? ORDER BY sort_key`,
			)
			.all(generations[0]?.generation_id) as Array<{
				claim_state: string;
				progress_state: string;
			}>;
		expect(resumedGenerations).toEqual(generations);
		expect(resumedPairs.every((pair) => pair.claim_state === "done")).toBe(true);
		expect(resumedPairs.every((pair) => pair.progress_state === "closed")).toBe(true);
	});

	it("releases both rows after keep so the following update claim succeeds", { timeout: 60_000 }, async () => {
		const fixture = prepareFixture();
		const scope = "persona:rem-replace-keep-release";
		for (let index = 0; index < 2; index += 1) {
			seedProductionMemory(fixture.runtime.raw, {
				id: `replace-keep-row-${index}`,
				scope,
				text: `The researcher keeps storage option ${index}.`,
				metadata: {
					fact_key: "profile:preferences.keep-storage",
					section_name: "preferences.keep-storage",
				},
				timestamp: `2026-08-0${index + 1}T09:00:00.000Z`,
			});
		}

		await runReplace(fixture, {
			jobId: "rem-replace-keep-release",
			maxPairs: 1,
			scope,
		});
		const rows = fixture.runtime.raw
			.prepare(
				`SELECT ledger.row_id, ledger.content_hash, ledger.owner
				FROM nodix_rem_relation_ledger AS ledger
				JOIN nodix_memories AS memory ON memory.id = ledger.row_id
				WHERE memory.project_id = ? ORDER BY ledger.row_id`,
			)
			.all(scope) as Array<{ row_id: string; content_hash: string; owner: string }>;

		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.owner)).toEqual(["none", "none"]);
		const repository = createRemRepository(fixture.runtime.db);
		for (const [index, row] of rows.entries()) {
			expect(
				repository.claimRow({
					rowId: row.row_id,
					contentHash: row.content_hash,
					owner: "restate",
					claimToken: `following-update-${index}`,
					claimTs: "2026-08-29T21:00:00.000Z",
					holderPid: process.pid,
				}),
			).toEqual({ claimed: true });
		}
	});

	it("replays a completed row claim only for the same durable ownership and hashes", () => {
		const fixture = prepareFixture();
		installRemSchema(fixture.runtime.db);
		const rowId = seedProductionMemory(fixture.runtime.raw, {
			scope: "persona:rem-replace-row-claim-restart",
			text: "The researcher keeps the same storage preference after restart.",
		});
		const contentHash = fixture.runtime.raw
			.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?")
			.pluck()
			.get(rowId) as string;
		const repository = createRemRepository(fixture.runtime.db);
		repository.recordClassification({
			rowId,
			contentHash,
			state: "stale-current",
			classifiedAt: "2026-08-29T21:10:00.000Z",
		});
		expect(
			repository.claimRow({
				rowId,
				contentHash,
				owner: "verdict",
				claimToken: "restart-row-claim-token",
				claimTs: "2026-08-29T21:10:01.000Z",
				holderPid: process.pid,
			}),
		).toEqual({ claimed: true });
		const completion = {
			rowId,
			contentHash,
			currentContentHash: contentHash,
			owner: "verdict" as const,
			claimToken: "restart-row-claim-token",
			completedAt: "2026-08-29T21:10:02.000Z",
			jobId: "rem-replace-row-claim-restart",
			jobType: "rem-replace" as const,
		};
		expect(repository.completeRowClaim(completion)).toEqual({ completed: true });

		const restartedRepository = createRemRepository(fixture.runtime.db);
		expect(restartedRepository.completeRowClaim(completion)).toEqual({ completed: true });
		expect(
			restartedRepository.completeRowClaim({ ...completion, owner: "restate" }),
		).toMatchObject({ completed: false });
		expect(
			restartedRepository.completeRowClaim({ ...completion, contentHash: "f".repeat(64) }),
		).toMatchObject({ completed: false });

		fixture.runtime.raw
			.prepare("UPDATE nodix_memories SET text = ?, content_hash = ? WHERE id = ?")
			.run("The storage preference changed after completion.", "e".repeat(64), rowId);
		expect(restartedRepository.completeRowClaim(completion)).toMatchObject({ completed: false });
		expect(
			fixture.runtime.raw
				.prepare("SELECT state FROM nodix_rem_row_claims WHERE row_id = ?")
				.pluck()
				.get(rowId),
		).toBe("completed");
	});

	it("rejects a delayed checkpoint that would move an applied pair backward", () => {
		const fixture = prepareFixture();
		installRemSchema(fixture.runtime.db);
		const repository = createRemRepository(fixture.runtime.db);
		repository.createVerdictGeneration({
			generationId: "restart-checkpoint-generation",
			corpusSnapshotHash: "a".repeat(64),
			pairingConfigHash: "b".repeat(64),
			maxLlmCalls: 3,
			maxTokens: 8_192,
			pairs: [
				{
					pairId: "restart-checkpoint-pair",
					leftRowId: "restart-left",
					rightRowId: "restart-right",
					sortKey: "restart-checkpoint-sort",
				},
			],
		});
		expect(
			repository.claimNextPair({
				generationId: "restart-checkpoint-generation",
				invocationId: "restart-checkpoint-invocation",
				claimedAt: "2026-08-29T21:20:00.000Z",
				holderPid: process.pid,
			}),
		).toMatchObject({ pairId: "restart-checkpoint-pair" });
		for (const checkpoint of ["before_llm", "verdict_recorded", "action_applied"] as const) {
			repository.recordVerdictCheckpoint({
				generationId: "restart-checkpoint-generation",
				pairId: "restart-checkpoint-pair",
				invocationId: "restart-checkpoint-invocation",
				checkpoint,
				recordedAt: "2026-08-29T21:20:01.000Z",
				...(checkpoint === "verdict_recorded" ? { verdict: "replacement" } : {}),
			});
		}

		expect(() =>
			repository.recordVerdictCheckpoint({
				generationId: "restart-checkpoint-generation",
				pairId: "restart-checkpoint-pair",
				invocationId: "restart-checkpoint-invocation",
				checkpoint: "verdict_recorded",
				verdict: "keep",
				recordedAt: "2026-08-29T21:20:02.000Z",
			}),
		).toThrow(/pair|invocation|checkpoint/i);
		expect(
			repository.readVerdictPair("restart-checkpoint-generation", "restart-checkpoint-pair"),
		).toEqual({ checkpoint: "action_applied", actionsApplied: 1 });
	});

	it("reports truthful soft-close write counts and refuses a durable mismatch", { timeout: 60_000 }, async () => {
		const fixture = prepareFixture();
		const positiveScope = "persona:rem-replace-count-positive";
		seedReplacementPair(fixture, positiveScope, "positive");
		const positive = await runReplace(fixture, {
			jobId: "rem-replace-count-positive",
			maxPairs: 1,
			respond: replacementResponse,
			scope: positiveScope,
		});
		const successfulWrites = fixture.runtime.raw
			.prepare(
				`SELECT count(*) FROM nodix_rem_write_attempts
				WHERE job_id = ? AND writer = 'softClose' AND outcome = 'succeeded'`,
			)
			.pluck()
			.get("rem-replace-count-positive") as number;
		expect(positive.actionsApplied).toBe(successfulWrites);
		expect(successfulWrites).toBe(1);

		const baselineScope = "persona:rem-replace-count-baseline";
		seedReplacementPair(fixture, baselineScope, "baseline");
		insertSucceededSoftClose(
			fixture,
			"planted-count-baseline",
			"rem-replace-count-baseline",
		);
		const baseline = await runReplace(fixture, {
			jobId: "rem-replace-count-baseline",
			maxPairs: 1,
			respond: replacementResponse,
			scope: baselineScope,
		});
		const baselineTotal = fixture.runtime.raw
			.prepare(
				`SELECT count(*) FROM nodix_rem_write_attempts
				WHERE job_id = ? AND writer = 'softClose' AND outcome = 'succeeded'`,
			)
			.pluck()
			.get("rem-replace-count-baseline") as number;
		expect(baseline.actionsApplied).toBe(1);
		expect(baselineTotal).toBe(2);

		const negativeScope = "persona:rem-replace-count-negative";
		seedReplacementPair(fixture, negativeScope, "negative");
		let mismatchInserted = false;
		await expect(
			runReplace(fixture, {
				jobId: "rem-replace-count-negative",
				maxPairs: 1,
				respond: async (request) => {
					if (!mismatchInserted) {
						mismatchInserted = true;
						insertSucceededSoftClose(
							fixture,
							"planted-count-during-invocation",
							"rem-replace-count-negative",
						);
					}
					return replacementResponse(request);
				},
				scope: negativeScope,
			}),
		).rejects.toThrow(/actions|count|durable|write/i);

		const lostScope = "persona:rem-replace-count-lost";
		seedReplacementPair(fixture, lostScope, "lost");
		fixture.runtime.raw.exec(`
			CREATE TRIGGER plant_current_soft_close_loss
			AFTER INSERT ON nodix_rem_journal
			WHEN NEW.job_id = 'rem-replace-count-lost'
				AND NEW.stage LIKE 'replace-pair:%'
				AND NEW.outcome = 'done'
			BEGIN
				UPDATE nodix_rem_write_attempts
				SET outcome = 'failed', reason_code = 'planted_durable_loss'
				WHERE job_id = NEW.job_id AND writer = 'softClose' AND outcome = 'succeeded';
			END;
		`);
		await expect(
			runReplace(fixture, {
				jobId: "rem-replace-count-lost",
				maxPairs: 1,
				respond: replacementResponse,
				scope: lostScope,
			}),
		).rejects.toThrow(/actions|count|durable|write/i);
		expect(
			fixture.runtime.raw
				.prepare(
					`SELECT count(*) FROM nodix_rem_write_attempts
					WHERE job_id = ? AND writer = 'softClose' AND outcome = 'succeeded'`,
				)
				.pluck()
				.get("rem-replace-count-lost"),
		).toBe(0);
	});
});

function prepareFixture(): TestDb {
	const fixture = createTestDb();
	const stateRoot = mkdtempSync(join(tmpdir(), "rem-replace-production-repair-"));
	writeTestInstallationConfig(stateRoot, {
			plugins: {
				entries: {
					"sno-mem-claw": {
						config: {
							dbPath: fixture.dbPath,
							embedding: { dimensions: 1024, provider: "local-onnx" },
						},
					},
				},
			},
		});
	process.env["SNO_STATION_MEM_DATA_DIR_ROOT"] = dirname(fixture.dbPath);
	process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = fixture.dbPath;
	process.env["SNO_PROFILE_DIR"] = stateRoot;
	cleanups.push(() => {
		fixture.cleanup();
		rmSync(stateRoot, { recursive: true, force: true });
	});
	return fixture;
}

async function runReplace(
	fixture: TestDb,
	input: {
		jobId: string;
		maxPairs: number;
		respond?: Parameters<typeof createRemModelStageResponsePort>[0]["respond"];
		scope: string;
	},
): Promise<Awaited<ReturnType<typeof runRemBatchJob>>> {
	return runRemBatchJob({
		jobId: input.jobId,
		jobType: "rem-replace",
		scope: input.scope,
		configuration: configuration(input.maxPairs),
		modelStageResponses: createRemModelStageResponsePort({
			respond: input.respond ?? (async ({ stage }) => {
				if (stage === "rem-replace-pair") return "keep";
				throw new Error(`unexpected model stage: ${stage}`);
			}),
		}),
	});
}

function seedReplacementPair(fixture: TestDb, scope: string, suffix: string): void {
	for (let index = 0; index < 2; index += 1) {
		seedProductionMemory(fixture.runtime.raw, {
			id: `replace-count-${suffix}-${index}`,
			scope,
			text: `The researcher has been studying ${suffix} storage option ${index}.`,
			metadata: {
				fact_key: `profile:preferences.${suffix}-storage`,
				section_name: `preferences.${suffix}-storage`,
			},
			timestamp: `2026-08-0${index + 1}T10:00:00.000Z`,
		});
	}
}

function insertSucceededSoftClose(fixture: TestDb, attemptId: string, jobId: string): void {
	fixture.runtime.raw
		.prepare(
			`INSERT INTO nodix_rem_write_attempts(
				attempt_id, job_id, stage, row_id, writer, attempt_ordinal, outcome,
				pre_write_content_sha256, proposed_text_sha256, evidence_id,
				configuration_sha256, opened_at, closed_at
			) VALUES (?, ?, 'rem-replace', ?, 'softClose', 1, 'succeeded', ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			attemptId,
			jobId,
			`row-${attemptId}`,
			"a".repeat(64),
			"b".repeat(64),
			`evidence-${attemptId}`,
			"c".repeat(64),
			"2026-08-29T21:00:00.000Z",
			"2026-08-29T21:00:01.000Z",
		);
}


function configuration(maxPairs: number) {
	const value = createRemOwnerDecidedOperationalConfiguration();
	return parseRemOperationalConfiguration({
		...value,
		budgets: { maxPairs },
		retrieval: { neighborLimit: 10, similarityThreshold: 1 },
	});
}

async function replacementResponse(input: { stage: RemModelStage; prompt: string }): Promise<string> {
	if (input.stage === "rem-replace-pair") return "replacement";
	if (input.stage === "rem-replace-clauses") {
		return JSON.stringify({ verdict: "replacement", retiring_clause_indices: [0] });
	}
	if (input.stage === "rem-replace-coverage") {
		return JSON.stringify({
			atoms: [{ clause_index: 0, class: "retired-fact", status: "covered" }],
		});
	}
	throw new Error(`unexpected model stage: ${input.stage}`);
}

function restoreEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
