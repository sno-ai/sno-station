/** @file rem-retirement-candidate-set.test.ts
 * @purpose A retirement sentence must nominate the row it retires, not itself (PRD 110 REQ-2, REQ-6).
 * @boundary Production REM batch executor over a real SQLite store; the model stage is observed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../apps/mem-claw/src/sidecar/rem-batch-executor.ts";
import { REM_UPDATE_JUDGMENT_SKILL } from "../../../../apps/mem-claw/src/sidecar/rem-update-judgment-skill.ts";
import { parseRemOperationalConfiguration } from "../../../../packages/rem-core/src/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../helpers/rem-entry-config-fixture.ts";
import { seedProductionMemory } from "../helpers/rem-production-entry-fixture.ts";
import { createTestDb, type TestDb } from "../helpers/test-db.ts";

// The two texts are the real corpus rows measured 2026-09-04 in the content_writer store.
const OUTDATED_FACT = "The user enjoys books that delve into war and conflict.";
const RETIREMENT_SENTENCE = "The user used to be interested in books about war and conflict.";
const OUTDATED_ROW_ID = "rem-retirement-outdated-war-and-conflict";
const RETIREMENT_ROW_ID = "rem-retirement-sentence-war-and-conflict";

const priorEnvironment = {
	MEM_CLAW_DATA_DIR_ROOT: process.env["MEM_CLAW_DATA_DIR_ROOT"],
	MEM_CLAW_REM_EXPECTED_DB_PATH: process.env["MEM_CLAW_REM_EXPECTED_DB_PATH"],
	OPENCLAW_STATE_DIR: process.env["OPENCLAW_STATE_DIR"],
};
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	restoreEnvironment("MEM_CLAW_DATA_DIR_ROOT", priorEnvironment.MEM_CLAW_DATA_DIR_ROOT);
	restoreEnvironment(
		"MEM_CLAW_REM_EXPECTED_DB_PATH",
		priorEnvironment.MEM_CLAW_REM_EXPECTED_DB_PATH,
	);
	restoreEnvironment("OPENCLAW_STATE_DIR", priorEnvironment.OPENCLAW_STATE_DIR);
});

interface StageObservation {
	stage: string;
	prompt: string;
}

async function runRetirementWave(
	scope: string,
	replyFor?: (observation: StageObservation) => string | undefined,
): Promise<{
	observations: StageObservation[];
	database: TestDb;
}> {
	const fixture = prepareBatchFixture(scope);
	seedProductionMemory(fixture.runtime.raw, { id: OUTDATED_ROW_ID, scope, text: OUTDATED_FACT });
	seedProductionMemory(fixture.runtime.raw, { id: RETIREMENT_ROW_ID, scope, text: RETIREMENT_SENTENCE });
	const observations: StageObservation[] = [];
	await runRemBatchJobTolerantOfRefusal({
		jobId: `job-${scope}`,
		jobType: "rem-update",
		scope,
		configuration: parseRemOperationalConfiguration(
			createRemOwnerDecidedOperationalConfiguration(),
		),
		modelStageResponses: createRemModelStageResponsePort({
			// A narrow real boundary: each stage gets its own schema's neutral answer, so the wave
			// runs its whole path and the assertions read what the engine ASKED. Judging nothing
			// retired keeps the store unchanged, which is what today's model answers anyway.
			respond: async ({ stage, prompt }) => {
				const observation = { stage, prompt };
				observations.push(observation);
				return replyFor?.(observation) ?? neutralReplyFor(stage);
			},
		}),
	});
	return { observations, database: fixture };
}

describe("a retirement sentence nominates the row it retires", () => {
	it(
		"REQ-2: the judgement is offered the outdated row's stable id",
		{ timeout: 30_000 },
		async () => {
			const { observations } = await runRetirementWave("persona:rem-retirement-req2");
			const offered = observations.filter((observation) =>
				observation.prompt.includes(OUTDATED_ROW_ID),
			);
			expect(
				offered.map((observation) => observation.stage),
				`the outdated row's TEXT reaches the model but its stable id ${OUTDATED_ROW_ID} never does, so no answer can name which row to retire; stages seen: ${JSON.stringify(observations.map((observation) => observation.stage))}`,
			).not.toEqual([]);
		},
	);

	it(
		"REQ-6: the retirement sentence is never the row being rewritten",
		{ timeout: 30_000 },
		async () => {
			// Case 1 of the state table: the model names the offered target. From that answer on, the
			// nominated row is a retirement statement and must never be the row being rewritten.
			const { observations } = await runRetirementWave("persona:rem-retirement-req6", (o) =>
				o.stage === "rem-update-retirement-target" ? JSON.stringify({ target_row_ids: [OUTDATED_ROW_ID] }) : undefined,
			);
			const rewrittenAsSource = observations.filter(
				(observation) =>
					observation.prompt.includes(`Source row: ${JSON.stringify(RETIREMENT_SENTENCE)}`) ||
					observation.prompt.includes(`Original row: ${JSON.stringify(RETIREMENT_SENTENCE)}`) ||
					observation.prompt.includes(`Retired values: ${JSON.stringify([RETIREMENT_SENTENCE])}`),
			);
			expect(
				rewrittenAsSource.map((observation) => observation.stage),
				"the retirement sentence was placed in the rewrite path's source slot or supplied its own text as its own retired value",
			).toEqual([]);
		},
	);

	it(
		"QCG-1 REQ-1: the wave puts the nominated row to a model, and no engine rule picks the target",
		{ timeout: 30_000 },
		async () => {
			const { observations } = await runRetirementWave("persona:rem-retirement-req1");
			expect(
				observations.map((observation) => observation.stage),
				"the nominated retirement row never reached a model judgement",
			).toContain("rem-update-retirement-target");
			const engineSources = [
				readFileSync(
					new URL(
						"../../../../apps/mem-claw/src/sidecar/rem-batch-executor.ts",
						import.meta.url,
					),
					"utf8",
				),
				readFileSync(
					new URL("../../../../packages/rem-core/src/rem-update-judgment.ts", import.meta.url),
					"utf8",
				),
			].join("\n");
			// The target is chosen by the model. Engine code may order rows and offer them; it may not
			// read meaning. A phrase list or regular expression comparing row TEXT is the defect
			// returning, so the check reads executable lines only — a comment mentioning an English
			// phrase is prose, not a rule, and an earlier version of this test fired on exactly that.
			const executableLines = engineSources
				.split("\n")
				.filter((line) => {
					const trimmed = line.trim();
					return (
						trimmed.length > 0 &&
						!trimmed.startsWith("//") &&
						!trimmed.startsWith("*") &&
						!trimmed.startsWith("/*")
					);
				})
				.join("\n");
			for (const meaningRule of [
				"used to",
				"no longer",
				"lately",
				"formerly",
				"instead of",
			]) {
				expect(
					executableLines.toLowerCase(),
					`engine code matches on the retirement phrase "${meaningRule}"; meaning belongs in the skill text`,
				).not.toContain(meaningRule);
			}
		},
	);

	it(
		"QCG-3 REQ-3: an offered id is applied and an unoffered id is refused with no write",
		{ timeout: 60_000 },
		async () => {
			const accepted = await runRetirementWave(
				"persona:rem-retirement-req3-offered",
				(observation) => {
					// Two answers make one retirement: the target stage names the row, and the follow-up
					// says whether all of it or part of it dies. War-books is an all-of-it case.
					if (observation.stage === "rem-update-retirement-target") {
						const offered = offeredCandidateIds(observation.prompt);
						expect(offered, "the outdated row was not among the offered candidates").toContain(
							OUTDATED_ROW_ID,
						);
						return JSON.stringify({ target_row_ids: [OUTDATED_ROW_ID] });
					}
					if (observation.stage === "rem-update-relation-judgment") {
						return JSON.stringify({
							supersedes: true,
							retires_anything: true,
							supersedes_everything: true,
						});
					}
					return undefined;
				},
			);
			expect(
				rowState(accepted.database, OUTDATED_ROW_ID),
				"an offered id was not applied to the row it named, or the wrong row was recorded as retiring it",
			).toBe(RETIREMENT_ROW_ID);

			const rejected = await runRetirementWave(
				"persona:rem-retirement-req3-unoffered",
				(o) => (o.stage === "rem-update-retirement-target" ? JSON.stringify({ target_row_ids: ["a-row-id-that-was-never-offered"] }) : undefined),
			);
			expect(
				rowState(rejected.database, OUTDATED_ROW_ID),
				"an id the model was never offered changed a row's state",
			).toBeNull();
			expect(
				journalReasons(rejected.database),
				"an unoffered id was not journalled as a refusal",
			).toContain("row_id_not_offered");
		},
	);

	it(
		"QCG-5 REQ-5: answering none leaves the row live and journals the candidate-set size",
		{ timeout: 30_000 },
		async () => {
			const { database } = await runRetirementWave("persona:rem-retirement-req5", (o) =>
				o.stage === "rem-update-retirement-target" ? JSON.stringify({ target_row_ids: [] }) : undefined,
			);
			expect(
				rowState(database, OUTDATED_ROW_ID),
				"answering none still changed a row's state",
			).toBeNull();
			expect(
				rowState(database, RETIREMENT_ROW_ID),
				"answering none still changed the nominated row's state",
			).toBeNull();
			const noTarget = database.runtime.raw
				.prepare(
					`SELECT stage, reason, detail FROM nodix_rem_journal
					WHERE reason = 'no_retirement_target' AND row_id = ?`,
				)
				.all(RETIREMENT_ROW_ID) as Array<{ stage: string; reason: string; detail: string }>;
			expect(noTarget, "a none answer wrote no readable no-target journal row").toHaveLength(1);
			const detail = JSON.parse(noTarget[0].detail) as {
				nominatedRowId: string;
				candidateSetSize: number;
			};
			expect(detail.nominatedRowId).toBe(RETIREMENT_ROW_ID);
			expect(
				detail.candidateSetSize,
				"the journal does not say how many candidates the model was offered",
			).toBeGreaterThan(0);
		},
	);

	it(
		"REQ-2 at corpus shape: with six rows in one group, a retirement row that is not the newest still reaches the judgement",
		{ timeout: 60_000 },
		async () => {
			// The two-row case passes by luck: the retirement row is the newest. In the corpus the
			// same address group holds six rows and the retirement row is in the middle. Measured
			// 2026-09-04 in the real sidecar: it never reached the judgement and fell to the old rewrite.
			const scope = "persona:rem-retirement-six-rows";
			const fixture = prepareBatchFixture(scope);
			const raw = fixture.runtime.raw;
			const day = (n: number) => `2026-06-0${n}T08:00:00.000Z`;
			seedProductionMemory(raw, { id: OUTDATED_ROW_ID, scope, text: OUTDATED_FACT, timestamp: day(1) });
			seedProductionMemory(raw, { id: "six-modernism", scope, text: "The user likes reading about modernism in books.", timestamp: day(1) });
			seedProductionMemory(raw, { id: RETIREMENT_ROW_ID, scope, text: RETIREMENT_SENTENCE, timestamp: day(3) });
			seedProductionMemory(raw, { id: "six-current-philosophy", scope, text: "The user is currently drawn to books with philosophical themes.", timestamp: day(3) });
			seedProductionMemory(raw, { id: "six-retires-philosophy", scope, text: "The user used to really like books about philosophical themes.", timestamp: day(5) });
			seedProductionMemory(raw, { id: "six-current-industrial", scope, text: "The user is finding themselves drawn to books about industrialization lately.", timestamp: day(5) });
			const observations: StageObservation[] = [];
			await runRemBatchJobTolerantOfRefusal({
				jobId: `job-${scope}`,
				jobType: "rem-update",
				scope,
				configuration: parseRemOperationalConfiguration(
					createRemOwnerDecidedOperationalConfiguration(),
				),
				modelStageResponses: createRemModelStageResponsePort({
					respond: async ({ stage, prompt }) => {
						observations.push({ stage, prompt });
						return neutralReplyFor(stage);
					},
				}),
			});
			const askedAboutRetirementRow = observations.filter(
				(observation) =>
					observation.stage === "rem-update-retirement-target" &&
					observation.prompt.includes(`"id":${JSON.stringify(RETIREMENT_ROW_ID)}`),
			);
			expect(
				askedAboutRetirementRow.map((observation) => offeredCandidateIds(observation.prompt)),
				`the retirement row was never nominated to the judgement; target stages seen for: ${JSON.stringify(observations.filter((o) => o.stage === "rem-update-retirement-target").map((o) => o.prompt.match(/Nominated row: (\{[^}]*\})/)?.[1]))}`,
			).toContainEqual(expect.arrayContaining([OUTDATED_ROW_ID]));
		},
	);

	it(
		"a pure-negation row is nominated too: 'no longer needs to track X' must be asked which row it retires",
		{ timeout: 60_000 },
		async () => {
			// Measured 2026-09-04 over three persona stores: 23 removal-shaped rows, 10 of them
			// classified pure-negation and mapped to owner "none", so no stage in the wave ever reads
			// them. "The user no longer needs to track X" is the plainest completion a user can state,
			// and today it leaves the X to-do live beside it.
			const scope = "persona:rem-retirement-pure-negation";
			const fixture = prepareBatchFixture(scope);
			const raw = fixture.runtime.raw;
			const TODO = "The user needs to edit some website copy.";
			const DONE = 'The user no longer needs to track "Edit website copy" from their work tasks.';
			seedProductionMemory(raw, { id: "neg-todo", scope, text: TODO, timestamp: "2026-06-03T08:00:00.000Z" });
			seedProductionMemory(raw, { id: "neg-done", scope, text: DONE, timestamp: "2026-06-05T08:00:00.000Z" });
			const observations: StageObservation[] = [];
			await runRemBatchJobTolerantOfRefusal({
				jobId: `job-${scope}`,
				jobType: "rem-update",
				scope,
				configuration: parseRemOperationalConfiguration(
					createRemOwnerDecidedOperationalConfiguration(),
				),
				modelStageResponses: createRemModelStageResponsePort({
					respond: async ({ stage, prompt }) => {
						observations.push({ stage, prompt });
						return neutralReplyFor(stage);
					},
				}),
			});
			const asked = observations.filter(
				(o) =>
					o.stage === "rem-update-retirement-target" && o.prompt.includes('"id":"neg-done"'),
			);
			expect(
				asked.map((o) => offeredCandidateIds(o.prompt)),
				`the pure-negation row was never nominated; stages seen: ${JSON.stringify(observations.map((o) => o.stage))}`,
			).toContainEqual(expect.arrayContaining(["neg-todo"]));
		},
	);

	it("QCG-7 REQ-7: the meaning of a retirement lives in the skill text, and the router only nominates", () => {
		// The model reads this text. Every sentence about what a retirement IS, and how to pick the
		// row it retires, must be here and nowhere else.
		const skill = REM_UPDATE_JUDGMENT_SKILL.retirementTarget;
		expect(skill).toContain("retirement statement");
		expect(skill).toContain("no\n  longer current");
		expect(skill).toContain("Choose only by meaning");
		// The set-valued judgement (PRD 150 REQ-5) replaced the single target: the model answers with
	// every offered row the statement retires, or with none.
	expect(skill).toContain("Return an empty set when the nominated row retires no offered candidate");
		// The router keeps its coarse patterns and gains nothing about targets: it may nominate a row
		// for judgement, and it may not name what that row retires.
		const classifier = readFileSync(
			new URL("../../../../packages/rem-core/src/classifier.ts", import.meta.url),
			"utf8",
		);
		for (const targetVocabulary of ["target_row_id", "retirementTarget", "retirement-target"]) {
			expect(
				classifier,
				`classifier.ts names a retirement target ("${targetVocabulary}"); routing may nominate only`,
			).not.toContain(targetVocabulary);
		}
	});
});

function offeredCandidateIds(prompt: string): string[] {
	const line = prompt.split("\n\n").find((part) => part.startsWith("Candidate rows: "));
	if (line === undefined) return [];
	const rows = JSON.parse(line.slice("Candidate rows: ".length)) as Array<{ id: string }>;
	return rows.map((row) => row.id);
}

// A retired row carries the retiring row's id under metadata.superseded_by; a live row carries none.
function rowState(database: TestDb, rowId: string): string | null {
	const row = database.runtime.raw
		.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
		.get(rowId) as { metadata: string } | undefined;
	if (row === undefined) return null;
	const metadata = JSON.parse(row.metadata) as { superseded_by?: unknown };
	return typeof metadata.superseded_by === "string" ? metadata.superseded_by : null;
}

function journalReasons(database: TestDb): string[] {
	const rows = database.runtime.raw
		.prepare("SELECT reason FROM nodix_rem_journal WHERE reason IS NOT NULL")
		.all() as Array<{ reason: string }>;
	return rows.map((row) => row.reason);
}


function prepareBatchFixture(scope: string): TestDb {
	const fixture = createTestDb();
	const stateRoot = mkdtempSync(join(tmpdir(), `rem-retirement-${scope.replace(/\W+/g, "-")}-`));
	writeFileSync(
		join(stateRoot, "openclaw.json"),
		JSON.stringify({
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
		}),
		"utf8",
	);
	process.env["MEM_CLAW_DATA_DIR_ROOT"] = dirname(fixture.dbPath);
	process.env["MEM_CLAW_REM_EXPECTED_DB_PATH"] = fixture.dbPath;
	process.env["OPENCLAW_STATE_DIR"] = stateRoot;
	cleanups.push(() => {
		fixture.cleanup();
		rmSync(stateRoot, { recursive: true, force: true });
	});
	return fixture;
}

// The wave throws when every model call is refused. That is correct production behaviour and is
// not what this file measures: the evidence is what the engine ASKED before any refusal.
async function runRemBatchJobTolerantOfRefusal(
	input: Parameters<typeof runRemBatchJob>[0],
): Promise<void> {
	try {
		await runRemBatchJob(input);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.startsWith("REM LLM calls all failed")) throw error;
	}
}

function neutralReplyFor(stage: string): string {
	switch (stage) {
		case "rem-update-judgment":
			return JSON.stringify({ proposed_current: "", retired_values: [] });
		case "rem-update-relation-judgment":
			return JSON.stringify({
				supersedes: false,
				retires_anything: false,
				supersedes_everything: false,
			});
		case "rem-update-verification":
			return JSON.stringify({
				faithful: false,
				retired_absent: false,
				all_facts_accounted: false,
			});
		case "rem-update-retirement-target":
			return JSON.stringify({ target_row_ids: [] });
		case "rem-replace-clause-carry":
			return JSON.stringify({ already_current: [] });
		default:
			return "{}";
	}
}

function restoreEnvironment(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
