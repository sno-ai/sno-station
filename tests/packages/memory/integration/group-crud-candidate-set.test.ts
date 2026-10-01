import { writeSettingsFixture } from "../fixtures/settings-file-fixture";
/** @file PRD 150 QCG-4, QCG-6, QCG-7 — the candidate set is the subject's group, ranked.
 *
 * @boundary The production REM batch executor over a real SQLite store. The model stage is
 * observed, so every assertion reads what the engine ASKED and what it WROTE, never a stub.
 *
 * The fixture rows are the measured shape of the failure this change repairs. On 2026-09-04, the
 * row that should have closed usually sat under a DIFFERENT attribute than the retiring statement
 * — `preference.travel_style` against `preference.weather` for the climate pair — and the
 * attribute-gated candidate set never offered it. The attribute must rank the group, never gate it.
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

const USER = "user";
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
	subject: string | null;
	attribute: string | null;
	/** Position in the conversation. Higher is later, which is what the order key encodes. */
	turn: number;
	eventAt?: string;
	category?: "profile" | "episodic";
}

function seedRow(database: TestDb["runtime"]["raw"], scope: string, row: SeedRow): void {
	const category = row.category ?? "profile";
	const metadata: Record<string, unknown> = {
		kind: category,
		memory_category: category,
		[category === "profile" ? "section_name" : "topic"]: row.attribute ?? "unkeyed",
		...(row.eventAt === undefined ? {} : { event_at: row.eventAt }),
		// REQ-2's persisted order. Every row shares one `valid_from`, so only the turn separates
		// them — the measured chain in the corpus has three rows on one day.
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
			category,
			scope,
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

function prepareFixture(scope: string): TestDb {
	const fixture = createTestDb();
	const stateRoot = mkdtempSync(join(tmpdir(), `group-crud-${scope.replace(/\W+/g, "-")}-`));
	writeSettingsFixture(stateRoot, { mode: "local-first", store: { path: fixture.dbPath, encryptionKey: fixture.encryptionKey },
		embedding: { cacheDir: "" } });
	process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = fixture.dbPath;
	process.env["SNO_PROFILE_DIR"] = stateRoot;
	cleanups.push(() => {
		fixture.cleanup();
		rmSync(stateRoot, { recursive: true, force: true });
	});
	return fixture;
}

interface Observation {
	stage: string;
	prompt: string;
}

function neutralReplyFor(stage: string): string {
	switch (stage) {
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
		case "rem-replace-clause-carry":
			return JSON.stringify({ already_current: [] });
		default:
			return "{}";
	}
}

interface WaveResult {
	observations: Observation[];
	database: TestDb;
}

async function runWave(
	scope: string,
	rows: readonly SeedRow[],
	replyFor?: (observation: Observation) => string | undefined,
): Promise<WaveResult> {
	const fixture = prepareFixture(scope);
	for (const row of rows) seedRow(fixture.runtime.raw, scope, row);
	const observations: Observation[] = [];
	try {
		await runRemBatchJob({
			jobId: `job-${scope}`,
			jobType: "rem-update",
			scope,
			configuration: parseRemOperationalConfiguration(
				createRemOwnerDecidedOperationalConfiguration(),
			),
			modelStageResponses: createRemModelStageResponsePort({
				respond: async ({ stage, prompt }) => {
					const observation = { stage, prompt };
					observations.push(observation);
					return replyFor?.(observation) ?? neutralReplyFor(stage);
				},
			}),
		});
	} catch (error) {
		// A wave whose every model call is refused throws, which is correct production behaviour and
		// not what this file measures: the evidence is what the engine asked before the refusal.
		const message = error instanceof Error ? error.message : String(error);
		if (!message.startsWith("REM LLM calls all failed")) throw error;
	}
	return { observations, database: fixture };
}

/** One entry per target-stage call: the candidate ids of that batch, in the order offered. */
function offeredBatches(observations: readonly Observation[], nominatedRowId: string): string[][] {
	const batches: string[][] = [];
	for (const observation of observations) {
		if (observation.stage !== "rem-update-retirement-target") continue;
		if (!observation.prompt.includes(`"id":${JSON.stringify(nominatedRowId)}`)) continue;
		const block = observation.prompt
			.split("\n\n")
			.find((part) => part.startsWith("Candidate rows: "));
		if (block === undefined) continue;
		const rows = JSON.parse(block.slice("Candidate rows: ".length)) as Array<{ id: string }>;
		batches.push(rows.map((row) => row.id));
	}
	return batches;
}

function offeredIds(observations: readonly Observation[], nominatedRowId: string): string[] {
	return offeredBatches(observations, nominatedRowId).flat();
}

/** A closed row carries the closing row's id under metadata.superseded_by; a live row carries none. */
function supersededBy(database: TestDb, rowId: string): string | null {
	const row = database.runtime.raw
		.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
		.get(rowId) as { metadata: string } | undefined;
	if (row === undefined) return null;
	const metadata = JSON.parse(row.metadata) as { superseded_by?: unknown };
	return typeof metadata.superseded_by === "string" ? metadata.superseded_by : null;
}

function journalRows(database: TestDb, reason: string): Array<{ rowId: string; detail: string }> {
	return database.runtime.raw
		.prepare("SELECT row_id AS rowId, detail FROM nodix_rem_journal WHERE reason = ?")
		.all(reason) as Array<{ rowId: string; detail: string }>;
}

// ---------------------------------------------------------------------------------------------
// QCG-4 — the attribute ranks the candidate set and never gates it (REQ-4).
// ---------------------------------------------------------------------------------------------

const CLIMATE_RETIRES = "climate-retires";
const CLIMATE_ROWS: SeedRow[] = [
	{
		id: "climate-same-slug",
		text: "The user prefers cold, dry winters.",
		subject: USER,
		attribute: "preference.weather",
		turn: 1,
	},
	{
		id: "climate-same-family",
		text: "The user likes continental climates when they travel.",
		subject: USER,
		attribute: "preference.travel_style",
		turn: 2,
	},
	{
		id: "climate-unkeyed",
		text: "The user enjoys four distinct seasons.",
		subject: USER,
		attribute: null,
		turn: 3,
	},
	{
		id: "climate-other-family",
		text: "The user reads a lot of history.",
		subject: USER,
		attribute: "interest.history",
		turn: 4,
	},
	{
		// Pure negation, one of the two shapes the router nominates for a retirement judgement.
		id: CLIMATE_RETIRES,
		text: "The user does not like continental climates any more.",
		subject: USER,
		attribute: "preference.weather",
		turn: 5,
	},
];

describe("PRD 150 QCG-4 — the attribute ranks the candidate set and never gates it", () => {
	it(
		"offers the whole subject group in same-slug, same-family, unkeyed, other order",
		{ timeout: 120_000 },
		async () => {
			const { observations } = await runWave("persona:group-crud-qcg4-order", CLIMATE_ROWS);
			expect(
				offeredIds(observations, CLIMATE_RETIRES),
				"the whole subject group was not offered in rank order; measured under the planted attribute gate this returns only the same-slug row (evidence/150-planted-defect-reds.md)",
			).toEqual([
				"climate-same-slug",
				"climate-same-family",
				"climate-unkeyed",
				"climate-other-family",
			]);
		},
	);

	it(
		"judges a 17-row subject group in two batches of at most 16, offering every row",
		{ timeout: 180_000 },
		async () => {
			const rows: SeedRow[] = Array.from({ length: 17 }, (_, index) => ({
				id: `bulk-${String(index).padStart(2, "0")}`,
				text: `The user keeps note number ${index} about their reading list.`,
				subject: USER,
				attribute: index % 2 === 0 ? "interest.hobbies" : null,
				turn: index + 1,
			}));
			const nominated = "bulk-retires";
			rows.push({
				id: nominated,
				text: "The user does not keep notes about their reading list any more.",
				subject: USER,
				attribute: "interest.hobbies",
				turn: 100,
			});

			const { observations } = await runWave("persona:group-crud-qcg4-batches", rows);
			const batches = offeredBatches(observations, nominated);
			expect(
				batches.map((batch) => batch.length),
				"17 candidates were not judged in two batches of at most 16",
			).toEqual([16, 1]);
			const offered = new Set(batches.flat());
			for (const row of rows.slice(0, 17)) {
				expect(offered, `row ${row.id} of the subject group was never offered`).toContain(row.id);
			}
		},
	);

	it(
		"keeps asking later batches after an earlier batch's reply is refused",
		{ timeout: 180_000 },
		async () => {
			// 20 open candidates of one subject group span two target batches (16 + 4). The FIRST
			// target batch is refused with invalid JSON; the engine must still ASK the later batch
			// rather than abandon it — otherwise a fact that should close but sits in a later batch is
			// never even offered to the judge.
			const rows: SeedRow[] = Array.from({ length: 20 }, (_, index) => ({
				id: `late-${String(index).padStart(2, "0")}`,
				text: `The user keeps note number ${index} about their reading list.`,
				subject: USER,
				attribute: "interest.hobbies",
				turn: index + 1,
			}));
			const nominated = "late-retires";
			rows.push({
				id: nominated,
				text: "The user does not keep notes about their reading list any more.",
				subject: USER,
				attribute: "interest.hobbies",
				turn: 100,
			});

			let targetCalls = 0;
			const { observations } = await runWave(
				"persona:group-crud-late-batch",
				rows,
				(observation) => {
					if (observation.stage !== "rem-update-retirement-target") return undefined;
					if (!observation.prompt.includes(`"id":${JSON.stringify(nominated)}`)) return undefined;
					targetCalls += 1;
					// Refuse only the first target batch; a later batch, if asked, gets a clean empty
					// answer so the wave runs to the end.
					return targetCalls === 1 ? "not-json" : JSON.stringify({ target_row_ids: [] });
				},
			);

			// The set spans two batches, and BOTH were asked: the refused first batch did not abandon
			// the second. On the pre-fix `break` only the first batch is ever asked.
			const batches = offeredBatches(observations, nominated);
			expect(
				batches.length,
				"a refused earlier batch abandoned the later batches — they were never asked",
			).toBe(2);
		},
	);

	it(
		"omits the lowest-ranked rows past 64, journals the count, and still writes",
		{ timeout: 240_000 },
		async () => {
			// 66 open rows in one subject group. The cap ranks and truncates — REQ-4 forbids refusing.
			const rows: SeedRow[] = Array.from({ length: 66 }, (_, index) => ({
				id: `cap-${String(index).padStart(2, "0")}`,
				text: `The user tracks errand number ${index} for the house move.`,
				subject: USER,
				// The two lowest-ranked rows are the unrelated family, so the cap must drop those.
				attribute: index < 64 ? "routine.chores" : "interest.politics",
				turn: index + 1,
			}));
			const nominated = "cap-retires";
			rows.push({
				id: nominated,
				text: "The user no longer tracks errands for the house move.",
				subject: USER,
				attribute: "routine.chores",
				turn: 200,
			});

			const { observations, database } = await runWave("persona:group-crud-qcg4-cap", rows);
			const offered = offeredIds(observations, nominated);
			expect(offered, "the per-group cap did not truncate at 64 candidates").toHaveLength(64);
			// "Lowest-ranked omitted": the two `interest.politics` rows rank last of the group, so a
			// cap that cut the top of the sort instead would pass the count and fail here.
			expect(offered, "the cap dropped a higher-ranked row than cap-64").not.toContain("cap-64");
			expect(offered, "the cap dropped a higher-ranked row than cap-65").not.toContain("cap-65");
			expect(offered, "the highest-ranked row of the group was cut").toContain("cap-00");
			const truncation = journalRows(database, "candidate_cap_truncated");
			expect(truncation, "the truncation was not journalled").toHaveLength(1);
			expect(truncation[0].rowId).toBe(nominated);
			expect(
				(JSON.parse(truncation[0].detail) as { omittedCount: number }).omittedCount,
				"the journal line does not name how many rows were omitted",
			).toBe(2);
			// The wave ran to the end rather than refusing: every row of the group is still open.
			expect(supersededBy(database, "cap-00")).toBeNull();
		},
	);

	it(
		"offers similarity candidates only when the statement has no subject",
		{ timeout: 120_000 },
		async () => {
			// Nothing keys this statement, so there is no group to read. Every older row of the scope
			// is a candidate — including rows of another subject, which a group read would never offer.
			const nominated = "subjectless-retires";
			const { observations } = await runWave("persona:group-crud-qcg4-subjectless", [
				{
					id: "other-subject-row",
					text: "The agent keeps the release checklist for the team.",
					subject: "agent",
					attribute: null,
					turn: 1,
				},
				{
					id: "user-row",
					text: "The user keeps a paper notebook for the release checklist.",
					subject: USER,
					attribute: "routine.chores",
					turn: 2,
				},
				{
					id: nominated,
					text: "The release checklist is no longer kept on paper.",
					subject: null,
					attribute: null,
					turn: 3,
				},
			]);
			const offered = offeredIds(observations, nominated);
			expect(
				offered,
				"a subjectless statement was offered nothing, so no judgement could reach any row",
			).toContain("other-subject-row");
			expect(offered).toContain("user-row");
		},
	);
});

// ---------------------------------------------------------------------------------------------
// QCG-6 — a single-valued attribute closes its group mechanically (REQ-6).
// ---------------------------------------------------------------------------------------------

/** `identity.hometown` is one of the seven slugs the owner ruled single-valued. */
const HOMETOWN_NOMINATED = "home-now";
function hometownRows(attribute: string): SeedRow[] {
	return [
		{ id: "home-first", text: "The user's home town is Leeds.", subject: USER, attribute, turn: 1 },
		{ id: "home-second", text: "The user's home town is York.", subject: USER, attribute, turn: 2 },
		{ id: "home-third", text: "The user's home town is Hull.", subject: USER, attribute, turn: 3 },
		{
			id: "home-sibling",
			text: "The user grew up near the Yorkshire coast.",
			subject: USER,
			attribute: null,
			turn: 4,
		},
		{
			id: HOMETOWN_NOMINATED,
			text: "The user moved from Hull to Bristol, which is now their home town.",
			subject: USER,
			attribute,
			turn: 5,
		},
	];
}

describe("PRD 150 QCG-6 — a single-valued attribute closes its group mechanically", () => {
	it(
		"closes all three smaller-order rows with a journal line each, and offers the sibling to the model",
		{ timeout: 120_000 },
		async () => {
			const { observations, database } = await runWave(
				"persona:group-crud-qcg6-one",
				hometownRows("identity.hometown"),
			);

			for (const rowId of ["home-first", "home-second", "home-third"]) {
				expect(
					supersededBy(database, rowId),
					`${rowId} of a single-valued group stayed open, or was closed by the wrong row`,
				).toBe(HOMETOWN_NOMINATED);
			}
			// One journal line per close. The line is filed under the closing row, and its detail
			// names which row it closed — that pair is what makes the close attributable later.
			const closes = journalRows(database, "cardinality_one");
			expect(closes, "the mechanical closes were not journalled one line per close").toHaveLength(
				3,
			);
			expect(
				closes
					.map((row) => (JSON.parse(row.detail) as { targetRowId: string }).targetRowId)
					.sort(),
				"the journal lines do not name the three rows that were closed",
			).toEqual(["home-first", "home-second", "home-third"]);
			for (const close of closes) expect(close.rowId).toBe(HOMETOWN_NOMINATED);

			// The unkeyed sibling is judged like any other row, and stays open when nobody names it.
			expect(
				offeredIds(observations, HOMETOWN_NOMINATED),
				"the unkeyed sibling was not offered to the judgement",
			).toContain("home-sibling");
			expect(
				supersededBy(database, "home-sibling"),
				"an unkeyed sibling was closed mechanically instead of being judged",
			).toBeNull();
		},
	);

	it("closes the offered sibling once the model names it", { timeout: 120_000 }, async () => {
		const { database } = await runWave(
			"persona:group-crud-qcg6-named",
			hometownRows("identity.hometown"),
			(observation) => {
				if (observation.stage === "rem-update-retirement-target") {
					return JSON.stringify({ target_row_ids: ["home-sibling"] });
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
			supersededBy(database, "home-sibling"),
			"the model named the sibling and it was not closed",
		).toBe(HOMETOWN_NOMINATED);
	});

	it(
		"with a many-valued attribute the same statement offers all four and closes none mechanically",
		{ timeout: 120_000 },
		async () => {
			// `preference.food` carries no `one` ruling, so nothing may close without a model naming it.
			const { observations, database } = await runWave(
				"persona:group-crud-qcg6-many",
				hometownRows("preference.food"),
			);
			expect(
				offeredIds(observations, HOMETOWN_NOMINATED).sort(),
				"a many-valued group did not offer all four rows to the judgement",
			).toEqual(["home-first", "home-second", "home-sibling", "home-third"]);
			expect(
				journalRows(database, "cardinality_one"),
				"a many-valued attribute closed rows mechanically",
			).toEqual([]);
			for (const rowId of ["home-first", "home-second", "home-third", "home-sibling"]) {
				expect(
					supersededBy(database, rowId),
					`${rowId} was closed with no model naming it`,
				).toBeNull();
			}
		},
	);
});

// ---------------------------------------------------------------------------------------------
// QCG-7 — an event is only ever compared with the same day (REQ-7).
// ---------------------------------------------------------------------------------------------

const COFFEE_CORRECTION = "coffee-day1-correction";
const COFFEE_ROWS: SeedRow[] = [
	{
		id: "coffee-day1-a",
		text: "The user spent $4.20 on coffee.",
		subject: USER,
		attribute: null,
		category: "episodic",
		eventAt: "2026-09-01T09:00:00.000Z",
		turn: 1,
	},
	{
		id: "coffee-day1-b",
		text: "The user spent $5.10 on lunch.",
		subject: USER,
		attribute: null,
		category: "episodic",
		eventAt: "2026-09-01T13:00:00.000Z",
		turn: 2,
	},
	{
		id: "coffee-day2",
		text: "The user spent $3.90 on coffee.",
		subject: USER,
		attribute: null,
		category: "episodic",
		eventAt: "2026-09-02T09:00:00.000Z",
		turn: 3,
	},
	{
		id: COFFEE_CORRECTION,
		text: "The user's coffee spend was updated from $4.20 to $4.60.",
		subject: USER,
		attribute: null,
		category: "episodic",
		eventAt: "2026-09-01T18:00:00.000Z",
		turn: 4,
	},
];

describe("PRD 150 QCG-7 — an event is only ever compared with the same day", () => {
	it(
		"offers the same-day rows only, and never the next day's purchase",
		{ timeout: 120_000 },
		async () => {
			const { observations, database } = await runWave(
				"persona:group-crud-qcg7-sameday",
				COFFEE_ROWS,
			);
			const offered = offeredIds(observations, COFFEE_CORRECTION);
			expect(offered, "a same-day row was not offered to the correction").toContain(
				"coffee-day1-a",
			);
			expect(offered, "a same-day row was not offered to the correction").toContain(
				"coffee-day1-b",
			);
			expect(
				offered,
				"a purchase from another day was offered — an event group must not cross dates; measured under the planted date-crossing defect this row is offered (evidence/150-planted-defect-reds.md)",
			).not.toContain("coffee-day2");
			expect(
				supersededBy(database, "coffee-day2"),
				"a purchase from another day was closed by a same-day correction",
			).toBeNull();
		},
	);

	it(
		"a same-day correction closes exactly the row the model names",
		{ timeout: 120_000 },
		async () => {
			const { database } = await runWave(
				"persona:group-crud-qcg7-named",
				COFFEE_ROWS,
				(observation) => {
					if (observation.stage === "rem-update-retirement-target") {
						return JSON.stringify({ target_row_ids: ["coffee-day1-a"] });
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
				supersededBy(database, "coffee-day1-a"),
				"the named same-day row was not closed by the correction",
			).toBe(COFFEE_CORRECTION);
			expect(
				supersededBy(database, "coffee-day1-b"),
				"a same-day row the model did not name was closed anyway",
			).toBeNull();
			expect(
				supersededBy(database, "coffee-day2"),
				"the next day's purchase was closed by a same-day correction",
			).toBeNull();
		},
	);

	it("a plain third same-day purchase closes nothing", { timeout: 120_000 }, async () => {
		const { database } = await runWave("persona:group-crud-qcg7-plain", [
			...COFFEE_ROWS.filter((row) => row.id !== COFFEE_CORRECTION),
			{
				id: "coffee-day1-c",
				text: "The user spent $6.00 on coffee.",
				subject: USER,
				attribute: null,
				category: "episodic",
				eventAt: "2026-09-01T16:00:00.000Z",
				turn: 4,
			},
		]);
		for (const rowId of ["coffee-day1-a", "coffee-day1-b", "coffee-day2", "coffee-day1-c"]) {
			expect(
				supersededBy(database, rowId),
				`${rowId} was closed by a purchase that states nothing about it`,
			).toBeNull();
		}
	});
});
