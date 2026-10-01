import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
/** @file PRD 150 QCG-14 — the maintenance waves admit the `state` type (REQ-14).
 *
 * @boundary The production REM batch executor over a real encrypted SQLite store, both waves. The
 * model stage is observed, so the assertions read what the engine asked and what it wrote.
 *
 * `state` is the third memory type this change adds: a fact about a named thing the user is
 * editing — a proposal's budget, its stakeholders. Before this change both waves filtered rows on
 * `category IN ('profile','episodic')`, so every `state` row was invisible to maintenance: never
 * paired, never judged, never closed. A store could hold two current budgets forever.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import { parseRemOperationalConfiguration } from "../../../../packages/memory/src/engine/rem/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const SCOPE = "persona:group-crud-state-wave";
const PROPOSAL = "entity:project_proposal_1";
const BASE_VALID_FROM = Date.UTC(2026, 8, 1);

const priorEnvironment = {
	SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
	SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
};
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	for (const [name, value] of Object.entries(priorEnvironment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

interface SeedRow {
	id: string;
	text: string;
	category: "state" | "profile" | "episodic";
	subject: string | null;
	attribute: string | null;
	turn: number;
}

/** One proposal: two budgets, three stakeholders, plus a person-profile row of the same store. */
const ROWS: SeedRow[] = [
	{
		id: "state-budget-old",
		text: "The proposal budget is $800,000.",
		category: "state",
		subject: PROPOSAL,
		attribute: "project.budget",
		turn: 1,
	},
	{
		id: "state-budget-new",
		text: "The proposal budget is $850,000.",
		category: "state",
		subject: PROPOSAL,
		attribute: "project.budget",
		turn: 9,
	},
	{
		id: "state-stakeholder-utilities",
		text: "The proposal lists Local Utility Companies as a stakeholder.",
		category: "state",
		subject: PROPOSAL,
		attribute: "project.stakeholder",
		turn: 2,
	},
	{
		id: "state-stakeholder-epa",
		text: "The proposal lists the Environmental Protection Agency as a stakeholder.",
		category: "state",
		subject: PROPOSAL,
		attribute: "project.stakeholder",
		turn: 3,
	},
	{
		id: "state-stakeholder-university",
		text: "The proposal lists the university energy institute as a stakeholder.",
		category: "state",
		subject: PROPOSAL,
		attribute: "project.stakeholder",
		turn: 4,
	},
	{
		id: "state-stakeholder-removed",
		text: "The proposal no longer lists the Environmental Protection Agency as a stakeholder.",
		category: "state",
		subject: PROPOSAL,
		attribute: "project.stakeholder",
		turn: 11,
	},
	{
		// A person-profile row in the same store. A `state` row must never be paired with it.
		id: "profile-unrelated",
		text: "The user prefers to review proposals in the morning.",
		category: "profile",
		subject: "user",
		attribute: "routine.chores",
		turn: 5,
	},
];

function seedRow(database: TestDb["runtime"]["raw"], row: SeedRow): void {
	const metadata = {
		kind: row.category,
		memory_category: row.category,
		[row.category === "profile" ? "section_name" : "topic"]: row.attribute ?? "unkeyed",
		source_order: {
			valid_from: BASE_VALID_FROM,
			session_ordinal: 0,
			global_turn_index: row.turn,
			rowid: row.turn,
		},
	};
	database
		.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata,
				content_hash, fact_id, lane, raw_candidate_json, subject, attribute, valid_from
			) VALUES (?, ?, ?, ?, 0.9, ?, 'UTC', ?, ?, ?, 'active', ?, ?, ?, ?)`,
		)
		.run(
			row.id,
			row.text,
			row.category,
			SCOPE,
			BASE_VALID_FROM + row.turn,
			JSON.stringify(metadata),
			createHash("sha256").update(row.text).digest("hex"),
			`fact-${row.id}`,
			JSON.stringify({ evidence: row.text }),
			row.subject,
			row.attribute,
			BASE_VALID_FROM,
		);
}

interface Observation {
	stage: string;
	prompt: string;
}

/**
 * The pair stage is answered per pair, not blanket.
 *
 * A blanket "replacement" makes any two stakeholder rows replace each other, and the store then
 * loses a stakeholder nobody removed — which is what the first run of this file did. The two
 * budget rows are the only pair that genuinely restates one value.
 */
function replacePairVerdict(prompt: string): string {
	const budgets = ["The proposal budget is $800,000.", "The proposal budget is $850,000."];
	return budgets.every((text) => prompt.includes(text)) ? "replacement" : "keep";
}

function replyFor(stage: string, prompt: string): string {
	switch (stage) {
		case "rem-replace-pair":
			return replacePairVerdict(prompt);
		case "rem-replace-clauses":
			return JSON.stringify({ verdict: "replacement", retiring_clause_indices: [0] });
		case "rem-replace-coverage":
			return JSON.stringify({
				atoms: [{ clause_index: 0, class: "retired-fact", status: "covered" }],
			});
		case "rem-replace-clause-carry":
			return JSON.stringify({ already_current: [true] });
		case "rem-update-retirement-target":
			return JSON.stringify({ target_row_ids: [] });
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
		default:
			return "{}";
	}
}

function prepareFixture(): TestDb {
	const fixture = createTestDb();
	const stateRoot = mkdtempSync(join(tmpdir(), "group-crud-state-wave-"));
	writeSettingsFixture(stateRoot, { mode: "local-first", store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey },
		embedding: { cacheDir: "" } });
	process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = fixture.dbPath;
	process.env["SNO_PROFILE_DIR"] = stateRoot;
	cleanups.push(() => {
		fixture.cleanup();
		rmSync(stateRoot, { recursive: true, force: true });
	});
	for (const row of ROWS) seedRow(fixture.runtime.raw, row);
	return fixture;
}

async function runBothWaves(
	fixture: TestDb,
	respondTo?: (observation: Observation) => string | undefined,
): Promise<Observation[]> {
	const observations: Observation[] = [];
	const configuration = parseRemOperationalConfiguration(
		createRemOwnerDecidedOperationalConfiguration(),
	);
	for (const jobType of ["rem-replace", "rem-update"] as const) {
		try {
			await runRemBatchJob({
				jobId: `job-${jobType}-state`,
				jobType,
				scope: SCOPE,
				configuration,
				modelStageResponses: createRemModelStageResponsePort({
					respond: async ({ stage, prompt }) => {
						const observation = { stage, prompt };
						observations.push(observation);
						return respondTo?.(observation) ?? replyFor(stage, prompt);
					},
				}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.startsWith("REM LLM calls all failed")) throw error;
		}
	}
	return observations;
}

function journalReasons(fixture: TestDb): string[] {
	return (
		fixture.runtime.raw
			.prepare("SELECT reason FROM nodix_rem_journal WHERE reason IS NOT NULL")
			.all() as Array<{ reason: string }>
	).map((row) => row.reason);
}

function supersededBy(fixture: TestDb, rowId: string): string | null {
	const row = fixture.runtime.raw
		.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
		.get(rowId) as { metadata: string } | undefined;
	if (row === undefined) return null;
	const value = (JSON.parse(row.metadata) as { superseded_by?: unknown }).superseded_by;
	return typeof value === "string" ? value : null;
}

describe("PRD 150 QCG-14 — both waves admit the state type", () => {
	it("refuses no state row for a missing kind, and never pairs one with a profile row", async () => {
		const fixture = prepareFixture();
		const observations = await runBothWaves(fixture);

		expect(
			journalReasons(fixture),
			"a state row was refused as an unknown memory kind, so maintenance never reached it",
		).not.toContain("missing_row_kind");

		// The profile row belongs to a different subject and a different type. If it appears in a
		// prompt beside a state row, the wave is pairing across types.
		const profileText = "The user prefers to review proposals in the morning.";
		const crossType = observations.filter(
			(observation) =>
				observation.prompt.includes(profileText) && observation.prompt.includes(PROPOSAL),
		);
		expect(
			crossType.map((observation) => observation.stage),
			"a state row was put in the same judgement as a person-profile row",
		).toEqual([]);
	}, 240_000);

	it("closes the older budget and the removed stakeholder, and nothing else", async () => {
		const fixture = prepareFixture();
		await runBothWaves(fixture, (observation) => {
			// The removal names the stakeholder it removes, and only that one.
			if (
				observation.stage === "rem-update-retirement-target" &&
				observation.prompt.includes('"id":"state-stakeholder-removed"')
			) {
				return JSON.stringify({ target_row_ids: ["state-stakeholder-epa"] });
			}
			// `project.stakeholder` holds many values, so nothing closes mechanically: the named row
			// goes on to the relation judgement, and only a yes there ends it.
			if (observation.stage === "rem-update-relation-judgment") {
				return JSON.stringify({
					supersedes: true,
					retires_anything: true,
					supersedes_everything: true,
				});
			}
			return undefined;
		});

		expect(
			supersededBy(fixture, "state-budget-old"),
			"the older budget of a single-valued group stayed open",
		).toBe("state-budget-new");
		expect(
			supersededBy(fixture, "state-stakeholder-epa"),
			"the removed stakeholder stayed open",
		).toBe("state-stakeholder-removed");
		expect(
			supersededBy(fixture, "state-budget-new"),
			"the current budget was closed",
		).toBeNull();
		for (const rowId of ["state-stakeholder-utilities", "state-stakeholder-university"]) {
			expect(
				supersededBy(fixture, rowId),
				`${rowId} was closed although nothing removed it`,
			).toBeNull();
		}
		expect(
			supersededBy(fixture, "profile-unrelated"),
			"a person-profile row was closed by a proposal statement",
		).toBeNull();
	}, 240_000);

	it("never applies the older-episodic no-action rule to a state row", async () => {
		const fixture = prepareFixture();
		await runBothWaves(fixture);
		const episodicNoAction = fixture.runtime.raw
			.prepare(
				"SELECT COUNT(*) AS count FROM nodix_rem_journal WHERE reason = 'episodic_mark_not_built'",
			)
			.get() as { count: number };
		expect(
			episodicNoAction.count,
			"a state pair was parked under the episodic never-close rule, so it can never be closed",
		).toBe(0);
	}, 240_000);
});
