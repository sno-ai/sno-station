/** @file rem-model-stage-outcomes.test.ts
 * @purpose Proves every REM model stage rejects a non-null invalid response at runtime.
 * @boundary Real encrypted store, embedder, batch executor, and durable ledger; response text is the only seam.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	REM_MODEL_STAGES,
	type RemBatchJobResult,
	type RemModelStage,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import { parseRemOperationalConfiguration } from "../../../../packages/memory/src/engine/rem/operational-config.ts";
import { createTestEmbedder } from "../helpers/test-db.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../helpers/rem-entry-config-fixture.ts";
import { RemRoundtripHarness, type RemJobType } from "./rem-roundtrip-harness.ts";

const UPDATE_SOURCE =
	"Project 'Modern Library Digitization' currently has a budget of $18,000, updated from $15,000 on 2026-07-28.";
const INVALID_RESPONSE = "{invalid-stage-response";
let embedder: Embedder;
let harness: RemRoundtripHarness | undefined;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

describe("ACC-12 real stage response outcomes", () => {
	it.each(REM_MODEL_STAGES)(
		"does not count an invalid %s response as success",
		{ timeout: 30_000 },
		async (invalidStage) => {
			harness = await RemRoundtripHarness.create(embedder);
			const jobType = jobTypeFor(invalidStage);
			await seedFor(jobType, harness, invalidStage);
			const jobId = `acc-12-${invalidStage}`;
			const calledStages: RemModelStage[] = [];

			let result: RemBatchJobResult | undefined;
			let failure: unknown;
			try {
				result = await harness.runDirectJob({
					// The other cases in this file pass the owner-decided configuration; without
					// it the default pairing thresholds build no pairs and the replace stages
					// are never reached.
					configuration: parseRemOperationalConfiguration(
						createRemOwnerDecidedOperationalConfiguration(),
					),
					jobId,
					jobType,
					respond: async ({ stage, prompt }) => {
						calledStages.push(stage);
						return stage === invalidStage
							? INVALID_RESPONSE
							: validResponse(stage, prompt);
					},
				});
			} catch (error) {
				failure = error;
			}

			expect(
				calledStages,
				`journal=${JSON.stringify(harness.readJobJournal(jobId))} result=${JSON.stringify(result)} failure=${String(failure)}`,
			).toContain(invalidStage);
			const evidence = `result=${JSON.stringify(result)} failure=${String(failure)} journal=${JSON.stringify(harness.readJobJournal(jobId))}`;
			if (result === undefined) {
				expect(String(failure)).toMatch(/all failed/i);
			} else {
				// The executor has one terminal state; "not counted as success" means the
				// invalid reply was recorded as a parse failure and wrote nothing.
				expect(result.parseFailureCount, evidence).toBeGreaterThan(0);
				expect(result.actionsApplied, evidence).toBe(0);
			}
			const refused = harness
				.readJobJournal(jobId)
				.filter((entry) => entry["outcome"] === "refused");
			expect(refused.length).toBeGreaterThan(0);
		},
	);

	it("fails when every model stage response is non-null and invalid", { timeout: 30_000 }, async () => {
		harness = await RemRoundtripHarness.create(embedder);
		await seedFor("rem-replace", harness, "rem-replace-pair");
		const calledStages: RemModelStage[] = [];

		await expect(
			harness.runDirectJob({
				configuration: parseRemOperationalConfiguration(
					createRemOwnerDecidedOperationalConfiguration(),
				),
				jobId: "acc-12-all-invalid",
				jobType: "rem-replace",
				respond: async ({ stage }) => {
					calledStages.push(stage);
					return INVALID_RESPONSE;
				},
			}),
		).rejects.toThrow(/all failed/i);
		expect(calledStages).toEqual(["rem-replace-pair"]);
		expect(harness.readJobJournal("acc-12-all-invalid")).toEqual(
			expect.arrayContaining([expect.objectContaining({ outcome: "refused" })]),
		);
	});

	it("completes when the model validly reports that no fact is retired", { timeout: 30_000 }, async () => {
		harness = await RemRoundtripHarness.create(embedder);
		const topic = "preferences.edge-rem-relation-no-op";
		await harness.seedMemory({
			content: "The user listens to Count Basie recordings during long drives.",
			metadata: { section_name: topic, topic, valid_from: "2026-08-04T00:00:00.000Z" },
		});
		await harness.seedMemory({
			content: "The user has moved away from Count Basie recordings during long drives.",
			metadata: { section_name: topic, topic, valid_from: "2026-08-05T00:00:00.000Z" },
		});
		const configuration = parseRemOperationalConfiguration(
			createRemOwnerDecidedOperationalConfiguration(),
		);
		const calledStages: RemModelStage[] = [];

		const result = await harness.runDirectJob({
			configuration,
			jobId: "acc-12-no-retired-fact",
			jobType: "rem-update",
			respond: async ({ stage, prompt }) => {
				calledStages.push(stage);
				if (stage === "rem-update-relation-judgment") {
					// The model validly reports that this pair retires nothing.
					return JSON.stringify({
						supersedes: false,
						retires_anything: false,
						supersedes_everything: false,
					});
				}
				return validResponse(stage, prompt);
			},
		});

		expect(result).toMatchObject({ terminalState: "done", actionsApplied: 0 });
		expect(calledStages).toContain("rem-update-relation-judgment");
		expect(harness.readJobJournal("acc-12-no-retired-fact")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ outcome: "refused", reason: "no_retired_fact" }),
			]),
		);
	});

	// The two tests this replaces asserted that a configured call budget and token budget stopped
	// the stage. Both ceilings were deleted on 2026-08-11 — guessed numbers that between them made
	// the engine do nothing — so a test that they still bite would now be pinning the defect. What
	// has to hold instead is that the wave says what it actually did, which is the only input a
	// real ceiling could ever be derived from, and the signal that catches an inert engine.
	it("reports the model work it actually did", { timeout: 30_000 }, async () => {
		harness = await RemRoundtripHarness.create(embedder);
		await seedFor("rem-update", harness, "rem-update-judgment");
		const configuration = parseRemOperationalConfiguration(
			createRemOwnerDecidedOperationalConfiguration(),
		);
		const calledStages: RemModelStage[] = [];

		const result = await harness.runDirectJob({
			configuration,
			jobId: "acc-12-update-measurements",
			jobType: "rem-update",
			respond: async ({ stage, prompt }) => {
				calledStages.push(stage);
				return validResponse(stage, prompt);
			},
		});

		// Both halves matter: a stage that made no call at all would satisfy a "calls <= n" check
		// and is exactly the failure this measurement exists to make visible.
		expect(calledStages.length).toBeGreaterThan(0);
		expect(result.measurements.modelCalls).toBe(calledStages.length);
		expect(result.measurements.modelTokens).toBeGreaterThan(0);
		expect(result.measurements.rowsConsidered).toBeGreaterThan(0);
	});
});

function jobTypeFor(stage: RemModelStage): "rem-update" | "rem-replace" {
	return stage.startsWith("rem-update-") ? "rem-update" : "rem-replace";
}

async function seedFor(
	jobType: RemJobType,
	target: RemRoundtripHarness,
	stage: RemModelStage,
): Promise<void> {
	if (jobType === "rem-update") {
		if (stage === "rem-update-relation-judgment" || stage === "rem-update-retirement-target") {
			// The retirement-target stage fires first for the newer row of this pair, because it
			// has an older address-mate to be offered; the relation-judgment stage follows.
			// The relation-judgment stage only fires when one canonical address carries a
			// predecessor as well as the row under judgement. Neither row may carry a
			// retirable value, or the sibling row applies a rewrite of its own and the
			// wave's action count no longer isolates this stage. The pair must also avoid
			// the ambiguous classification, which is refused before relation grouping.
			const topic = "preferences.edge-rem-acc-12-relation";
			await target.seedMemory({
				content: "The user listens to Count Basie recordings during long drives.",
				metadata: { section_name: topic, topic, valid_from: "2026-08-04T00:00:00.000Z" },
			});
			await target.seedMemory({
				content: "The user has moved away from Count Basie recordings during long drives.",
				metadata: { section_name: topic, topic, valid_from: "2026-08-05T00:00:00.000Z" },
			});
			return;
		}
		await target.seedMemory({ content: UPDATE_SOURCE });
		return;
	}
	if (stage === "rem-replace-clause-carry") {
		// The carry stage only runs when coverage leaves a clause uncertified, which
		// needs an older row saying something the survivor never restates.
		await target.seedProfilePair("acc-12-carry", {
			stale:
				"The researcher prefers tea during the morning review. The researcher reviews on Tuesdays.",
			current: "The researcher prefers coffee during the morning review.",
		});
		return;
	}
	await target.seedProfilePair("acc-12-runtime", {
		stale: "The researcher prefers tea during the morning review.",
		current: "The researcher prefers coffee during the morning review.",
	});
}

function validResponse(stage: RemModelStage, prompt: string): string {
	if (stage === "rem-update-retirement-target") {
		// Well-formed and empty: the nominated row retires none of the offered candidates.
		return JSON.stringify({ target_row_ids: [] });
	}
	if (stage === "rem-update-judgment") {
		if (!prompt.includes("updated from $15,000")) {
			// Nothing to retire on this row: the model reports the text unchanged.
			return JSON.stringify({ proposed_current: "", retired_values: [] });
		}
		return JSON.stringify({
			proposed_current: UPDATE_SOURCE.replace("$15,000", "$18,000"),
			retired_values: ["$15,000"],
		});
	}
	if (stage === "rem-update-verification") {
		return JSON.stringify({
			faithful: true,
			retired_absent: true,
			all_facts_accounted: true,
		});
	}
	if (stage === "rem-update-relation-judgment") {
		return JSON.stringify({
			supersedes: false,
			retires_anything: false,
			supersedes_everything: false,
		});
	}
	if (stage === "rem-replace-pair") return "replacement";
	if (stage === "rem-replace-clauses") {
		return JSON.stringify({ verdict: "replacement", retiring_clause_indices: [0] });
	}
	return JSON.stringify({
		atoms: [{ clause_index: 0, class: "retired-fact", status: "covered" }],
	});
}
