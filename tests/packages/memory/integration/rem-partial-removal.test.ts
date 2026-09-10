/** @file rem-partial-removal.test.ts
 * @purpose A removal that names ONE item of a multi-item row rewrites the row; it must not close it.
 * @boundary Production REM batch executor over a real SQLite store; the model stages are stand-ins.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createRemModelStageResponsePort,
	runRemBatchJob,
} from "../../../../apps/mem-claw/src/sidecar/rem-batch-executor.ts";
import { parseRemOperationalConfiguration } from "../../../../packages/rem-core/src/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../helpers/rem-entry-config-fixture.ts";
import { seedProductionMemory } from "../helpers/rem-production-entry-fixture.ts";
import { createTestDb, type TestDb } from "../helpers/test-db.ts";

// Measured 2026-09-04, content_writer session 30 then session 80: the store holds the first row
// live and untouched after the second is stated, and the answer lists both directors as current.
const RECIPIENTS =
	"The recipients of the email to introduce optimized content workflow strategies are Creative Directors and Regional Sales Directors.";
const REMOVAL = "The user has removed 'Regional Sales Directors' from the recipient list.";
const REWRITTEN =
	"The recipients of the email to introduce optimized content workflow strategies are Creative Directors.";

const priorEnvironment = {
	MEM_CLAW_DATA_DIR_ROOT: process.env["MEM_CLAW_DATA_DIR_ROOT"],
	MEM_CLAW_REM_EXPECTED_DB_PATH: process.env["MEM_CLAW_REM_EXPECTED_DB_PATH"],
	OPENCLAW_STATE_DIR: process.env["OPENCLAW_STATE_DIR"],
};
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	for (const [key, value] of Object.entries(priorEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("a partial removal rewrites the row it names", () => {
	it(
		"drops the named item and keeps the rest live, instead of closing the whole row",
		{ timeout: 60_000 },
		async () => {
			const scope = "persona:rem-partial-removal";
			const fixture = prepareBatchFixture(scope);
			const raw = fixture.runtime.raw;
			seedProductionMemory(raw, { id: "recipients", scope, text: RECIPIENTS, timestamp: "2026-06-02T08:00:00.000Z" });
			seedProductionMemory(raw, { id: "removal", scope, text: REMOVAL, timestamp: "2026-06-04T08:00:00.000Z" });
			const stages: string[] = [];
			try {
				await runRemBatchJob({
					jobId: `job-${scope}`,
					jobType: "rem-update",
					scope,
					configuration: parseRemOperationalConfiguration(
						createRemOwnerDecidedOperationalConfiguration(),
					),
					modelStageResponses: createRemModelStageResponsePort({
						// The model, asked each question, answers the way the corpus reads: the removal
						// names the recipients row; only one recipient is retired; the rest survive.
						respond: async ({ stage }) => {
							stages.push(stage);
							switch (stage) {
								case "rem-update-retirement-target":
									return JSON.stringify({ target_row_ids: ["recipients"] });
								case "rem-update-relation-judgment":
									return JSON.stringify({
										supersedes: true,
										retires_anything: true,
										supersedes_everything: false,
									});
								case "rem-update-judgment":
									return JSON.stringify({
										proposed_current: REWRITTEN,
										retired_values: ["Regional Sales Directors"],
									});
								case "rem-update-verification":
									return JSON.stringify({
										faithful: true,
										retired_absent: true,
										all_facts_accounted: true,
									});
								default:
									return "{}";
							}
						},
					}),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.startsWith("REM LLM calls all failed")) throw error;
			}
			const row = raw
				.prepare("SELECT text, metadata FROM nodix_memories WHERE id = 'recipients'")
				.get() as { text: string; metadata: string };
			const metadata = JSON.parse(row.metadata) as { superseded_by?: unknown };
			expect(
				metadata.superseded_by,
				`the whole recipients row was closed for a one-name removal; stages: ${JSON.stringify(stages)}`,
			).toBeUndefined();
			expect(row.text, "the removed name is still in the row").not.toContain("Regional Sales Directors");
			expect(row.text, "the surviving recipient was lost").toContain("Creative Directors");
		},
	);
});

function prepareBatchFixture(scope: string): TestDb {
	const fixture = createTestDb();
	const stateRoot = mkdtempSync(join(tmpdir(), `rem-partial-${scope.replace(/\W+/g, "-")}-`));
	writeFileSync(
		join(stateRoot, "openclaw.json"),
		JSON.stringify({
			plugins: {
				entries: {
					"sno-mem-claw": {
						config: { dbPath: fixture.dbPath, embedding: { dimensions: 1024, provider: "local-onnx" } },
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
