import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import validTimePair from "../../../../packages/memory/fixtures/rem-replace-valid-time-pair.json" with {
	type: "json",
};
import { createTestEmbedder } from "../helpers/test-db.ts";
import { RemRoundtripHarness } from "./rem-roundtrip-harness.ts";

let embedder: Embedder;
let harness: RemRoundtripHarness;

const uncertainPair = {
	current:
		"Exactly one of the current Atlas checkout and billing workloads uses the green gateway; the specific workload is unspecified.",
	stale:
		"Atlas routes checkout requests through the blue gateway. Atlas routes billing requests through the blue gateway.",
};
const reopenPair = {
	current: "The current Atlas endpoint is https://atlas.example/v2.",
	stale: "The current Atlas endpoint is https://atlas.example/v1.",
};
const cliActionPair = {
	current: "The current Atlas release train is comet.",
	stale: "The current Atlas release train is aurora.",
};

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

beforeEach(async () => {
	harness = await RemRoundtripHarness.create(embedder);
});

afterEach(async () => {
	await harness.close();
});

describe("section 6a REM replace installed-CLI round trips", () => {
	test("rem-replace-seeded-pairs-are-candidate-eligible", async () => {
		const fixtures = [
			{ caseName: "uncertain", ...uncertainPair },
			{ caseName: "reopen", ...reopenPair },
			{ caseName: "cli-trigger-action", ...cliActionPair },
		] as const;
		const diagnostics = [];
		for (const fixture of fixtures) {
			const pair = await harness.seedProfilePair(fixture.caseName, fixture);
			diagnostics.push({
				caseName: fixture.caseName,
				rows: harness.readReplaceCandidateDiagnostics([pair.staleId, pair.currentId]),
			});
		}
		console.info(`[rem-replace-candidate-discriminator] ${JSON.stringify(diagnostics)}`);

		for (const diagnostic of diagnostics) {
			expect(diagnostic.rows.map((row) => row.candidateFilter)).toEqual([
				"eligible",
				"eligible",
			]);
			expect(new Set(diagnostic.rows.map((row) => row.canonicalAddress)).size).toBe(1);
			expect(new Set(diagnostic.rows.map((row) => row.category)).size).toBe(1);
		}
	});

	test("rem-replace-roundtrip-close-stale", { timeout: 35_000 }, async () => {
		const pair = await harness.seedProfilePair("close-stale", {
			current: "The current Atlas deployment region is us-west-2.",
			stale: "The current Atlas deployment region is us-east-1.",
		});
		await harness.runJob("rem-replace");
		const stale = harness.getMemory(pair.staleId);
		const current = harness.getMemory(pair.currentId);

		expect(
			parseMetadata(stale?.metadata)["superseded_by"],
			"only stale row must close",
		).toBe(pair.currentId);
		expect(parseMetadata(current?.metadata)["superseded_by"]).toBeUndefined();
		expect(stale?.id).toBe(pair.staleId);
		expect(current?.id).toBe(pair.currentId);
	});

	test("rem-replace-roundtrip-keep", { timeout: 35_000 }, async () => {
		const pair = await harness.seedProfilePair("keep", {
			current: "Atlas production uses PostgreSQL for durable records.",
			stale: "Atlas production uses Redis for short-lived cache entries.",
		});
		const before = [
			harness.readMemoryPayload(pair.staleId),
			harness.readMemoryPayload(pair.currentId),
		];
		await harness.runJob("rem-replace");
		const pairRows = harness.readSnapshot(pair.staleId).scanPairs;

		expect(pairRows, "keep verdict must be durably recorded").toEqual(
			expect.arrayContaining([
				expect.objectContaining({ actions_applied: 0, verdict: "keep" }),
			]),
		);
		expect([
			harness.readMemoryPayload(pair.staleId),
			harness.readMemoryPayload(pair.currentId),
		]).toEqual(before);
	});

	test("rem-replace-roundtrip-pure-negation", { timeout: 35_000 }, async () => {
		const rowId = await harness.seedMemory({
			content: "The user no longer prefers the Atlas legacy endpoint.",
		});
		const before = harness.readSnapshot(rowId);
		await harness.runJob("rem-replace");
		const after = harness.readSnapshot(rowId);

		expect(
			after.ledger,
			"pure negation must stay owned by neither REM action",
		).toEqual([
			expect.objectContaining({ owner: "none", state: "pure-negation" }),
		]);
		expect(after.row).toEqual(before.row);
		expect(after.facets).toEqual(before.facets);
		expect(after.chunks).toEqual(before.chunks);
	});

	test("rem-replace-roundtrip-episodic-mark", { timeout: 35_000 }, async () => {
		const staleId = await harness.seedMemory({
			category: "episodic",
			content: "The current Atlas incident commander is Morgan.",
			metadata: { valid_from: Date.parse("2026-07-01T00:00:00.000Z") },
		});
		await harness.seedMemory({
			category: "episodic",
			content: "The current Atlas incident commander is Riley.",
			metadata: { valid_from: Date.parse("2026-07-02T00:00:00.000Z") },
		});
		const before = harness.readSnapshot(staleId);
		await harness.runJob("rem-replace");
		const after = harness.readSnapshot(staleId);

		// An episodic pair resolves to the F5 mark, and that action is parked pending an
		// owner ruling (30-episodic-expiring-prd.md, held since 2026-08-01). Until it lands the
		// verdict is journaled and nothing is applied — a designed no-action, and the
		// journal must name it so a reader cannot mistake it for a silent one.
		expect(
			after.scanPairs,
			"an episodic pair must close with its verdict recorded and no action applied",
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					actions_applied: 0,
					progress_state: "closed",
					verdict: "replacement",
				}),
			]),
		);
		expect(
			harness.readJobJournal().some((row) => row["reason"] === "episodic_mark_not_built"),
			"the parked episodic mark must name itself in the journal",
		).toBe(true);
		expect(after.row).toEqual(before.row);
		expect(
			parseMetadata(String(after.row?.["metadata"]))["superseded_by"],
		).toBeUndefined();
	});

	test("rem-replace-roundtrip-reopen", { timeout: 35_000 }, async () => {
		const pair = await harness.seedProfilePair("reopen", reopenPair);
		await harness.runJob("rem-replace");
		const closed = harness.readSnapshot(pair.staleId);
		const scan = findPairScan(closed.scanPairs, pair);
		if (!scan) {
			throw new Error("UNINSTANTIATED: reopen produced no pair decision");
		}
		console.info(`[rem-replace-reopen-verdict] ${JSON.stringify(scan)}`);
		if (scan["verdict"] !== "replacement") {
			throw new Error(`UNINSTANTIATED: reopen requires replacement, got ${String(scan["verdict"])}`);
		}
		const actionsApplied = Number(scan["actions_applied"]);
		expect(actionsApplied).toBe(1);

		expect(
			closed.recovery,
			"soft close must create the exact reopen handle",
		).toHaveLength(1);
		expect(closed.recovery[0]).toEqual(
			expect.objectContaining({ operation_kind: "mark" }),
		);
		expect(closed.facets).toEqual(
			expect.arrayContaining([expect.objectContaining({ facet: "history" })]),
		);
		expect(
			parseMetadata(String(closed.row?.["metadata"]))["superseded_by"],
		).toBe(pair.currentId);
		const recoveryHandle = closed.recovery[0]?.["recovery_handle"];
		if (typeof recoveryHandle !== "string") {
			throw new Error("soft close did not return a recovery handle");
		}
		// Owner ruling 2026-08-26: a retired row STAYS in the recall result and says so.
		// Hiding it was rejected outright, so membership is the wrong observable here — the
		// row is present either way and the difference is the marker on its served text.
		// Every chunk of a fully retired row is `history`, so every part carries the prefix.
		const closedRecall = (await harness.recall("https://atlas.example/v1")).find(
			(row) => row["id"] === pair.staleId,
		);
		expect(closedRecall, "a soft-closed row must still reach the reader").toBeDefined();
		const closedText = String(closedRecall?.["text"] ?? "");
		expect(closedText).not.toBe("");
		for (const part of closedText.split("\n\n")) {
			expect(part).toMatch(/^\[history\] /);
		}

		harness.restoreMark(recoveryHandle);
		const reopened = harness.readSnapshot(pair.staleId);
		expect(parseMetadata(String(reopened.row?.["metadata"]))["superseded_by"]).toBeUndefined();
		expect(reopened.recovery[0]?.["restored_at"]).toEqual(expect.any(String));
		const reopenedRecall = (await harness.recall("https://atlas.example/v1")).find(
			(row) => row["id"] === pair.staleId,
		);
		expect(reopenedRecall, "a reopened row must still reach the reader").toBeDefined();
		expect(String(reopenedRecall?.["text"] ?? "")).not.toMatch(/\[(history|current)\] /);
	});

	test("rem-replace-valid-time-ordering", { timeout: 35_000 }, async () => {
		const sectionName = validTimePair.backdated_arrival.section_name;
		const laterValidId = await harness.seedMemory({
			category: "profile",
			content: validTimePair.later_valid.text,
			metadata: {
				section_name: `${sectionName}-later-valid-seed`,
				valid_from: Date.parse(validTimePair.later_valid.valid_from),
			},
		});
		const backdatedArrivalId = await harness.seedMemory({
			category: "profile",
			content: validTimePair.backdated_arrival.text,
			metadata: {
				section_name: sectionName,
				valid_from: Date.parse(validTimePair.backdated_arrival.valid_from),
			},
		});
		const laterStored = parseMetadata(
			harness.getMemory(laterValidId)?.metadata,
		);
		const backdatedStored = parseMetadata(
			harness.getMemory(backdatedArrivalId)?.metadata,
		);
		expect(laterStored["valid_from"]).toBe(
			Date.parse(validTimePair.later_valid.valid_from),
		);
		expect(backdatedStored["valid_from"]).toBe(
			Date.parse(validTimePair.backdated_arrival.valid_from),
		);

		await harness.runJob("rem-replace");
		const scanPairs = harness.readSnapshot(backdatedArrivalId).scanPairs;
		expect(
			scanPairs,
			"the production path must record a replacement verdict and apply its valid-time close",
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					actions_applied: 1,
					progress_state: "closed",
					verdict: "replacement",
				}),
			]),
		);
		const arrived = harness.getMemory(backdatedArrivalId);
		expect(
			parseMetadata(arrived?.metadata)["superseded_by"],
			"valid-time must invert the storage-time close target",
		).toBe(laterValidId);
		expect(
			parseMetadata(harness.getMemory(laterValidId)?.metadata)[
				"superseded_by"
			],
		).toBeUndefined();
	});

	test(
		"rem-replace-roundtrip-refusal-carry",
		{ timeout: 45_000 },
		async () => {
			const pair = await harness.seedProfilePair("refusal-carry", {
				current: "The current Atlas support channel is #atlas-current.",
				stale: "The current Atlas support channel is #atlas-legacy.",
			});
			await harness.runJob("rem-replace", {
				mutateAtBeforeLlm: () =>
					harness.updateProfileMemory(
						pair.staleId,
						"The current Atlas support channel is #atlas-legacy-edited.",
					),
			});
			await harness.runJob("rem-replace");
			const scans = harness.readSnapshot(pair.staleId).scanPairs;

			expect(
				scans,
				"stale-hash refusal must be inherited into exactly one next generation",
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ refusal_reason: "content_changed" }),
					expect.objectContaining({
						inherited_from_generation_id: expect.any(String),
					}),
				]),
			);
			expect(
				scans.filter(
					(row) => row["inherited_from_generation_id"] !== null,
				),
			).toHaveLength(1);
		},
	);

	test("rem-replace-never-physical-delete", { timeout: 75_000 }, async () => {
		await harness.seedReplacePopulation();
		await harness.seedMemory({
			content: "Unrelated sentinel: the Borealis notebook has a blue cover.",
		});
		const wave = await harness.runOrderedWave();

		expect(
			wave.replace.operations,
			"non-deletion proof must exercise at least one real close or mark",
		).toBeGreaterThan(0);
		expect(wave.after.count).toBe(wave.before.count);
		expect(wave.after.ids).toEqual(wave.before.ids);
	});

	test("rem-replace-scan-known-verdict-set", { timeout: 60_000 }, async () => {
		const population = await harness.seedReplacePopulation();
		await harness.runJob("rem-replace");
		const scans = harness.readScanOutcomes();
		const actual = population.map((relation) => {
			const scan = scans.find(
				(row) =>
					(row["left_row_id"] === relation.staleId &&
						row["right_row_id"] === relation.currentId) ||
					(row["left_row_id"] === relation.currentId &&
						row["right_row_id"] === relation.staleId),
			);
			return { fixtureId: relation.fixtureId, scan };
		});
		console.info(
			`[rem-replace-population-verdict-sample] ${JSON.stringify(
				actual.map(({ fixtureId, scan }) => ({ fixtureId, verdict: scan?.["verdict"] })),
			)}`,
		);

		expect(population.length, "the committed population must cover multiple relations").toBeGreaterThan(
			1,
		);
		for (const relation of actual) {
			expect(
				relation.scan,
				`the batch must discover committed relation ${relation.fixtureId}`,
			).toBeDefined();
			// A live model may refuse a pair instead of returning a verdict. Either is a
			// discovered relation; what must never happen is a pair that carries neither.
			const verdict = relation.scan?.["verdict"];
			const refusalReason = relation.scan?.["refusal_reason"];
			expect(
				typeof verdict === "string" ? verdict : `refused:${String(refusalReason)}`,
				`relation ${relation.fixtureId} carries neither a verdict nor a refusal reason: ${JSON.stringify(relation.scan)}`,
			).toMatch(/^(keep|replacement|uncertain|refused:(?!null|undefined).+)$/);
		}
	});

	test("rem-replace-cli-trigger-applies-action", { timeout: 40_000 }, async () => {
		const pair = await harness.seedProfilePair("cli-trigger-action", cliActionPair);
		const job = await harness.runJob("rem-replace");
		const stale = harness.getMemory(pair.staleId);
		const scan = findPairScan(harness.readSnapshot(pair.staleId).scanPairs, pair);
		if (!scan) {
			throw new Error("UNINSTANTIATED: CLI action produced no pair decision");
		}
		console.info(`[rem-replace-cli-verdict] ${JSON.stringify(scan)}`);
		if (scan["verdict"] !== "replacement") {
			throw new Error(
				`UNINSTANTIATED: CLI action requires replacement, got ${String(scan["verdict"])}`,
			);
		}
		const actionsApplied = Number(scan["actions_applied"]);
		expect(actionsApplied).toBe(1);

		expect(
			job.operations,
			"installed rem-start operation count must match its durable pair decision",
		).toBe(actionsApplied);
		expect(parseMetadata(stale?.metadata)["superseded_by"]).toBe(pair.currentId);
	});

	test("rem-replace-cli-trigger-journal-visible", { timeout: 40_000 }, async () => {
		await harness.seedProfilePair("cli-trigger-journal", {
			current: "The current Atlas escalation room is #atlas-now.",
			stale: "The current Atlas escalation room is #atlas-old.",
		});
		const job = await harness.runJob("rem-replace");
		const durable = harness.readJobJournal(job.jobId);
		const chassis = harness.readChassisJournal(job.jobId);
		const audit = harness.readAuditRecords(job.jobId);
		const transitions = harness.readJobTransitions(job.jobId);

		expect(durable).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					actions_applied: job.operations,
					job_id: job.jobId,
					job_type: "rem-replace",
					outcome: "done",
					stage: "rem-replace",
					verdicts: expect.any(Number),
				}),
			]),
		);
		expect(
			durable.filter((row) => row["stage"] === "rem-replace"),
			"durable journal must contain exactly one terminal aggregate",
		).toHaveLength(1);
		expect(durable).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					actions_applied: job.operations,
					job_id: job.jobId,
					job_type: "rem-replace",
					outcome: expect.stringMatching(/^(done|refused)$/),
					stage: expect.stringMatching(/^replace-pair:/),
				verdicts: expect.any(Number),
			}),
			]),
		);
		expect(chassis).toEqual([
			expect.objectContaining({
				actions_applied: job.operations,
				correlation_id: job.correlationId,
				job_id: job.jobId,
				job_type: "rem-replace",
			}),
		]);
		expect(audit.some((row) => nestedDetail(row, "correlation_id") === job.correlationId)).toBe(true);
		expect(transitions.at(-1)).toEqual(
			expect.objectContaining({ correlationId: job.correlationId, state: "done" }),
		);
	});

	test("rem-replace-cli-trigger-is-distinguishable", { timeout: 35_000 }, async () => {
		const before = {
			audit: harness.readAuditRecords(),
			chassis: harness.readChassisJournal(),
			jobs: harness.readJobTransitions(),
		};
		const job = await harness.runJob("rem-replace");
		const completed = harness.readJobJournal(job.jobId);

		expect(job).toEqual(expect.objectContaining({ operations: 0, state: "done" }));
		// A wave that finds no pair reports no-action; "done" is reserved for a wave that
		// actually applied something.
		expect(completed).toEqual([
			expect.objectContaining({ actions_applied: 0, outcome: "no-action", pairs_scanned: 0 }),
		]);
		expect(harness.readAuditRecords().length).toBeGreaterThan(before.audit.length);
		expect(harness.readChassisJournal().length).toBeGreaterThan(before.chassis.length);
		expect(harness.readJobTransitions().length).toBeGreaterThan(before.jobs.length);
		expect(harness.readChassisJournal(job.jobId)).toEqual([
			expect.objectContaining({ correlation_id: job.correlationId }),
		]);
	});
});

function parseMetadata(raw: string | undefined): Record<string, unknown> {
	if (!raw) return {};
	const parsed: unknown = JSON.parse(raw);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

function findPairScan(
	scans: Record<string, unknown>[],
	pair: { currentId: string; staleId: string },
): Record<string, unknown> | undefined {
	return scans.find(
		(row) =>
			(row["left_row_id"] === pair.staleId && row["right_row_id"] === pair.currentId) ||
			(row["left_row_id"] === pair.currentId && row["right_row_id"] === pair.staleId),
	);
}

function memoryIds(rows: Record<string, unknown>[]): unknown[] {
	return rows.map((row) => row["id"]);
}

function nestedDetail(row: Record<string, unknown>, key: string): unknown {
	const details = row["details"];
	return typeof details === "object" && details !== null && !Array.isArray(details)
		? (details as Record<string, unknown>)[key]
		: undefined;
}
