import { writeTestInstallationConfig } from "../../../apps/mem-claw/helpers/module-config-fixture";
/** REM retirement ranks real stored candidates even when newer rows fill the project search. */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../packages/memory/src/sidecar/rem-batch-executor";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { parseRemOperationalConfiguration } from "../../../../packages/memory/src/engine/rem/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const SCOPE = "persona:rem-retirement-scoring";
const NOMINATED_ID = "tea-retirement";
const TARGET_ID = "z-oldest-tea";
const NOMINATED_TEXT = "The user no longer drinks tea in the mornings.";
const BASE_TIME = Date.UTC(2026, 8, 1);
const CANDIDATE_COUNT = 65;
const priorEnvironment = {
	MEM_CLAW_DATA_DIR_ROOT: process.env["MEM_CLAW_DATA_DIR_ROOT"],
	SNO_STATION_MEM_REM_EXPECTED_DB_PATH: process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"],
	SNO_PROFILE_DIR: process.env["SNO_PROFILE_DIR"],
};
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const [name, value] of Object.entries(priorEnvironment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function seedRow(
	database: TestDb,
	row: { id: string; text: string; subject: string; turn: number },
): void {
	const metadata = JSON.stringify({
		kind: "profile",
		memory_category: "profile",
		section_name: "preference.beverage",
		source_order: {
			valid_from: BASE_TIME,
			session_ordinal: 0,
			global_turn_index: row.turn,
			rowid: row.turn,
		},
	});
	database.runtime.raw.prepare(`
		INSERT INTO nodix_memories(
			id, text, category, project_id, importance, timestamp, timezone, metadata,
			content_hash, fact_id, lane, raw_candidate_json, subject, attribute, valid_from
		) VALUES (?, ?, 'profile', ?, 0.9, ?, 'UTC', ?, ?, ?, 'active', ?, ?, ?, ?)
	`).run(
		row.id, row.text, SCOPE, BASE_TIME + row.turn, metadata,
		createHash("sha256").update(row.text).update(metadata).digest("hex"),
		`fact-${row.id}`, JSON.stringify({ evidence: row.text }), row.subject,
		"preference.beverage", BASE_TIME,
	);
}

it("offers and closes the oldest candidate despite newer distractors beyond the subject cap", {
	timeout: 300_000,
}, async () => {
	const fixture = createTestDb();
	cleanups.push(() => fixture.cleanup());
	const stateRoot = mkdtempSync(join(tmpdir(), "rem-retirement-scoring-"));
	cleanups.push(() => rmSync(stateRoot, { recursive: true, force: true }));
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
	process.env["MEM_CLAW_DATA_DIR_ROOT"] = dirname(fixture.dbPath);
	process.env["SNO_STATION_MEM_REM_EXPECTED_DB_PATH"] = fixture.dbPath;
	process.env["SNO_PROFILE_DIR"] = stateRoot;

	// The best semantic match sorts last by id, outside the 64-row cap if it loses its score.
	seedRow(fixture, {
		id: TARGET_ID, text: "The user drinks tea every morning.", subject: "user", turn: 1,
	});
	for (let index = 1; index < CANDIDATE_COUNT; index += 1) {
		seedRow(fixture, {
			id: `a-stamps-${String(index).padStart(2, "0")}`,
			text: `The user collects vintage postage stamps in album number ${index}.`,
			subject: "user", turn: index + 1,
		});
	}
	seedRow(fixture, {
		id: NOMINATED_ID, text: NOMINATED_TEXT, subject: "user", turn: CANDIDATE_COUNT + 1,
	});
	const distractorIds = new Set<string>();
	for (let index = 0; index < CANDIDATE_COUNT; index += 1) {
		const id = `distractor-${index}`;
		distractorIds.add(id);
		seedRow(fixture, {
			id, text: NOMINATED_TEXT, subject: `entity:cafe-${index}`,
			turn: CANDIDATE_COUNT + 2 + index,
		});
	}

	const embedder = await createTestEmbedder();
	const store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	try {
		// Populate chunks through the store's real legacy-row backfill before the REM wave opens it.
		store.startLegacyChunkBackfill();
		await store.backfillPromise;
		expect(store.backfillComplete).toBe(true);
		const matches = await store.searchSemantic(await embedder.embed(NOMINATED_TEXT), {
			category: "profile", limit: CANDIDATE_COUNT, minScore: 0,
			projectIdFilter: [SCOPE], excludeMemoryIds: [NOMINATED_ID],
		});
		expect(matches).toHaveLength(CANDIDATE_COUNT);
		for (const match of matches) expect(distractorIds).toContain(match.entry.id);
	} finally {
		await store.close();
	}

	const offered: string[] = [];
	await runRemBatchJob({
		jobId: "job-rem-retirement-scoring", jobType: "rem-update", scope: SCOPE,
		configuration: parseRemOperationalConfiguration(
			createRemOwnerDecidedOperationalConfiguration(),
		),
		modelStageResponses: createRemModelStageResponsePort({
			respond: async ({ stage, prompt }) => {
				if (stage === "rem-update-retirement-target") {
					const nominated = `Nominated row: ${JSON.stringify({
						id: NOMINATED_ID, text: NOMINATED_TEXT,
					})}`;
					if (!prompt.split("\n\n").includes(nominated)) {
						return JSON.stringify({ target_row_ids: [] });
					}
					const block = prompt.split("\n\n")
						.find((part) => part.startsWith("Candidate rows: "));
					if (block === undefined) throw new Error("retirement prompt has no candidate rows");
					const rows = JSON.parse(block.slice("Candidate rows: ".length)) as Array<{
						id: string;
					}>;
					const ids = rows.map(({ id }) => id);
					offered.push(...ids);
					return JSON.stringify({ target_row_ids: ids.includes(TARGET_ID) ? [TARGET_ID] : [] });
				}
				if (stage === "rem-update-relation-judgment") {
					return JSON.stringify({
						supersedes: true,
						retires_anything: true,
						supersedes_everything: true,
					});
				}
				if (stage === "rem-update-judgment") {
					return JSON.stringify({ proposed_current: "", retired_values: [] });
				}
				if (stage === "rem-update-verification") {
					return JSON.stringify({
						faithful: true,
						retired_absent: true,
						all_facts_accounted: true,
					});
				}
				return "{}";
			},
		}),
	});

	expect.soft(offered, "the oldest tea candidate never reached the retirement model")
		.toContain(TARGET_ID);
	const target = fixture.runtime.raw.prepare(
		"SELECT json_extract(metadata, '$.superseded_by') AS closedBy FROM nodix_memories WHERE id = ?",
	).get(TARGET_ID) as { closedBy: string | null };
	expect(target.closedBy, "the oldest tea candidate stayed open").toBe(NOMINATED_ID);
});
