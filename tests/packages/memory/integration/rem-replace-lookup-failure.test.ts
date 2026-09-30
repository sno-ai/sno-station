/** @file rem-replace-lookup-failure.test.ts
 * @purpose Proves a failed candidate lookup is retried once and never stops the other rows from being judged.
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

async function build(failingRow?: string, failures = Number.POSITIVE_INFINITY) {
	const embedCalls: string[] = [];
	let failed = 0;
	const queue = await buildRemReplaceCandidateQueue({
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
				embedCalls.push(text);
				if (
					failingRow !== undefined &&
					text.endsWith(`option ${failingRow.slice(-1)}.`) &&
					failed < failures
				) {
					failed += 1;
					throw new Error("embedder failure");
				}
				return new Float32Array([1, 0]);
			},
			readVectors: () => new Map(),
			searchSemantic: async () => [],
		},
	});
	return { queue, embedCalls };
}

describe("REM replace candidate queue", () => {
	it("builds every address pair when all lookups finish", async () => {
		const { queue, embedCalls } = await build();
		expect(queue.pairs).toHaveLength(3);
		expect(embedCalls).toHaveLength(3);
	});

	it("looks a row up again once after a single failure and keeps the queue", async () => {
		const { queue, embedCalls } = await build("row-b", 1);
		expect(queue.pairs).toHaveLength(3);
		expect(embedCalls).toHaveLength(4);
	});

	it("gives up on a row after two failures and still builds the queue for the others", async () => {
		const { queue, embedCalls } = await build("row-b");
		expect(queue.pairs).toHaveLength(3);
		expect(embedCalls).toHaveLength(4);
	});
});
