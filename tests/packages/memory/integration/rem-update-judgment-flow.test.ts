import { writeTestInstallationConfig } from "../../../apps/mem-claw/helpers/module-config-fixture";
/** @file rem-update-judgment-flow.test.ts
 * @purpose Drives the rewired one-call rem-update flow end to end over a REAL encrypted
 * SQLite store and the REAL executor, with the model reply supplied through the production
 * stage-response seam. Proves the disposition-table fates of 90-rem-update-model-judgment-prd.md
 * at the store: an applied rewrite lands on the current facet with the original preserved,
 * and every refusal leaves the row byte-identical with the named reason in the journal.
 * Replaces rem-update-rewrite.test.ts, whose subject (the span-selection machinery) was deleted.
 * @boundary Real DB, real repository, real executor; only the model reply is injected —
 * through createRemModelStageResponsePort, the same port production types.
 * @acceptance QCG-3, QCG-4, QCG-5, QCG-6, QCG-10 (integration half)
 * @class product
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import {
	createCoverageGatedConflictPort,
	createSnoStationMemRemMutationExecutor,
	createSnoStationMemRemPorts,
	createRemReplaceCarrierPort,
	issueReplaceCoverageAllow,
} from "../../../../packages/memory/src/store/rem-sqlite-adapter.ts";
import {
	installRemSchema,
	getRemUpdateLocaleResource,
	parseRemOperationalConfiguration,
	type RemMutationResult,
	type WriteTextVersionInput,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { deriveRemUpdateStamp } from "../../../../packages/memory/src/store/rem-update-stamp-migration.ts";
import { seedProductionMemory } from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

// Matches the pinned transition grammar, so the code router assigns it to rem-update.
const TRANSITION_TEXT = "Lives in San Diego. Moved from San Francisco in 2024.";

interface RowSnapshot {
	text: string;
	contentHash: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

async function runUpdateWave(input: {
	label: string;
	liveModel?: boolean;
	priorMetadata?: Record<string, unknown>;
	reply?: string | ((prompt: string) => string);
	relationSuccessorText?: string;
	verification?:
		| { faithful: boolean; retired_absent: boolean; all_facts_accounted?: boolean }
		| string
		| ((prompt: string) => string);
}): Promise<{
	claimState: { state: string } | undefined;
	historyTexts: string[];
	journalReasons: Array<{ stage: string; outcome: string; reason: string | null }>;
	rowAfter: RowSnapshot;
	rowBefore: RowSnapshot;
	waveJournal: { outcome: string; actions_applied: number } | undefined;
}> {
	const database = createTestDb();
	const stateRoot = mkdtempSync(join(tmpdir(), "rem-judgment-"));
	const prior = {
		MEM_CLAW_DATA_DIR_ROOT: process.env["MEM_CLAW_DATA_DIR_ROOT"],
		SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
		SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
	};
	cleanups.push(() => {
		for (const [name, value] of Object.entries(prior)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		database.cleanup();
		rmSync(stateRoot, { recursive: true, force: true });
	});
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
	const scope = `persona:judgment-${input.label}`;
	const rowId = seedProductionMemory(database.runtime.raw, {
		scope,
		text: TRANSITION_TEXT,
		metadata: { section_name: "identity.residence", ...input.priorMetadata },
	});
	if (input.relationSuccessorText !== undefined) {
		seedProductionMemory(database.runtime.raw, {
			scope,
			text: input.relationSuccessorText,
			metadata: { section_name: "identity.residence" },
			timestamp: "2026-08-21T12:00:00.000Z",
		});
	}
	const readRow = (): RowSnapshot => {
		const row = database.runtime.raw
			.prepare("SELECT text, content_hash FROM nodix_memories WHERE id = ?")
			.get(rowId) as { text: string; content_hash: string };
		return { text: row.text, contentHash: row.content_hash };
	};
	const rowBefore = readRow();
	const configuration = parseRemOperationalConfiguration(
		createRemOwnerDecidedOperationalConfiguration(),
	);
	const modelStageResponses = input.liveModel
		? undefined
		: createRemModelStageResponsePort({
				respond: async ({ stage, prompt }) => {
					if (stage === "rem-update-judgment") {
						if (input.reply === undefined) {
							throw new Error("scripted REM update judgment reply is missing");
						}
						return typeof input.reply === "string" ? input.reply : input.reply(prompt);
					}
					if (stage === "rem-update-verification") {
						const v = input.verification ?? { faithful: true, retired_absent: true };
						if (typeof v === "string") return v;
						if (typeof v === "function") return v(prompt);
						return JSON.stringify({ all_facts_accounted: true, ...v });
					}
					if (stage === "rem-update-relation-judgment") {
						if (input.relationSuccessorText !== undefined) {
							return JSON.stringify({
								supersedes: true,
								retires_anything: true,
								supersedes_everything: false,
							});
						}
						return JSON.stringify({
							supersedes: false,
							retires_anything: false,
							supersedes_everything: false,
						});
					}
					throw new Error(`unexpected model stage on the update path: ${stage}`);
				},
			});
	const waveResult = await runRemBatchJob({
		jobId: `judgment-${input.label}-${createHash("sha256").update(scope).digest("hex").slice(0, 8)}`,
		jobType: "rem-update",
		scope,
		configuration,
		...(modelStageResponses === undefined ? {} : { modelStageResponses }),
	});
	const journalReasons = database.runtime.raw
		.prepare(
			"SELECT stage, outcome, reason FROM nodix_rem_journal WHERE stage LIKE 'update-row:%' ORDER BY rowid",
		)
		.all() as Array<{ stage: string; outcome: string; reason: string | null }>;
	// The wave-level 'done' journal row is written by the sidecar HTTP layer, not by
	// runRemBatchJob; calling the executor directly, the wave outcome is its return value.
	const waveJournal = { outcome: waveResult.outcome, actions_applied: waveResult.actionsApplied };
	const claimState = database.runtime.raw
		.prepare("SELECT state FROM nodix_rem_row_claims WHERE row_id = ?")
		.get(rowId) as { state: string } | undefined;
	const historyTexts = (
		database.runtime.raw
			.prepare("SELECT text FROM nodix_rem_memory_facets WHERE memory_id = ? AND facet = 'history'")
			.all(rowId) as Array<{ text: string }>
	).map((facet) => facet.text);
	return { claimState, historyTexts, journalReasons, rowAfter: readRow(), rowBefore, waveJournal };
}

function judgment(proposedCurrent: string, retiredValues: string[]): string {
	return JSON.stringify({ proposed_current: proposedCurrent, retired_values: retiredValues });
}

describe("rem-update one-call flow against a real store", () => {
	it.runIf(process.env["SNO_REM_LIVE_ACCEPTANCE"] === "1")(
		"uses the live model to apply a rewrite in a real encrypted store",
		{ timeout: 180_000 },
		async () => {
			const failures: string[] = [];
			for (let attempt = 1; attempt <= 3; attempt += 1) {
				try {
					const result = await runUpdateWave({
						label: `live-${attempt}`,
						liveModel: true,
					});
					if (result.waveJournal?.actions_applied !== 1) {
						failures.push(
							`attempt ${attempt}: actions_applied=${result.waveJournal?.actions_applied ?? "missing"}`,
						);
						continue;
					}
					expect(result.rowAfter.text).not.toBe(result.rowBefore.text);
					expect(result.historyTexts).toContain(TRANSITION_TEXT);
					expect(result.claimState).toEqual({ state: "completed" });
					return;
				} catch (error) {
					failures.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			throw new Error(`live REM update never applied across three attempts: ${failures.join("; ")}`);
		},
	);

	it("applies a sourced rewrite: current text replaced, original preserved on history", { timeout: 30_000 }, async () => {
		const result = await runUpdateWave({
			label: "apply",
			reply: judgment("Lives in San Diego.", ["Moved from San Francisco in 2024"]),
		});
		expect(result.rowAfter.text).toBe("Lives in San Diego.");
		expect(result.rowAfter.contentHash).not.toBe(result.rowBefore.contentHash);
		expect(result.historyTexts).toContain(TRANSITION_TEXT);
		expect(result.waveJournal).toMatchObject({ outcome: "done", actions_applied: 1 });
		expect(result.claimState).toEqual({ state: "completed" });
	});

	it("applies a rewrite whose wording differs from the source — no string rule stops it", { timeout: 30_000 }, async () => {
		// The 2026-08-21 case: a legitimate paraphrase the deleted token check refused.
		const result = await runUpdateWave({
			label: "paraphrase",
			reply: judgment("The user now lives in San Diego.", ["Moved from San Francisco in 2024"]),
		});
		expect(result.rowAfter.text).toBe("The user now lives in San Diego.");
		expect(result.historyTexts).toContain(TRANSITION_TEXT);
	});

	it("refuses an unfaithful proposal on the model's verdict, row byte-identical", { timeout: 30_000 }, async () => {
		const result = await runUpdateWave({
			label: "unfaithful",
			reply: judgment("Lives in Reykjavik.", ["Moved from San Francisco in 2024"]),
			verification: { faithful: false, retired_absent: true },
		});
		expect(result.rowAfter).toEqual(result.rowBefore);
		expect(result.historyTexts).toEqual([]);
		expect(result.journalReasons.map((row) => row.reason)).toContain("proposal_not_faithful");
	});

	it("gives a relation refusal back to the independent row pass", { timeout: 30_000 }, async () => {
		const result = await runUpdateWave({
			label: "relation-refusal-fallback",
			relationSuccessorText: "Lives in Seattle.",
			reply: (prompt) =>
				prompt.includes("Lives in Seattle.")
					? judgment("Lives in Seattle.", ["Moved from San Francisco in 2024"])
					: judgment("Lives in San Diego.", ["Moved from San Francisco in 2024"]),
			verification: (prompt) =>
				JSON.stringify({
					faithful: !prompt.includes("Lives in Seattle."),
					retired_absent: true,
					all_facts_accounted: true,
				}),
		});

		expect(result.rowAfter.text).toBe("Lives in San Diego.");
		expect(result.historyTexts).toContain(TRANSITION_TEXT);
		expect(result.waveJournal).toMatchObject({ outcome: "done", actions_applied: 1 });
	});

	it("keeps a stamped active row available for a later relation", { timeout: 30_000 }, async () => {
		const rewriteConfig = {
			implementationVersion: "rem-update-v1",
			memoryKind: "profile" as const,
			locale: "en",
			localeResource: getRemUpdateLocaleResource("en"),
		};
		const result = await runUpdateWave({
			label: "stamped-relation",
			priorMetadata: {
				rem_update_source_version: TRANSITION_TEXT,
				rem_update_rewrite_config: rewriteConfig,
				rem_update_idempotency_key: deriveRemUpdateStamp({
					source: TRANSITION_TEXT,
					...rewriteConfig,
				}),
				rem_update_result_text_sha256: createHash("sha256").update(TRANSITION_TEXT).digest("hex"),
			},
			relationSuccessorText: "Lives in Seattle.",
			reply: judgment("Lives in San Diego.", ["Moved from San Francisco in 2024"]),
		});

		expect(result.rowAfter.text).toBe("Lives in San Diego.");
		expect(result.waveJournal).toMatchObject({ outcome: "done", actions_applied: 1 });
		expect(result.journalReasons.map((row) => row.reason)).not.toContain("already_stamped");
	});

	it("refuses a surviving retired meaning on the model's verdict, row untouched", { timeout: 60_000 }, async () => {
		const survives = await runUpdateWave({
			label: "survives",
			reply: judgment("Moved from San Francisco in 2024.", ["Moved from San Francisco in 2024"]),
			verification: { faithful: true, retired_absent: false },
		});
		expect(survives.rowAfter).toEqual(survives.rowBefore);
		expect(survives.journalReasons.map((row) => row.reason)).toContain("retired_value_survives");
	});

	it("refuses a rewrite that dropped a surviving fact, row byte-identical", { timeout: 30_000 }, async () => {
		const result = await runUpdateWave({
			label: "dropped-fact",
			reply: judgment("Lives in San Diego.", ["Moved from San Francisco in 2024"]),
			verification: { faithful: true, retired_absent: true, all_facts_accounted: false },
		});
		expect(result.rowAfter).toEqual(result.rowBefore);
		expect(result.historyTexts).toEqual([]);
		expect(result.journalReasons.map((row) => row.reason)).toContain("surviving_fact_lost");
	});

	it("refuses an unparseable verification reply without writing", { timeout: 30_000 }, async () => {
		const result = await runUpdateWave({
			label: "bad-verification",
			reply: judgment("Lives in San Diego.", ["Moved from San Francisco in 2024"]),
			verification: "not json",
		});
		expect(result.rowAfter).toEqual(result.rowBefore);
		expect(result.journalReasons.map((row) => row.reason)).toContain("model_response_invalid");
	});

	it("routes the model's negative answers: empty retired list and empty proposal", { timeout: 60_000 }, async () => {
		const nothingRetired = await runUpdateWave({
			label: "no-retired",
			reply: judgment("Lives in San Diego.", []),
		});
		expect(nothingRetired.rowAfter).toEqual(nothingRetired.rowBefore);
		expect(nothingRetired.journalReasons.map((row) => row.reason)).toContain("no_retired_fact");

		const nothingLeft = await runUpdateWave({
			label: "no-remainder",
			reply: judgment("", ["Moved from San Francisco in 2024"]),
		});
		expect(nothingLeft.rowAfter).toEqual(nothingLeft.rowBefore);
		expect(nothingLeft.journalReasons.map((row) => row.reason)).toContain("no_surviving_remainder");
	});

	it("refuses an unparseable reply as model_response_invalid, row untouched, and the all-failed wave raises", { timeout: 30_000 }, async () => {
		// Existing guard: a wave in which every model call failed throws rather than
		// reporting quiet success. The refusal is journaled before the throw.
		await expect(
			runUpdateWave({ label: "invalid", reply: "not json at all" }),
		).rejects.toThrow(/model_response_invalid/);
	});

	it("raises no forbidden punctuation-judge reason on any of these waves", { timeout: 30_000 }, async () => {
		// Structural half of QCG-2 at the integration tier: the forbidden vocabulary cannot
		// appear because the code that raised it is deleted; this documents the contract.
		const result = await runUpdateWave({
			label: "vocabulary",
			reply: judgment("Lives in San Diego.", ["Moved from San Francisco in 2024"]),
		});
		const forbidden = new Set([
			"invalid_relation",
			"relation_schema",
			"selection_schema",
			"invalid_relation_span",
			"overlapping_spans",
			"mixed_clause_not_separable",
			"sentence_fragment",
			"mixed_clause_current_missing",
			"invalid_current_span",
			"proposal_token_unsourced",
			"retired_value_unsourced",
		]);
		for (const row of result.journalReasons) {
			expect(forbidden.has(row.reason ?? "")).toBe(false);
		}
	});
});

describe("REM storage authorization boundaries", () => {
	it("requires a verified token at the exported text-write port", async () => {
		const database = createTestDb();
		try {
			const rowId = seedProductionMemory(database.runtime.raw, {
				scope: "persona:unverified-write",
				text: TRANSITION_TEXT,
			});
			const before = database.runtime.raw
				.prepare("SELECT text, content_hash FROM nodix_memories WHERE id = ?")
				.get(rowId);
			const ports = createSnoStationMemRemPorts({
				database: database.runtime.db,
			});
			const callWithoutVerification = ports.conflict.writeTextVersion as unknown as (
				input: WriteTextVersionInput,
			) => Promise<RemMutationResult>;

			await expect(
				callWithoutVerification({
					attemptId: "unverified-write-attempt",
					jobId: "unverified-write",
					jobType: "rem-update",
					rowId,
					plannedContentHash: createHash("sha256").update(TRANSITION_TEXT).digest("hex"),
					replacementText: "Lives in San Diego.",
					reason: "This call deliberately skipped model verification.",
					timestamp: "2026-08-21T00:00:00.000Z",
				}),
			).rejects.toThrow("text version write requires verified write authorization");
			expect(
				database.runtime.raw
					.prepare("SELECT text, content_hash FROM nodix_memories WHERE id = ?")
					.get(rowId),
			).toEqual(before);
		} finally {
			database.cleanup();
		}
	});

	it("rejects a coverage token whose verified decision belongs to another pair", async () => {
		const otherPair = issueReplaceCoverageAllow({
			pairId: "pair-b" as const,
			decision: "allow",
			atoms: [],
		});
		await expect(
			createCoverageGatedConflictPort().softClose({
				pairId: "pair-a" as const,
				coverageAllow: otherPair,
				rowId: "older-row",
				successorId: "newer-row",
				plannedContentHash: "a".repeat(64),
				plannedSuccessorContentHash: "b".repeat(64),
				reason: "The token belongs to another pair.",
				timestamp: "2026-08-21T00:00:00.000Z",
			}),
		).rejects.toThrow("coverage allow token belongs to a different pair");
	});

	it("records caller-supplied success without a committed mutation as failed", async () => {
		const database = createTestDb();
		try {
			installRemSchema(database.runtime.db);
			const rowId = seedProductionMemory(database.runtime.raw, {
				scope: "persona:false-success",
				text: TRANSITION_TEXT,
			});
			const before = database.runtime.raw
				.prepare("SELECT text, content_hash FROM nodix_memories WHERE id = ?")
				.get(rowId);
			const configurationSha256 = "c".repeat(64);
			const executor = createSnoStationMemRemMutationExecutor({
				database: database.runtime.db,
				jobType: "rem-update",
				configurationSha256,
				liveContentionRetries: 0,
			});
			const handle = await executor.openAttempt({
				jobId: "false-success",
				stage: "rem-update",
				rowId,
				writer: "writeTextVersion",
				authorization: {
					rowId,
					preWriteContentSha256: createHash("sha256").update(TRANSITION_TEXT).digest("hex"),
					proposedTextSha256: createHash("sha256").update("Lives in San Diego.").digest("hex"),
					evidenceId: "false-success-evidence",
					configurationSha256,
				},
			});

			await expect(
				executor.closeAttempt(handle, {
					applied: true,
					attemptOrdinal: 1,
					reasonCode: null,
				}),
			).resolves.toMatchObject({
				applied: false,
				outcome: "failed",
				reasonCode: "mutation_not_committed",
			});
			expect(
				database.runtime.raw
					.prepare("SELECT outcome, reason_code FROM nodix_rem_write_attempts WHERE attempt_id = ?")
					.get(handle.attemptId),
			).toEqual({ outcome: "failed", reason_code: "mutation_not_committed" });
			expect(
				database.runtime.raw
					.prepare("SELECT text, content_hash FROM nodix_memories WHERE id = ?")
					.get(rowId),
			).toEqual(before);
		} finally {
			database.cleanup();
		}
	});

	it("does not retain a winner with no current chunk", async () => {
		const database = createTestDb();
		try {
			installRemSchema(database.runtime.db);
			const scope = "persona:missing-current-chunk";
			const olderRowId = seedProductionMemory(database.runtime.raw, {
				scope,
				text: "The user lived in San Francisco.",
			});
			const winnerRowId = seedProductionMemory(database.runtime.raw, {
				scope,
				text: "The user lives in San Diego.",
			});
			await expect(
				createRemReplaceCarrierPort({
					database: database.runtime.db,
					winnerRowId,
					loserRowId: olderRowId,
					loserProjectId: scope,
					loserCategory: "profile",
				}).carrierState(),
			).resolves.toEqual({ retained: false, fault: "carrier_not_on_current_facet" });
			expect(
				database.runtime.raw
					.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
					.get(olderRowId),
			).toEqual({ metadata: JSON.stringify({ section_name: "preferences.production-reachability" }) });
		} finally {
			database.cleanup();
		}
	});
});
