/** @file rem-update-rerun-is-noop.test.ts
 * @purpose Freezes ACC-2 at the installed sno station REM boundary.
 * @boundary Installed CLI, loopback sidecar, encrypted SQLite, ONNX, signed manifest, and Sno GPU.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createTestEmbedder } from "../helpers/test-db.ts";
import { RemRoundtripHarness } from "./rem-roundtrip-harness.ts";

const weeklySessionPath = resolve(
	import.meta.dirname,
	"../../../../evals/memora/data/weekly/academic_researcher/conversations/session_0013.json",
);

let embedder: Embedder;
let harness: RemRoundtripHarness;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

afterEach(async () => {
	await harness?.close();
});

describe("ACC-2 installed REM update replay", () => {
	it("keeps the encrypted row and facets byte-identical on the second pass", { timeout: 120_000 }, async () => {
		harness = await RemRoundtripHarness.create(embedder);
		const session = JSON.parse(readFileSync(weeklySessionPath, "utf8")) as {
			date: string;
			operation_details: {
				content_data: { project_title: string; budget: number };
				memory_updates: Array<{
					field: string;
					updated_from?: number;
					updated_to?: number;
				}>;
			};
		};
		const budgetUpdate = session.operation_details.memory_updates.findLast(
			(update) => update.field === "budget",
		);
		expect(budgetUpdate?.updated_from).toBeTypeOf("number");
		expect(budgetUpdate?.updated_to).toBe(session.operation_details.content_data.budget);
		const currentBudget = `$${budgetUpdate?.updated_to?.toLocaleString("en-US")}`;
		const retiredBudget = `$${budgetUpdate?.updated_from?.toLocaleString("en-US")}`;
		const rowId = await harness.seedMemory({
			content: `Project '${session.operation_details.content_data.project_title}' currently has a budget of ${currentBudget}, updated from ${retiredBudget} on ${session.date}.`,
		});

		const first = await harness.runJob("rem-update");
		const afterFirst = harness.readMemoryPayload(rowId);
		const second = await harness.runJob("rem-update");
		const afterSecond = harness.readMemoryPayload(rowId);

		expect(first.operations).toBe(1);
		expect(second.operations).toBe(0);
		expect(afterSecond).toEqual(afterFirst);
		expect(harness.readJobJournal(second.jobId)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "already_stamped", actions_applied: 0 }),
			]),
		);
	});
});
