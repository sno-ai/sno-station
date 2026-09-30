/** @file rem-replace-lookup-failure.test.ts
 * @purpose Proves a replace queue is not built while a candidate lookup has failed.
 * @boundary Real REM repository over one real SQLite database; the lookup port is the only fake.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRemReplaceCandidateQueue } from "../../../../packages/memory/src/sidecar/rem-batch-executor.ts";
import {
	createRemRepository,
	installRemSchema,
	parseRemOperationalConfiguration,
	type RemRepository,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import { createRemOwnerDecidedOperationalConfiguration } from "../../../apps/mem-claw/helpers/rem-entry-config-fixture.ts";
import { createTestDb, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

let fixture: TestDb;
let repository: RemRepository;

beforeEach(() => {
	fixture = createTestDb();
	installRemSchema(fixture.runtime.db);
	repository = createRemRepository(fixture.runtime.db);
});

afterEach(() => fixture.cleanup());

function candidates() {
	return ["a", "b", "c"].map((name) => ({
		id: `row-${name}`,
		text: `The researcher prefers storage option ${name}.`,
		category: "profile" as const,
		project_id: "persona:lookup-failure",
		subject: null,
		canonicalAddress: "profile:preferences.storage",
	}));
}

async function build(failingRow?: string) {
	return buildRemReplaceCandidateQueue({
		candidates: candidates(),
		configuration: parseRemOperationalConfiguration({
			...createRemOwnerDecidedOperationalConfiguration(),
			budgets: { maxPairs: 10 },
			retrieval: { neighborLimit: 10, similarityThreshold: 1 },
		}),
		repository,
		jobId: `lookup-failure-${failingRow ?? "none"}`,
		snapshotWatermark: "snapshot",
		lookup: {
			embed: async (text) => {
				if (failingRow !== undefined && text.endsWith(`option ${failingRow.slice(-1)}.`)) {
					throw new Error("transient embedder failure");
				}
				return new Float32Array([1, 0]);
			},
			readVectors: () => new Map(),
			searchSemantic: async () => [],
		},
	});
}

describe("REM replace candidate queue", () => {
	it("builds every address pair when all lookups finish", async () => {
		expect((await build()).pairs).toHaveLength(3);
	});

	it("builds no queue while one lookup has failed, so the failed row is looked up again next run", async () => {
		expect((await build("row-b")).pairs).toEqual([]);
	});
});
