/** @file rem-activation-trigger-foundations.test.ts
 * @purpose Proves automatic REM scope enumeration uses the engine's exact candidate population.
 * @boundary Real encrypted SQLite and the production candidate SQL; no storage mock.
 * @acceptance ACC-21
 * @class repair
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	enumerateRemCandidateScopes,
	readCandidates,
} from "../../../../packages/sno-station-mem/src/sidecar/rem-batch-executor.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

describe("REM automatic trigger foundations", () => {
	let database: TestDb | undefined;

	afterEach(() => {
		database?.cleanup();
		database = undefined;
	});

	it("ACC-21 groups candidate-bearing scopes with the same predicate as readCandidates", () => {
		database = createTestDb();
		const rows = [
			candidate("a-1", "scope-a", "profile", "active", "Alpha preference", "{}"),
			candidate("a-2", "scope-a", "episodic", "active", "Alpha event", "{}"),
			candidate("b-1", "scope-b", "profile", "active", "Beta preference", "{}"),
			candidate("parked", "scope-c", "profile", "parked", "Parked row", "{}"),
			candidate("empty", "scope-c", "profile", "active", "   ", "{}"),
			candidate("category", "scope-c", "task", "active", "Task row", "{}"),
			candidate("metadata", "scope-c", "profile", "active", "Invalid metadata", "{"),
			candidate(
				"superseded",
				"scope-c",
				"profile",
				"active",
				"Superseded row",
				JSON.stringify({ superseded_by: "successor" }),
			),
		];
		const insert = database.runtime.raw.prepare(
			`INSERT INTO nodix_memories(
				id, text, category, project_id, importance, timestamp, timezone, metadata,
				content_hash, fact_id, lane, raw_candidate_json
			) VALUES (?, ?, ?, ?, 0.8, ?, 'UTC', ?, ?, ?, ?, '{}')`,
		);
		for (const row of rows) insert.run(...row);

		const grouped = enumerateRemCandidateScopes(database.runtime.db);
		expect(grouped).toEqual([
			{ scope: "scope-a", candidateCount: 2 },
			{ scope: "scope-b", candidateCount: 1 },
		]);
		for (const item of grouped) {
			expect(readCandidates(database.runtime.db, item.scope)).toHaveLength(item.candidateCount);
		}
	});
});

function candidate(
	id: string,
	scope: string,
	category: string,
	lane: string,
	text: string,
	metadata: string,
): [string, string, string, string, number, string, string, string, string] {
	return [
		id,
		text,
		category,
		scope,
		Date.parse("2026-08-12T00:00:00.000Z"),
		metadata,
		createHash("sha256").update(`${id}:${text}`).digest("hex"),
		`fact-${id}`,
		lane,
	];
}
