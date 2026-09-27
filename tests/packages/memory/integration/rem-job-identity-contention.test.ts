import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
/** @file rem-job-identity-contention.test.ts
 * @purpose Proves the F-B job-identity contract survives a contended close and the wave continues.
 * @boundary The real mutation executor and the real conflict port over a real encrypted SQLite file.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	installRemSchema,
	parseRemOperationalConfiguration,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import { createSnoStationMemRemPorts } from "../../../../packages/memory/src/store/rem-sqlite-adapter.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { seedProductionMemory } from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const JOB_ID = "rem-wave-fb-job-identity";
const JOB_TYPE = "rem-replace" as const;
const LOSER_TEXT = "The user prefers the shared workspace near the entrance.";
const SUCCESSOR_TEXT = "The successor row keeps the current workspace preference.";
const TIMESTAMP = "2026-08-13T08:01:00.000Z";
const CLOSE_REASON = "The settled REM evidence authorizes this bounded close.";

function hashOf(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function seedRow(fixture: TestDb, id: string, text: string, contentHash: string): void {
	fixture.runtime.raw
		.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash,
				fact_id, lane, raw_candidate_json
			) VALUES (?, ?, 'profile', ?, 0.8, ?, 'UTC', '{}', ?, ?, 'active', ?)`,
		)
		.run(
			id,
			text,
			"test-rem-fb-job-identity",
			Date.parse("2026-08-13T08:00:00.000Z"),
			contentHash,
			`fact-${id}`,
			JSON.stringify({ evidenceId: `evidence-${id}` }),
		);
}

/** One loser row plus the successor that carries its facts forward, with the close authorized. */
function seedPair(fixture: TestDb, suffix: string): { loserId: string; successorId: string } {
	const loserId = `clremfbloser${suffix}`;
	const successorId = `clremfbsuccessor${suffix}`;
	seedRow(fixture, loserId, LOSER_TEXT, hashOf(`${LOSER_TEXT}:${suffix}`));
	seedRow(fixture, successorId, SUCCESSOR_TEXT, hashOf(`${SUCCESSOR_TEXT}:${suffix}`));
	authorizeClose(fixture, loserId);
	return { loserId, successorId };
}

/**
 * The settled verdict that authorizes closing this loser. Written here rather than through the
 * shared verdict fixture, which seeds an extra source row at a fixed content hash and so cannot be
 * called twice against one store — and this case needs two independent pairs in one store.
 */
function authorizeClose(fixture: TestDb, loserId: string): void {
	const atoms = JSON.stringify([LOSER_TEXT]);
	fixture.runtime.raw
		.prepare("UPDATE nodix_memories SET raw_candidate_json = ? WHERE id = ?")
		.run(JSON.stringify({ retiredFactAtoms: [LOSER_TEXT] }), loserId);
	fixture.runtime.raw
		.prepare(
			`INSERT INTO nodix_rem_write_verdicts(
				evidence_id, winner_row_id, loser_row_id, target_row_id,
				retired_fact_atoms_json, recorded_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(`evidence-${loserId}`, loserId, loserId, loserId, atoms, "2026-08-13T08:00:15.000Z");
}

describe("F-B job identity under contention", () => {
	// The F-B contract: `jobId`/`jobType` are required on the write input and filled by the executor,
	// so a caller cannot supply them and no ledger row can be written without them. The place that
	// matters is the batch loop's refusal branch, which routes through `refusePair` into `nodix_rem_journal`
	// (rem-batch-executor.ts:2036) — the rows for pairs that never closed, which nothing downstream
	// reads and where a missing identity therefore hides.
	//
	// The wave below needs no injected contention: the loop produces its own. Four rows in one
	// address build six pairs; the coverage stage is scripted to refuse whichever pair carries
	// "storage option 0", and once an earlier pair closes a row, a later pair that shares it is
	// refused `row_closed_by_prior_pair` by the loop itself (rem-batch-executor.ts:1375-1384).
	// Measured twice, byte-identical both times, down to the pair identifiers.
	it("carries job identity onto every refusal and keeps closing pairs after one", { timeout: 60_000 }, async () => {
		const database = createTestDb();
		const stateRoot = mkdtempSync(join(tmpdir(), "rem-fb-job-identity-"));
		const priorEnvironment = {
			SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
			SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
		};
		try {
			process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = database.dbPath;
			process.env["SNO_PROFILE_DIR"] = stateRoot;
			writeSettingsFixture(stateRoot, { mode: "local-first", store: { path: database.dbPath, encryptionKey: database.encryptionKey },
				embedding: { cacheDir: "" } });
			const scope = "persona:fb-job-identity";
			for (let index = 0; index < 4; index += 1) {
				seedProductionMemory(database.runtime.raw, {
					id: `fb-row-${index}`,
					scope,
					text: `The researcher has been studying storage option ${index}.`,
					metadata: { section_name: "preferences.shared-fb" },
					timestamp: `2026-08-0${index + 1}T08:00:00.000Z`,
				});
			}

			const result = await runRemBatchJob({
				jobId: JOB_ID,
				jobType: JOB_TYPE,
				scope,
				configuration: parseRemOperationalConfiguration({
					...createRemOwnerDecidedOperationalConfiguration(),
					budgets: { maxPairs: 10 },
					retrieval: { neighborLimit: 10, similarityThreshold: 1 },
				}),
				modelStageResponses: createRemModelStageResponsePort({
					respond: async ({ stage, prompt }) => {
						if (stage === "rem-replace-pair") return "replacement";
						if (stage === "rem-replace-clauses") {
							return JSON.stringify({ verdict: "replacement", retiring_clause_indices: [0] });
						}
						// One seeded row is refused at coverage; the rest are allowed. Keying on the row's
						// own text rather than on a call counter keeps the script independent of the order
						// the loop happens to visit pairs in.
						const refuseThisPair = prompt.includes("storage option 0");
						return JSON.stringify({
							atoms: [
								{
									clause_index: 0,
									class: "retired-fact",
									status: refuseThisPair ? "uncovered" : "covered",
								},
							],
						});
					},
				}),
			});

			const pairs = database.runtime.raw
				.prepare(
					`SELECT pair_id, claim_state, progress_state, refusal_reason FROM nodix_rem_scan_pairs
					ORDER BY sort_key`,
				)
				.all() as Array<{
				pair_id: string;
				claim_state: string;
				progress_state: string;
				refusal_reason: string | null;
			}>;

			// The loop refused a pair for its own contention reason, and a LATER pair still closed. This
			// is the assertion the previous version of this case could not make: it drove the second
			// pair itself, so a loop that `break`s on refusal instead of continuing would have stayed
			// green. Here the loop owns the iteration, and nothing after the refusal exists unless it
			// kept going.
			const contendedIndex = pairs.findIndex(
				(pair) => pair.refusal_reason === "row_closed_by_prior_pair",
			);
			expect(contendedIndex, "the loop's own contention refusal must occur").toBeGreaterThanOrEqual(0);
			expect(
				pairs.slice(contendedIndex + 1).filter((pair) => pair.progress_state === "closed"),
				"a pair must close after the contention refusal, or the wave died on it",
			).not.toHaveLength(0);
			expect(result.actionsApplied).toBe(2);

			// Per-pair terminal-state oracle. Every pair reached a terminal state, none is still
			// claimed, and no pair identifier appears twice.
			expect(pairs.length).toBeGreaterThan(1);
			expect(pairs.every((pair) => pair.claim_state === "done")).toBe(true);
			expect(pairs.every((pair) => pair.progress_state !== "pending")).toBe(true);
			expect(new Set(pairs.map((pair) => pair.pair_id)).size).toBe(pairs.length);

			// The F-B contract on the sink that carries it: every refusal the loop journalled carries
			// the wave's identity, none is missing one, and nothing landed under another identity.
			//
			// Stated precisely, because the assertion is easy to over-read: `jobId` is genuinely
			// threaded from the wave through `refusePairOutcome`, so its check bites. `jobType` is a
			// hardcoded "rem-replace" literal inside that helper (rem-batch-executor.ts:2050), correct
			// today because only the replace path calls it — so this case pins the value, not the
			// wiring. Reusing that helper from the update path would mint wrong audit rows without
			// failing here.
			const journal = database.runtime.raw
				.prepare("SELECT job_id, job_type, outcome, reason, pair_id FROM nodix_rem_journal ORDER BY sequence")
				.all() as Array<{
				job_id: string;
				job_type: string;
				outcome: string;
				reason: string | null;
				pair_id: string | null;
			}>;
			expect(journal.length).toBeGreaterThan(0);
			expect(journal.every((row) => row.job_id === JOB_ID)).toBe(true);
			expect(journal.every((row) => row.job_type === JOB_TYPE)).toBe(true);
			expect(journal.every((row) => row.pair_id !== null)).toBe(true);
			expect(
				journal.filter((row) => row.reason === "row_closed_by_prior_pair"),
				"the contention refusal must reach the journal, not only the pair row",
			).toHaveLength(1);
			// One journal row per refused pair: the refusal is journalled in the same transaction as
			// the pair state, so a second row would mean a pair was refused twice.
			const refusedPairIds = pairs
				.filter((pair) => pair.progress_state === "refused")
				.map((pair) => pair.pair_id)
				.sort();
			expect(
				journal
					.filter((row) => row.outcome === "refused")
					.map((row) => row.pair_id)
					.sort(),
			).toEqual(refusedPairIds);

			// The closes the wave did apply carry the same identity.
			const attempts = database.runtime.raw
				.prepare("SELECT job_id, outcome FROM nodix_rem_write_attempts")
				.all() as Array<{ job_id: string; outcome: string }>;
			expect(attempts).toHaveLength(2);
			expect(attempts.every((attempt) => attempt.job_id === JOB_ID)).toBe(true);
			expect(attempts.every((attempt) => attempt.outcome === "succeeded")).toBe(true);
		} finally {
			for (const [name, value] of [
				["SNO_STATION_MEM_REM_EXPECTED_DB_PATH", priorEnvironment.SNO_STATION_MEM_REM_EXPECTED_DB_PATH],
				["SNO_PROFILE_DIR", priorEnvironment.SNO_PROFILE_DIR],
			] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			database.cleanup();
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	// The two contention verdicts the close itself raises. `softClose` reads the LOSER first against
	// `plannedContentHash` and the SUCCESSOR second against `plannedSuccessorContentHash`
	// (rem-sqlite-adapter.ts:803-815), so which row moved decides which reason comes back — and
	// getting that mapping backwards would misreport every contended close.
	//
	// Stated plainly: these run at the conflict port, so they prove the mapping and NOT that a wave
	// continues afterward. That half is the case above. Neither reason is reachable deterministically
	// through the executor — the loser is caught by the earlier hash gate, and the successor's hash is
	// read microseconds before it is compared, leaving no seam a test can occupy without a hook.
	it.each([
		{
			name: "the loser moved: content_changed",
			moved: "loser" as const,
			reason: "content_changed",
		},
		{
			name: "the successor moved: target_changed",
			moved: "successor" as const,
			reason: "target_changed",
		},
	])("$name", async ({ moved, reason }) => {
		const fixture = createTestDb();
		installRemSchema(fixture.runtime.db);
		try {
			const pair = seedPair(fixture, moved);
			const live = (id: string): string =>
				(
					fixture.runtime.raw
						.prepare("SELECT content_hash FROM nodix_memories WHERE id = ?")
						.get(id) as { content_hash: string }
				).content_hash;
			const ports = createSnoStationMemRemPorts({
				database: fixture.runtime.db,
			});

			expect(
				await ports.conflict.softClose({
					rowId: pair.loserId,
					successorId: pair.successorId,
					// Exactly one planned hash is stale, so the case cannot pass by refusing for the
					// other row's reason.
					plannedContentHash: moved === "loser" ? "d".repeat(64) : live(pair.loserId),
					plannedSuccessorContentHash:
						moved === "successor" ? "d".repeat(64) : live(pair.successorId),
					reason: CLOSE_REASON,
					timestamp: TIMESTAMP,
				}),
			).toEqual({ applied: false, reason });
		} finally {
			fixture.cleanup();
		}
	});
});
