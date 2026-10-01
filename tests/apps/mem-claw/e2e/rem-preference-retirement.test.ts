import { readTestSnoGpuSettings } from "../helpers/settings.ts";
/** @file rem-preference-retirement.test.ts
 * @purpose PRD 110 QCG-4: a stated preference change retires the outdated row, end to end.
 * @boundary Real sidecar process, real encrypted store, real /rem/run entry, live Sno GPU judgement.
 *
 * Everything real. The store is a real encrypted SQLite seeded with the six content_writer rows the
 * defect was measured on (texts and day timestamps from the run store, ids fresh — ids change on
 * every regenerated store). The wave is submitted through the sidecar's ordinary HTTP entry and the
 * result is read back from the store, never from a log line. The judgement model is the live Sno GPU
 * endpoint; a missing key fails, it never skips.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
	seedProductionMemory,
	startRemProductionEntryFixture,
	type ProductionEntryFixture,
} from "../helpers/rem-production-entry-fixture.ts";

const SCOPE = "content_writer_weekly";

// The six rows, as measured 2026-09-04. Day stamps are the conversation days from the run store:
// the war-and-conflict change was stated a week after the original preference.
const DAY_1 = "2026-06-04T08:00:00.000Z";
const DAY_2 = "2026-06-06T08:00:00.000Z";
const DAY_3 = "2026-06-08T08:00:00.000Z";
const OUTDATED = "The user enjoys books that delve into war and conflict.";
const RETIRES_OUTDATED = "The user used to be interested in books about war and conflict.";
const CURRENT_PHILOSOPHY = "The user is currently drawn to books with philosophical themes.";
const RETIRES_PHILOSOPHY = "The user used to really like books about philosophical themes.";
const MODERNISM = "The user likes reading about modernism in books.";
const CURRENT_INDUSTRIAL =
	"The user is finding themselves drawn to books about industrialization lately.";

const fixtures: ProductionEntryFixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) await fixture.stop();
});

function requireLiveJudgementEndpoint(): { gpuBaseUrl: string; llmApiKey: string } {
	const { baseUrl, apiKey } = readTestSnoGpuSettings();
	const gpuBaseUrl = baseUrl.trim();
	const llmApiKey = apiKey.trim();
	if (!gpuBaseUrl || !llmApiKey) {
		throw new Error(
			"live Sno GPU judgement endpoint is required: snoGpu.baseUrl and snoGpu.apiKey must be set in settings.json; this test never skips",
		);
	}
	return { gpuBaseUrl, llmApiKey };
}

async function seedAndRunWave(outdatedTimestamp: string): Promise<{
	fixture: ProductionEntryFixture;
	ids: Record<string, string>;
}> {
	const fixture = await startRemProductionEntryFixture(requireLiveJudgementEndpoint());
	fixtures.push(fixture);
	const raw = fixture.database.runtime.raw;
	const ids = {
		outdated: seedProductionMemory(raw, { scope: SCOPE, text: OUTDATED, timestamp: outdatedTimestamp }),
		retiresOutdated: seedProductionMemory(raw, { scope: SCOPE, text: RETIRES_OUTDATED, timestamp: DAY_2 }),
		currentPhilosophy: seedProductionMemory(raw, { scope: SCOPE, text: CURRENT_PHILOSOPHY, timestamp: DAY_2 }),
		retiresPhilosophy: seedProductionMemory(raw, { scope: SCOPE, text: RETIRES_PHILOSOPHY, timestamp: DAY_3 }),
		modernism: seedProductionMemory(raw, { scope: SCOPE, text: MODERNISM, timestamp: DAY_1 }),
		currentIndustrial: seedProductionMemory(raw, { scope: SCOPE, text: CURRENT_INDUSTRIAL, timestamp: DAY_3 }),
	};
	const submitted = await fixture.submitWave(["rem-update"], SCOPE, `prd110-${randomUUID()}`);
	const identity = String(submitted["waveId"] ?? submitted["wave_id"] ?? submitted["job_id"] ?? "");
	if (identity.length === 0) throw new Error(`wave submission returned no id: ${JSON.stringify(submitted)}`);
	const terminal = await fixture.waitForTerminal(identity, 600_000);
	expect(terminal["state"], `wave ended ${String(terminal["state"])}: ${JSON.stringify(terminal)}`).toBe("done");
	return { fixture, ids };
}

function supersededBy(fixture: ProductionEntryFixture, rowId: string): string | null {
	const row = fixture.database.runtime.raw
		.prepare("SELECT metadata FROM nodix_memories WHERE id = ?")
		.get(rowId) as { metadata: string } | undefined;
	if (row === undefined) throw new Error(`row ${rowId} vanished from the store`);
	const metadata = JSON.parse(row.metadata) as { superseded_by?: unknown };
	return typeof metadata.superseded_by === "string" ? metadata.superseded_by : null;
}

function journalRows(fixture: ProductionEntryFixture, rowId: string): Array<{ stage: string; outcome: string; reason: string | null }> {
	return fixture.database.runtime.raw
		.prepare("SELECT stage, outcome, reason FROM nodix_rem_journal WHERE row_id = ? ORDER BY rowid")
		.all(rowId) as Array<{ stage: string; outcome: string; reason: string | null }>;
}

function wholeJournal(fixture: ProductionEntryFixture): string {
	const rows = fixture.database.runtime.raw
		.prepare("SELECT stage, outcome, reason FROM nodix_rem_journal ORDER BY rowid")
		.all() as Array<{ stage: string; outcome: string; reason: string | null }>;
	return rows.map((row) => `${row.stage} ${row.outcome} ${row.reason ?? ""}`).join(" | ");
}

describe("PRD 110 — a stated preference change retires the outdated row, end to end", () => {
	it(
		"retires the war-and-conflict row by the model's chosen id and leaves the current rows live",
		{ timeout: 900_000 },
		async () => {
			const { fixture, ids } = await seedAndRunWave(DAY_1);
			expect(
				supersededBy(fixture, ids.outdated),
				`the outdated row is still live; its journal: ${JSON.stringify(journalRows(fixture, ids.outdated))}; the retirement row's journal: ${JSON.stringify(journalRows(fixture, ids.retiresOutdated))}; whole wave: ${wholeJournal(fixture)}`,
			).toBe(ids.retiresOutdated);
			// The genuinely current preference (the last change, industrialization) is never touched.
			expect(supersededBy(fixture, ids.currentIndustrial), "the current industrialization row was retired").toBeNull();
			// The philosophy row is the SECOND change's target: "used to really like philosophical
			// themes" retires "currently drawn to philosophical themes". Whether the model names it is
			// its meaning call (measured 2026-09-04: named on one run in three, null on the others);
			// what is never allowed is any OTHER row retiring it.
			expect(
				[null, ids.retiresPhilosophy],
				"the philosophy row was retired by a row other than its own retirement sentence",
			).toContain(supersededBy(fixture, ids.currentPhilosophy));
			// Rows with nothing to retire them stay live.
			expect(supersededBy(fixture, ids.modernism), "the modernism row was retired").toBeNull();
			// The retiring rows themselves stay live: they are evidence, not facts to rewrite.
			expect(supersededBy(fixture, ids.retiresOutdated), "the retirement row itself was retired").toBeNull();
		},
	);

	it(
		"negative half — with the target not older than its retirement row, the apply seam refuses and the row stays live",
		{ timeout: 900_000 },
		async () => {
			// Planted defect at the apply seam: the only candidate the model could name is NEWER than
			// the retirement sentence. The engine's older-only rule then has nothing to offer, or refuses
			// the chosen id immediately before the write. Either way the model's answer is discarded
			// before anything is written, and the journey that passes above must fail here.
			const { fixture, ids } = await seedAndRunWave(DAY_3);
			expect(
				supersededBy(fixture, ids.outdated),
				"a row newer than its retirement sentence was retired; the older-only guard at the apply seam did not hold",
			).toBeNull();
			expect(supersededBy(fixture, ids.currentIndustrial)).toBeNull();
		},
	);
});
