/** @file rem-batch-crash-resume.test.ts
 * @purpose Proves verdict checkpoints resume exactly once across independent Node processes.
 * @boundary Real encrypted SQLite and production repository operations; no in-process substitute.
 */

import {
	spawn,
	spawnSync,
	type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRemRepository,
	installRemSchema,
	type RemVerdictCheckpoint,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import { openSqliteDatabase } from "../../../../packages/memory/src/store/sqlite-runtime.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const tsxBinary = resolve(repoRoot, "node_modules/.bin/tsx");
const workerPath = resolve(
	repoRoot,
	"tests/apps/mem-claw/helpers/rem-batch-crash-worker.ts",
);
const pythonBinary = "python3";
const bootIdPath = "/proc/sys/kernel/random/boot_id";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

let fixture: TestDb;
const holdingChildren: ChildProcessWithoutNullStreams[] = [];

beforeEach(() => {
	fixture = createTestDb();
	installRemSchema(fixture.runtime.db);
});

afterEach(async () => {
	for (const child of holdingChildren.splice(0)) await stopChild(child);
	fixture.cleanup();
});

describe("REM verdict crash and resume", () => {
	for (const testCase of [
		{ checkpoint: "before_llm" as const, firstNext: "call_llm", finalNext: "call_llm" },
		{
			checkpoint: "cancellation_requested" as const,
			firstNext: "call_llm",
			finalNext: "call_llm",
		},
		{
			checkpoint: "verdict_recorded" as const,
			firstNext: "apply_action",
			finalNext: "complete",
		},
		{ checkpoint: "action_applied" as const, firstNext: "complete", finalNext: "complete" },
	] satisfies Array<{
		checkpoint: RemVerdictCheckpoint;
		firstNext: string;
		finalNext: string;
	}>) {
		it(`family 6: resumes ${testCase.checkpoint} in a new process without duplicate action`, () => {
			const generationId = `generation-${testCase.checkpoint}`;
			const pairId = `pair-${testCase.checkpoint}`;
			createRemRepository(fixture.runtime.db).createVerdictGeneration({
				generationId,
				corpusSnapshotHash: HASH_A,
				pairingConfigHash: HASH_B,
				maxLlmCalls: 1,
				maxTokens: 100,
				pairs: [{ pairId, leftRowId: "left", rightRowId: "right", sortKey: "0" }],
			});

			const checkpoint = runWorker([
				"checkpoint",
				fixture.dbPath,
				generationId,
				pairId,
				testCase.checkpoint,
			]);
			expect(checkpoint.status, checkpoint.stderr).toBe(0);
			const checkpointResult = JSON.parse(checkpoint.stdout) as { owner: string };
			const resumed = runWorker([
				"resume",
				fixture.dbPath,
				generationId,
				pairId,
				checkpointResult.owner,
			]);
			expect(resumed.status, resumed.stderr).toBe(0);
			const result = JSON.parse(resumed.stdout) as {
				directive: { next: string };
				after: { next: string };
				owner: string;
				actionsApplied: number;
			};
			expect(result.directive.next).toBe(testCase.firstNext);
			expect(result.after.next).toBe(testCase.finalNext);
			expect(result.actionsApplied).toBeLessThanOrEqual(1);

			const repeated = runWorker([
				"resume",
				fixture.dbPath,
				generationId,
				pairId,
				result.owner,
			]);
			expect(repeated.status, repeated.stderr).toBe(0);
			const repeatedResult = JSON.parse(repeated.stdout) as {
				actionsApplied: number;
			};
			expect(repeatedResult.actionsApplied).toBe(result.actionsApplied);
		});
	}

	it("rem-batch-crash-resume", () => {
		const generationId = "generation-section-6a-crash-resume";
		const pairId = "pair-section-6a-crash-resume";
		createRemRepository(fixture.runtime.db).createVerdictGeneration({
			generationId,
			corpusSnapshotHash: HASH_A,
			pairingConfigHash: HASH_B,
			maxLlmCalls: 1,
			maxTokens: 100,
			pairs: [{ pairId, leftRowId: "left", rightRowId: "right", sortKey: "0" }],
		});

		const checkpoint = runWorker([
			"checkpoint",
			fixture.dbPath,
			generationId,
			pairId,
			"verdict_recorded",
		]);
		expect(checkpoint.status, checkpoint.stderr).toBe(0);
		const owner = (JSON.parse(checkpoint.stdout) as { owner: string }).owner;
		const resumed = runWorker(["resume", fixture.dbPath, generationId, pairId, owner]);
		expect(resumed.status, resumed.stderr).toBe(0);
		const first = JSON.parse(resumed.stdout) as {
			directive: { next: string };
			after: { next: string };
			owner: string;
			actionsApplied: number;
		};
		expect(first).toMatchObject({
			directive: { next: "apply_action" },
			after: { next: "complete" },
			actionsApplied: 1,
		});

		const repeated = runWorker(["resume", fixture.dbPath, generationId, pairId, first.owner]);
		expect(repeated.status, repeated.stderr).toBe(0);
		expect(JSON.parse(repeated.stdout)).toMatchObject({
			after: { next: "complete" },
			actionsApplied: 1,
		});
	});

	it("recovers a killed row claimant and completes the durable owner exactly once", async () => {
		const repository = createRemRepository(fixture.runtime.db);
		insertMemory("row-crash", HASH_A);
		repository.recordClassification({
			rowId: "row-crash",
			contentHash: HASH_A,
			state: "stale-current",
			classifiedAt: "2026-07-31T08:00:00.000Z",
		});
		const held = await startHoldingWorker([
			"row-claim-hold",
			fixture.dbPath,
			"row-crash",
			HASH_A,
			"verdict",
			"row-attempt-original",
			"2026-07-31T08:00:00.000Z",
		]);
		expect(() => process.kill(requireChildPid(held.child), 0)).not.toThrow();

		const beforeLiveRecovery = readRowClaimBytes("row-crash");
		const liveRecovery = runWorker([
			"row-recover",
			fixture.dbPath,
			"row-crash",
			HASH_A,
			"verdict",
			"row-attempt-original",
			"row-attempt-live-competitor",
			"2026-07-31T08:01:00.000Z",
		]);
		expect(liveRecovery.status, liveRecovery.stderr).toBe(0);
		expect(JSON.parse(liveRecovery.stdout)).toEqual({
			recovered: { recovered: false, reason: "holder_alive" },
		});
		expect(readRowClaimBytes("row-crash")).toBe(beforeLiveRecovery);

		await stopChild(held.child);
		const staleClaim = runWorker([
			"row-claim",
			fixture.dbPath,
			"row-crash",
			HASH_A,
			"verdict",
			"row-attempt-recovered",
			"2026-07-31T08:02:00.000Z",
		]);
		expect(staleClaim.status, staleClaim.stderr).toBe(0);
		const staleClaimResult = JSON.parse(staleClaim.stdout) as {
			result: { claimed: false; reason: string; claimToken: string };
		};
		expect(staleClaimResult).toEqual({
			result: {
				claimed: false,
				reason: "already_claimed",
				claimToken: "row-attempt-original",
			},
		});
		const recovered = runWorker([
			"row-recover-complete",
			fixture.dbPath,
			"row-crash",
			HASH_A,
			"verdict",
			staleClaimResult.result.claimToken,
			"row-attempt-recovered",
			"2026-07-31T08:02:00.000Z",
		]);
		expect(recovered.status, recovered.stderr).toBe(0);
		expect(JSON.parse(recovered.stdout)).toEqual({
			recovered: { recovered: true },
			completed: { completed: true },
		});
		expect(readRowClaim("row-crash")).toMatchObject({
			owner: "verdict",
			claim_ts: null,
			state: "completed",
		});

		const staleRecovery = runWorker([
			"row-recover",
			fixture.dbPath,
			"row-crash",
			HASH_A,
			"verdict",
			"row-attempt-original",
			"row-attempt-stale",
			"2026-07-31T08:03:00.000Z",
		]);
		expect(staleRecovery.status, staleRecovery.stderr).toBe(0);
		expect(JSON.parse(staleRecovery.stdout)).toEqual({
			recovered: { recovered: false, reason: "claim_changed" },
		});
	});

	it("recovers an unreaped zombie row claimant exactly once", async () => {
		const repository = createRemRepository(fixture.runtime.db);
		insertMemory("row-zombie", HASH_A);
		repository.recordClassification({
			rowId: "row-zombie",
			contentHash: HASH_A,
			state: "stale-current",
			classifiedAt: "2026-07-31T08:00:00.000Z",
		});
		const zombie = await startZombieClaim([
			"row-claim",
			fixture.dbPath,
			"row-zombie",
			HASH_A,
			"verdict",
			"row-zombie-original",
			"2026-07-31T08:00:00.000Z",
		]);
		expect(readProcessState(zombie.pid)).toBe("Z");
		expect(readRowClaim("row-zombie")).toMatchObject({
			holder_pid: zombie.pid,
			holder_process_start: readProcessStartMarker(zombie.pid),
		});

		const recovered = runWorker([
			"row-recover-complete",
			fixture.dbPath,
			"row-zombie",
			HASH_A,
			"verdict",
			"row-zombie-original",
			"row-zombie-recovered",
			"2026-07-31T08:01:00.000Z",
		]);
		expect(recovered.status, recovered.stderr).toBe(0);
		expect(JSON.parse(recovered.stdout)).toEqual({
			recovered: { recovered: true },
			completed: { completed: true },
		});
		expect(readRowClaim("row-zombie")).toMatchObject({
			owner: "verdict",
			claim_ts: null,
			state: "completed",
			claim_token: "row-zombie-recovered",
		});

		const replay = runWorker([
			"row-recover",
			fixture.dbPath,
			"row-zombie",
			HASH_A,
			"verdict",
			"row-zombie-original",
			"row-zombie-replay",
			"2026-07-31T08:02:00.000Z",
		]);
		expect(replay.status, replay.stderr).toBe(0);
		expect(JSON.parse(replay.stdout)).toEqual({
			recovered: { recovered: false, reason: "claim_changed" },
		});
	});

	it("recovers a foreign boot row claim while its recorded process is alive", async () => {
		const repository = createRemRepository(fixture.runtime.db);
		insertMemory("row-foreign-boot", HASH_B);
		repository.recordClassification({
			rowId: "row-foreign-boot",
			contentHash: HASH_B,
			state: "stale-current",
			classifiedAt: "2026-07-31T08:00:00.000Z",
		});
		const held = await startHoldingWorker([
			"row-claim-hold",
			fixture.dbPath,
			"row-foreign-boot",
			HASH_B,
			"verdict",
			"row-foreign-boot-original",
			"2026-07-31T08:00:00.000Z",
		]);
		expect(() => process.kill(requireChildPid(held.child), 0)).not.toThrow();
		const foreignBootId = `foreign-${readFileSync(bootIdPath, "utf8").trim()}`;
		fixture.runtime.raw
			.prepare("UPDATE nodix_rem_row_claims SET holder_boot_id = ? WHERE row_id = ?")
			.run(foreignBootId, "row-foreign-boot");

		const recovered = runWorker([
			"row-recover-complete",
			fixture.dbPath,
			"row-foreign-boot",
			HASH_B,
			"verdict",
			"row-foreign-boot-original",
			"row-foreign-boot-recovered",
			"2026-07-31T08:01:00.000Z",
		]);
		expect(recovered.status, recovered.stderr).toBe(0);
		expect(JSON.parse(recovered.stdout)).toEqual({
			recovered: { recovered: true },
			completed: { completed: true },
		});
		expect(() => process.kill(requireChildPid(held.child), 0)).not.toThrow();
		expect(readRowClaim("row-foreign-boot")).toMatchObject({
			owner: "verdict",
			state: "completed",
			claim_token: "row-foreign-boot-recovered",
		});
	});

	it("recovers a foreign boot pair claim while its recorded process is alive", async () => {
		const repository = createRemRepository(fixture.runtime.db);
		repository.createVerdictGeneration({
			generationId: "generation-foreign-boot",
			corpusSnapshotHash: HASH_A,
			pairingConfigHash: HASH_B,
			maxLlmCalls: 1,
			maxTokens: 100,
			pairs: [
				{
					pairId: "pair-foreign-boot",
					leftRowId: "left",
					rightRowId: "right",
					sortKey: "0",
				},
			],
		});
		const held = await startHoldingWorker([
			"pair-attempt-hold",
			fixture.dbPath,
			"generation-foreign-boot",
			"pair-foreign-boot",
			"pair-foreign-boot-original",
		]);
		expect(() => process.kill(requireChildPid(held.child), 0)).not.toThrow();
		const foreignBootId = `foreign-${readFileSync(bootIdPath, "utf8").trim()}`;
		fixture.runtime.raw
			.prepare(
				"UPDATE nodix_rem_pair_claims SET holder_boot_id = ? WHERE generation_id = ? AND pair_id = ?",
			)
			.run(foreignBootId, "generation-foreign-boot", "pair-foreign-boot");

		const recovered = runWorker([
			"pair-recover",
			fixture.dbPath,
			"generation-foreign-boot",
			"pair-foreign-boot",
			"pair-foreign-boot-original",
		]);
	expect(recovered.status, recovered.stderr).toBe(0);
	const recoveredBody = JSON.parse(recovered.stdout) as {
		directive: { next: string; claimToken: string };
	};
	expect(recoveredBody.directive).toMatchObject({ next: "call_llm" });
	expect(recoveredBody.directive.claimToken).toMatch(/^recovery-\d+$/u);
	expect(recoveredBody.directive.claimToken).not.toBe("pair-foreign-boot-original");
		expect(() => process.kill(requireChildPid(held.child), 0)).not.toThrow();
		const recoveredClaim = readPairClaim("generation-foreign-boot", "pair-foreign-boot");
		expect(recoveredClaim["invocation_id"]).toBe(recoveredBody.directive.claimToken);
		expect(recoveredClaim["budget_reserved"]).toBe(0);
		expect(recoveredClaim["llm_calls_used"]).toBe(1);
	});

	it("retires a killed stale-content claim before the new content is claimed once", async () => {
		const repository = createRemRepository(fixture.runtime.db);
		insertMemory("row-content-crash", HASH_A);
		repository.recordClassification({
			rowId: "row-content-crash",
			contentHash: HASH_A,
			state: "stale-current",
			classifiedAt: "2026-07-31T08:00:00.000Z",
		});
		const held = await startHoldingWorker([
			"row-claim-hold",
			fixture.dbPath,
			"row-content-crash",
			HASH_A,
			"verdict",
			"row-content-old-claim",
			"2026-07-31T08:00:00.000Z",
		]);
		fixture.runtime.raw
			.prepare("UPDATE nodix_memories SET text = ?, content_hash = ? WHERE id = ?")
			.run("Changed while the claimant was alive", HASH_B, "row-content-crash");
		await stopChild(held.child);

		const cleanup = runWorker([
			"row-recover",
			fixture.dbPath,
			"row-content-crash",
			HASH_A,
			"verdict",
			"row-content-old-claim",
			"row-content-cleanup",
			"2026-07-31T08:01:00.000Z",
		]);
		expect(cleanup.status, cleanup.stderr).toBe(0);
		expect(JSON.parse(cleanup.stdout)).toEqual({
			recovered: { recovered: false, reason: "content_changed_released" },
		});
		expect(readRowClaim("row-content-crash")).toMatchObject({
			owner: "none",
			claim_ts: null,
			state: null,
		});

		repository.recordClassification({
			rowId: "row-content-crash",
			contentHash: HASH_B,
			state: "stale-current",
			classifiedAt: "2026-07-31T08:02:00.000Z",
		});
		const first = runWorker([
			"row-claim",
			fixture.dbPath,
			"row-content-crash",
			HASH_B,
			"verdict",
			"row-content-new-claim",
			"2026-07-31T08:02:01.000Z",
		]);
		const second = runWorker([
			"row-claim",
			fixture.dbPath,
			"row-content-crash",
			HASH_B,
			"verdict",
			"row-content-duplicate-claim",
			"2026-07-31T08:02:02.000Z",
		]);
		expect(first.status, first.stderr).toBe(0);
		expect(second.status, second.stderr).toBe(0);
		expect(JSON.parse(first.stdout)).toEqual({ result: { claimed: true } });
		expect(JSON.parse(second.stdout)).toEqual({
			result: {
				claimed: false,
				reason: "already_claimed",
				claimToken: "row-content-new-claim",
			},
		});
	});

	it("refuses a live pair recovery and reuses its fenced attempt after process death", async () => {
		const repository = createRemRepository(fixture.runtime.db);
		repository.createVerdictGeneration({
			generationId: "generation-live-attempt",
			corpusSnapshotHash: HASH_A,
			pairingConfigHash: HASH_B,
			maxLlmCalls: 1,
			maxTokens: 100,
			pairs: [{ pairId: "pair-live-attempt", leftRowId: "left", rightRowId: "right", sortKey: "0" }],
		});
		const held = await startHoldingWorker([
			"pair-attempt-hold",
			fixture.dbPath,
			"generation-live-attempt",
			"pair-live-attempt",
			"pair-attempt-original",
		]);
		expect(() => process.kill(requireChildPid(held.child), 0)).not.toThrow();
		const elapsedReclaimer = runWorker([
			"pair-claim",
			fixture.dbPath,
			"generation-live-attempt",
			"pair-attempt-elapsed-reclaimer",
			"2026-07-31T08:05:00.000Z",
		]);
		expect(elapsedReclaimer.status, elapsedReclaimer.stderr).toBe(0);
		expect(JSON.parse(elapsedReclaimer.stdout)).toEqual({ claim: null });
		const beforeRecovery = readPairClaimBytes(
			"generation-live-attempt",
			"pair-live-attempt",
		);

		const liveRecovery = runWorker([
			"pair-recover",
			fixture.dbPath,
			"generation-live-attempt",
			"pair-live-attempt",
			"pair-attempt-original",
		]);
		expect(liveRecovery.status, liveRecovery.stderr).toBe(0);
		expect(JSON.parse(liveRecovery.stdout)).toEqual({
			directive: { next: "refused", reason: "holder_alive" },
		});
		expect(readPairClaimBytes("generation-live-attempt", "pair-live-attempt")).toBe(
			beforeRecovery,
		);

		await stopChild(held.child);
		const resumed = runWorker([
			"pair-recover",
			fixture.dbPath,
			"generation-live-attempt",
			"pair-live-attempt",
			"pair-attempt-original",
		]);
	expect(resumed.status, resumed.stderr).toBe(0);
	const resumedBody = JSON.parse(resumed.stdout) as {
		directive: { next: string; claimToken: string };
	};
	expect(resumedBody.directive).toMatchObject({ next: "call_llm" });
	expect(resumedBody.directive.claimToken).toMatch(/^recovery-\d+$/u);
	expect(resumedBody.directive.claimToken).not.toBe("pair-attempt-original");
		const resumedClaim = readPairClaim("generation-live-attempt", "pair-live-attempt");
		expect(resumedClaim["invocation_id"]).toBe(resumedBody.directive.claimToken);
		expect(resumedClaim["budget_reserved"]).toBe(0);
		expect(resumedClaim["llm_calls_used"]).toBe(1);
	});

	it("distinguishes process reuse and releases a changed-content claim", () => {
		const repository = createRemRepository(fixture.runtime.db);
		insertMemory("row-reused-pid", HASH_C);
		repository.recordClassification({
			rowId: "row-reused-pid",
			contentHash: HASH_C,
			state: "stale-current",
			classifiedAt: "2026-07-31T08:00:00.000Z",
		});
		expect(
			repository.claimRow({
				rowId: "row-reused-pid",
				contentHash: HASH_C,
				owner: "verdict",
				claimToken: "row-reused-pid-original",
				claimTs: "2026-07-31T08:00:00.000Z",
				holderPid: process.pid,
			}),
		).toEqual({ claimed: true });
		fixture.runtime.raw
			.prepare("UPDATE nodix_rem_row_claims SET holder_process_start = 'reused-pid-marker' WHERE row_id = ?")
			.run("row-reused-pid");
		expect(
			repository.recoverRowClaim({
				rowId: "row-reused-pid",
				contentHash: HASH_C,
				owner: "verdict",
				expectedClaimToken: "row-reused-pid-original",
				claimToken: "row-reused-pid-recovered",
				claimTs: "2026-07-31T08:01:00.000Z",
				holderPid: process.pid,
			}),
		).toEqual({ recovered: true });

		insertMemory("row-content-changed", HASH_D);
		repository.recordClassification({
			rowId: "row-content-changed",
			contentHash: HASH_D,
			state: "stale-current",
			classifiedAt: "2026-07-31T08:00:00.000Z",
		});
		expect(
			repository.claimRow({
				rowId: "row-content-changed",
				contentHash: HASH_D,
				owner: "verdict",
				claimToken: "row-content-original",
				claimTs: "2026-07-31T08:00:00.000Z",
				holderPid: process.pid,
			}),
		).toEqual({ claimed: true });
		fixture.runtime.raw
			.prepare("UPDATE nodix_memories SET text = ?, content_hash = ? WHERE id = ?")
			.run("Changed after claim", HASH_A, "row-content-changed");
		expect(
			repository.recoverRowClaim({
				rowId: "row-content-changed",
				contentHash: HASH_D,
				owner: "verdict",
				expectedClaimToken: "row-content-original",
				claimToken: "row-content-recovered",
				claimTs: "2026-07-31T08:01:00.000Z",
				holderPid: process.pid,
			}),
		).toEqual({ recovered: false, reason: "content_changed_released" });

		repository.createVerdictGeneration({
			generationId: "generation-reused-pid",
			corpusSnapshotHash: HASH_A,
			pairingConfigHash: HASH_B,
			maxLlmCalls: 1,
			maxTokens: 100,
			pairs: [{ pairId: "pair-reused-pid", leftRowId: "left", rightRowId: "right", sortKey: "0" }],
		});
		expect(
			repository.claimNextPair({
				generationId: "generation-reused-pid",
				invocationId: "pair-reused-pid-original",
				claimedAt: "2026-07-31T08:00:00.000Z",
				holderPid: process.pid,
			}),
		).toBeDefined();
		fixture.runtime.raw
			.prepare(
				"UPDATE nodix_rem_pair_claims SET holder_process_start = 'reused-pid-marker' WHERE generation_id = ? AND pair_id = ?",
			)
			.run("generation-reused-pid", "pair-reused-pid");
		expect(
			repository.resumeVerdictPair({
				generationId: "generation-reused-pid",
				pairId: "pair-reused-pid",
				expectedInvocationId: "pair-reused-pid-original",
				invocationId: "pair-reused-pid-recovered",
				resumedAt: "2026-07-31T08:01:00.000Z",
				holderPid: process.pid,
			}),
		).toEqual({ next: "call_llm", claimToken: "pair-reused-pid-recovered" });
	});

	it("completes a claim against the content hash returned by its own mutation", () => {
		const repository = createRemRepository(fixture.runtime.db);
		insertMemory("row-mutated-before-completion", HASH_A);
		repository.recordClassification({
			rowId: "row-mutated-before-completion",
			contentHash: HASH_A,
			state: "transition",
			classifiedAt: "2026-07-31T08:00:00.000Z",
		});
		expect(
			repository.claimRow({
				rowId: "row-mutated-before-completion",
				contentHash: HASH_A,
				owner: "restate",
				claimToken: "claim-mutated-before-completion",
				claimTs: "2026-07-31T08:00:00.000Z",
				holderPid: process.pid,
			}),
		).toEqual({ claimed: true });
		fixture.runtime.raw
			.prepare("UPDATE nodix_memories SET content_hash = ? WHERE id = ?")
			.run(HASH_B, "row-mutated-before-completion");

		expect(
			repository.completeRowClaim({
				jobId: "test-job",
				jobType: "rem-update",
				rowId: "row-mutated-before-completion",
				contentHash: HASH_A,
				currentContentHash: HASH_C,
				owner: "restate",
				claimToken: "claim-mutated-before-completion",
				completedAt: "2026-07-31T08:01:00.000Z",
			}),
		).toEqual({ completed: false, reason: "content_changed" });
		expect(
			repository.completeRowClaim({
				jobId: "test-job",
				jobType: "rem-update",
				rowId: "row-mutated-before-completion",
				contentHash: HASH_A,
				currentContentHash: HASH_B,
				owner: "restate",
				claimToken: "claim-mutated-before-completion",
				completedAt: "2026-07-31T08:01:00.000Z",
			}),
		).toEqual({ completed: true });
	});

	it("rolls back both row-claim records when completion or release aborts", () => {
		const repository = createRemRepository(fixture.runtime.db);
		for (const [rowId, contentHash] of [
			["row-complete-abort", HASH_A],
			["row-release-abort", HASH_B],
		] as const) {
			insertMemory(rowId, contentHash);
			repository.recordClassification({
				rowId,
				contentHash,
				state: "stale-current",
				classifiedAt: "2026-07-31T08:00:00.000Z",
			});
			expect(
				repository.claimRow({
					rowId,
					contentHash,
					owner: "verdict",
					claimToken: `claim-${rowId}`,
					claimTs: "2026-07-31T08:00:00.000Z",
					holderPid: process.pid,
				}),
			).toEqual({ claimed: true });
		}

		fixture.runtime.raw.exec(`
			CREATE TRIGGER abort_row_claim_completion
			BEFORE UPDATE OF claim_ts ON nodix_rem_relation_ledger
			WHEN OLD.row_id = 'row-complete-abort' AND NEW.claim_ts IS NULL
			BEGIN SELECT RAISE(ABORT, 'completion ledger abort'); END;
			CREATE TRIGGER abort_row_claim_release
			BEFORE UPDATE OF owner ON nodix_rem_relation_ledger
			WHEN OLD.row_id = 'row-release-abort' AND NEW.owner = 'none'
			BEGIN SELECT RAISE(ABORT, 'release ledger abort'); END;
		`);
		const completeBefore = readRowClaimBytes("row-complete-abort");
		expect(() =>
				repository.completeRowClaim({
					jobId: "test-job",
					jobType: "rem-update",
					rowId: "row-complete-abort",
					contentHash: HASH_A,
					currentContentHash: HASH_A,
					owner: "verdict",
				claimToken: "claim-row-complete-abort",
				completedAt: "2026-07-31T08:01:00.000Z",
			}),
		).toThrow(/completion ledger abort/i);
		expect(readRowClaimBytes("row-complete-abort")).toBe(completeBefore);

		const releaseBefore = readRowClaimBytes("row-release-abort");
		expect(() =>
			repository.releaseRowClaim({
				rowId: "row-release-abort",
				contentHash: HASH_B,
				owner: "verdict",
				claimToken: "claim-row-release-abort",
			}),
		).toThrow(/release ledger abort/i);
		expect(readRowClaimBytes("row-release-abort")).toBe(releaseBefore);
	});

	it("re-presents refusals first and exhausts them after three separate process attempts", () => {
		const repository = createRemRepository(fixture.runtime.db);
		const pairs = [
			{ pairId: "retry", leftRowId: "left-retry", rightRowId: "right-retry", sortKey: "0" },
			{ pairId: "fresh", leftRowId: "left-fresh", rightRowId: "right-fresh", sortKey: "9" },
		];
		repository.createVerdictGeneration({
			generationId: "retry-generation-1",
			corpusSnapshotHash: HASH_A,
			pairingConfigHash: HASH_B,
			maxLlmCalls: 1,
			maxTokens: 10,
			pairs,
		});
		const first = runWorker([
			"pair-refuse-next",
			fixture.dbPath,
			"retry-generation-1",
			"content_changed",
		]);
		expect(first.status, first.stderr).toBe(0);
		expect(JSON.parse(first.stdout)).toEqual({
			pairId: "retry",
			refused: { state: "refused", attemptCount: 1 },
		});

		repository.createVerdictGeneration({
			generationId: "retry-generation-2",
			corpusSnapshotHash: HASH_A,
			pairingConfigHash: HASH_B,
			maxLlmCalls: 1,
			maxTokens: 10,
			pairs,
			inheritedRefusalsFromGenerationId: "retry-generation-1",
		});
		const second = runWorker([
			"pair-refuse-next",
			fixture.dbPath,
			"retry-generation-2",
			"content_changed",
		]);
		expect(second.status, second.stderr).toBe(0);
		expect(JSON.parse(second.stdout)).toEqual({
			pairId: "retry",
			refused: { state: "refused", attemptCount: 2 },
		});

		repository.createVerdictGeneration({
			generationId: "retry-generation-3",
			corpusSnapshotHash: HASH_A,
			pairingConfigHash: HASH_B,
			maxLlmCalls: 1,
			maxTokens: 10,
			pairs,
			inheritedRefusalsFromGenerationId: "retry-generation-2",
		});
		const third = runWorker([
			"pair-refuse-next",
			fixture.dbPath,
			"retry-generation-3",
			"content_changed",
		]);
		expect(third.status, third.stderr).toBe(0);
		expect(JSON.parse(third.stdout)).toEqual({
			pairId: "retry",
			refused: { state: "exhausted", attemptCount: 3 },
		});
		expect(
			fixture.runtime.raw
				.prepare("SELECT claim_state, progress_state, attempt_count, refusal_reason FROM nodix_rem_scan_pairs WHERE generation_id = ? AND pair_id = ?")
				.get("retry-generation-3", "retry"),
		).toEqual({
			claim_state: "done",
			progress_state: "exhausted",
			attempt_count: 3,
			refusal_reason: "content_changed",
		});
	});

	it("renews the LLM budget for each separate invocation", () => {
		const repository = createRemRepository(fixture.runtime.db);
		repository.createVerdictGeneration({
			generationId: "renewal-generation",
			corpusSnapshotHash: HASH_A,
			pairingConfigHash: HASH_B,
			maxLlmCalls: 1,
			maxTokens: 1,
			pairs: ["0", "1", "2"].map((sortKey) => ({
				pairId: `budget-${sortKey}`,
				leftRowId: `left-${sortKey}`,
				rightRowId: `right-${sortKey}`,
				sortKey,
			})),
		});
		const visited = [0, 1, 2].map(() => {
			const result = runWorker(["pair-reserve-complete-next", fixture.dbPath, "renewal-generation"]);
			expect(result.status, result.stderr).toBe(0);
			return JSON.parse(result.stdout) as { pairId: string; invocation: { llmCallsUsed: number } };
		});
		expect(visited.map((result) => result.pairId)).toEqual(["budget-0", "budget-1", "budget-2"]);
		expect(visited.map((result) => result.invocation.llmCallsUsed)).toEqual([1, 1, 1]);
		expect(repository.readGeneration("renewal-generation")).toMatchObject({
			llmCallsUsed: 3,
			tokensUsed: 3,
		});
	});
});

function runWorker(args: string[]): {
	status: number | null;
	stdout: string;
	stderr: string;
} {
	const result = spawnSync(tsxBinary, [workerPath, ...args], {
		cwd: repoRoot,
		encoding: "utf8",
		env: process.env,
		timeout: 10_000,
	});
	if (result.error) throw result.error;
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function startHoldingWorker(args: string[]): Promise<{
	child: ChildProcessWithoutNullStreams;
	result: unknown;
}> {
	const child = spawn(tsxBinary, [workerPath, ...args], {
		cwd: repoRoot,
		detached: true,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	holdingChildren.push(child);
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const result = await new Promise<unknown>((resolvePromise, reject) => {
		const timeout = setTimeout(() => reject(new Error(`holder did not become ready: ${stderr}`)), 10_000);
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			const newline = stdout.indexOf("\n");
			if (newline === -1) return;
			clearTimeout(timeout);
			resolvePromise(JSON.parse(stdout.slice(0, newline)) as unknown);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`holder exited before ready: code=${code} signal=${signal} ${stderr}`));
		});
	});
	return { child, result };
}

async function startZombieClaim(args: string[]): Promise<{
	parent: ChildProcessWithoutNullStreams;
	pid: number;
}> {
	const parentScript = [
		"import json, os, signal, sys",
		"pid = os.fork()",
		"if pid == 0:",
		"\tos.execv(sys.argv[1], sys.argv[1:])",
		"print(json.dumps({'zombiePid': pid}), flush=True)",
		"signal.pause()",
	].join("\n");
	const parent = spawn(
		pythonBinary,
		["-u", "-c", parentScript, process.execPath, "--import", "tsx", workerPath, ...args],
		{
			cwd: repoRoot,
			detached: true,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	holdingChildren.push(parent);
	parent.stdout.setEncoding("utf8");
	parent.stderr.setEncoding("utf8");
	let stdout = "";
	let stderr = "";
	let zombiePid: number | undefined;
	let claimObserved = false;
	parent.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	await new Promise<void>((resolvePromise, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`zombie claimant did not become ready: ${stderr}`)),
			10_000,
		);
		parent.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			for (;;) {
				const newline = stdout.indexOf("\n");
				if (newline === -1) break;
				const line = stdout.slice(0, newline);
				stdout = stdout.slice(newline + 1);
				const event: unknown = JSON.parse(line);
				if (typeof event !== "object" || event === null) continue;
				if ("zombiePid" in event && typeof event.zombiePid === "number") {
					zombiePid = event.zombiePid;
				}
				if ("result" in event) {
					expect(event.result).toEqual({ claimed: true });
					claimObserved = true;
				}
			}
			if (zombiePid !== undefined && claimObserved) {
				clearTimeout(timeout);
				resolvePromise();
			}
		});
		parent.once("exit", (code, signal) => {
			clearTimeout(timeout);
			reject(new Error(`zombie parent exited early: code=${code} signal=${signal} ${stderr}`));
		});
	});
	if (zombiePid === undefined) throw new Error("zombie parent did not report its child pid");
	await waitForProcessState(zombiePid, "Z");
	return { parent, pid: zombiePid };
}

async function waitForProcessState(pid: number, expectedState: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (readProcessState(pid) === expectedState) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
	throw new Error(`process ${pid} did not reach state ${expectedState}`);
}

function readProcessState(pid: number): string | undefined {
	return readProcessStatFields(pid)?.[0];
}

function readProcessStartMarker(pid: number): string | undefined {
	return readProcessStatFields(pid)?.[19];
}

function readProcessStatFields(pid: number): string[] | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return undefined;
		}
		throw error;
	}
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	const index = holdingChildren.indexOf(child);
	if (index !== -1) holdingChildren.splice(index, 1);
	if (child.exitCode !== null || child.signalCode !== null) return;
	process.kill(-requireChildPid(child), "SIGKILL");
	await Promise.race([
		once(child, "exit"),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("holder did not exit after SIGKILL")), 5_000),
		),
	]);
}

function requireChildPid(child: ChildProcessWithoutNullStreams): number {
	if (child.pid === undefined) throw new Error("child process did not receive a pid");
	return child.pid;
}

function insertMemory(rowId: string, contentHash: string): void {
	fixture.runtime.raw
		.prepare(
			"INSERT INTO nodix_memories(id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id, lane) VALUES (?, ?, 'episodic', 'persona:claim-review', 0.7, 1, 'UTC', '{}', ?, ?, 'active')",
		)
		.run(rowId, `Claim lifecycle ${rowId}`, contentHash, `fact-${rowId}`);
}

function readRowClaimBytes(rowId: string): string {
	return JSON.stringify(readRowClaim(rowId));
}

function readRowClaim(rowId: string): Record<string, unknown> {
	const runtime = openSqliteDatabase(fixture.dbPath, { fileMustExist: true });
	try {
		return runtime.raw
			.prepare(
				`SELECT ledger.owner, ledger.claim_ts, lifecycle.state, lifecycle.claim_token,
					lifecycle.holder_pid, lifecycle.holder_process_start, lifecycle.completed_at
				FROM nodix_rem_relation_ledger AS ledger
				LEFT JOIN nodix_rem_row_claims AS lifecycle ON lifecycle.row_id = ledger.row_id
				WHERE ledger.row_id = ?`,
			)
			.get(rowId) as Record<string, unknown>;
	} finally {
		runtime.db.close();
	}
}

function readPairClaimBytes(generationId: string, pairId: string): string {
	return JSON.stringify(readPairClaim(generationId, pairId));
}

function readPairClaim(generationId: string, pairId: string): Record<string, unknown> {
	const runtime = openSqliteDatabase(fixture.dbPath, { fileMustExist: true });
	try {
		return runtime.raw
			.prepare(
				`SELECT pair.invocation_id, pair.budget_reserved, generation.llm_calls_used,
					holder.holder_pid, holder.holder_process_start
				FROM nodix_rem_scan_pairs AS pair
				JOIN nodix_rem_scan_generations AS generation USING (generation_id)
				LEFT JOIN nodix_rem_pair_claims AS holder
					ON holder.generation_id = pair.generation_id AND holder.pair_id = pair.pair_id
				WHERE pair.generation_id = ? AND pair.pair_id = ?`,
			)
			.get(generationId, pairId) as Record<string, unknown>;
	} finally {
		runtime.db.close();
	}
}
