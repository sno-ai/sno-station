import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createTestEmbedder } from "../helpers/test-db.ts";
import { RemRoundtripHarness } from "./rem-roundtrip-harness.ts";

const fixtures = {
	listPrune: {
		retired: "no longer needs to track 'Prepare investor presentation'",
		text: "Active tasks:\n- The user no longer needs to track 'Prepare investor presentation' on their to-do list; remove it from the active task list.\n- The user is motivated to start walking 7,500 steps every day to improve their fitness.\n- The user needs to prepare an investor presentation soon to secure funding for a new tech venture.\n- The user needs to schedule a personal training session for the current week (week of June 2, 2026). The user stated they would h\n- The user is drafting an email to the Chief Financial Officer, Head of R&D, and Chief Operating Officer to align leadership on a\n- The user needs to book restaurant reservations for next weekend. Based on the session date of 2026-06-03, this refers to the wee\n- On June 3, 2026, the user needs to review speaking engagement proposals. They intend to apply strategies of clarity and consiste\n- The user needs to review the department head reports and will be focusing on them for a bit.\n- The user needs to update the executive bio for work.\n- The user is drafting an email to the VP of Engineering and VP of Operations to request executive approval for a $2.8M strategic\n- The user needs to follow up with some industry contacts during the week of June 5, 2026.\n- The user needs to approve the strategic initiative budget on June 6, 2026.",
	},
	negatedCurrent:
		"The user stated they do not really like Count Basie anymore, noting that their music tastes have shifted since they last listened to him.",
	tier2: {
		current: "$1,100,000",
		retired: "$900,000",
		text: "Project 'FinTech Digital Onboarding Optimization & Compliance Framework' has a budget of $1,100,000\nThe 'FinTech Digital Onboarding Optimization & Compliance Framework' project proposal currently has a budget of $1,100,000, updated from $900,000 on June 6, 2025.",
	},
	valueSwap: {
		current: "Yo-Yo Ma",
		retired: "Duke Ellington",
		text: "The user currently prefers Yo-Yo Ma's cello works because they find the rich, expressive sound of the cello incredibly soothing and profound.\nThe user currently prefers Yo-Yo Ma's cello works because they find the rich, expressive sound of the cello incredibly soothing and profound. This is a shift from their previous enjoyment of Duke Ellington's jazz.",
	},
} as const;

const localeSwaps = [
	{ locale: "en", current: "coffee", prefix: "Current preference: ", retired: "morning tea", text: "shifted from morning tea to coffee" },
	{ locale: "de", current: "Kaffee", prefix: "Aktuelle Präferenz: ", retired: "Morgentee", text: "wechselte von Morgentee zu Kaffee" },
	{ locale: "es", current: "café", prefix: "Preferencia actual: ", retired: "té matutino", text: "cambió de té matutino a café" },
	{ locale: "fr", current: "café", prefix: "Préférence actuelle : ", retired: "thé du matin", text: "est passé du thé du matin au café" },
	{ locale: "zh", current: "咖啡", prefix: "当前偏好：", retired: "早茶", text: "从早茶改为咖啡" },
	{ locale: "zh-Hant", current: "咖啡", prefix: "目前偏好：", retired: "早茶", text: "從早茶改為咖啡" },
	{ locale: "ja", current: "コーヒー", prefix: "現在の好み：", retired: "朝のお茶", text: "朝のお茶からコーヒーに切り替えた" },
	{ locale: "ko", current: "커피", prefix: "현재 선호: ", retired: "아침 차", text: "아침 차에서 커피로 바꾸었다" },
	{ locale: "ru", current: "кофе", prefix: "Текущее предпочтение: ", retired: "утреннего чая", text: "перешёл с утреннего чая на кофе" },
] as const;

const localeModelBattery = new Set(["en", "es", "zh"]);

let embedder: Embedder;
let harness: RemRoundtripHarness;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

beforeEach(async () => {
	harness = await RemRoundtripHarness.create(embedder);
});

afterEach(async () => {
	await harness.close();
});

describe("section 6a REM update installed-CLI round trips", () => {
	test("rem-update-roundtrip-value-swap", { timeout: 30_000 }, async () => {
		const rowId = await harness.seedMemory({ content: fixtures.valueSwap.text });
		const before = harness.readSnapshot(rowId);
		const job = await harness.runJob("rem-update");
		const after = harness.readSnapshot(rowId);

		expect(
			after.row?.["text"],
			`current text must retire Duke Ellington; journal=${JSON.stringify(harness.readJobJournal(job.jobId))}; sidecar=${job.sidecarStderr}`,
		).not.toContain(fixtures.valueSwap.retired);
		expect(after.row?.["text"]).toContain(fixtures.valueSwap.current);
		expect(after.row?.["id"]).toBe(before.row?.["id"]);
		expect(after.facets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					facet: "history",
					text: fixtures.valueSwap.text,
				}),
			]),
		);
		expect(after.recovery).toHaveLength(1);
		expect(job.operations).toBe(1);
		const current = await harness.keyword(fixtures.valueSwap.current);
		const retired = await harness.keyword(fixtures.valueSwap.retired);
		const history = await harness.keyword(
			fixtures.valueSwap.retired,
			"include-history",
		);
		expect(current.map((result) => result.entry.id)).toContain(rowId);
		expect(retired.map((result) => result.entry.id)).not.toContain(rowId);
		expect(history.map((result) => result.entry.id)).toContain(rowId);
	});

	test("rem-update-roundtrip-list-prune", { timeout: 30_000 }, async () => {
		const rowId = await harness.seedMemory({ content: fixtures.listPrune.text });
		const before = harness.readSnapshot(rowId);
		const job = await harness.runJob("rem-update");
		const after = harness.readSnapshot(rowId);

		expect(
			after.row?.["text"],
			`current list must remove only the retired task; journal=${JSON.stringify(harness.readJobJournal(job.jobId))}; sidecar=${job.sidecarStderr}`,
		).not.toContain("no longer needs to track 'Prepare investor presentation'");
		expect(after.row?.["text"]).toContain("walking 7,500 steps");
		expect(after.row?.["text"]).toContain(
			"approve the strategic initiative budget",
		);
		expect(after.row?.["id"]).toBe(before.row?.["id"]);
		expect(after.facets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					facet: "history",
					text: fixtures.listPrune.text,
				}),
			]),
		);
		expect(after.recovery).toHaveLength(1);
		const retired = await harness.keyword(fixtures.listPrune.retired);
		const history = await harness.keyword(
			fixtures.listPrune.retired,
			"include-history",
		);
		expect(
			retired
				.filter((result) => result.entry.id === rowId)
				.every((result) => !result.entry.text.includes(fixtures.listPrune.retired)),
		).toBe(true);
		expect(history.map((result) => result.entry.id)).toContain(rowId);
	});

	test("rem-update-roundtrip-ambiguous-negation", { timeout: 30_000 }, async () => {
		const rowId = await harness.seedMemory({ content: fixtures.negatedCurrent });
		const before = harness.readSnapshot(rowId);
		await harness.runJob("rem-update");
		const after = harness.readSnapshot(rowId);

		expect(
			after.ledger,
			"ambiguous negation with no named replacement must route to restate",
		).toEqual([
			expect.objectContaining({ owner: "restate", state: "ambiguous" }),
		]);
		expect(after.row).toEqual(before.row);
		expect(after.facets).toEqual(before.facets);
		expect(after.chunks).toEqual(before.chunks);
		expect(after.recovery).toEqual(before.recovery);
		const current = await harness.keyword("Count Basie");
		expect(current.map((result) => result.entry.id)).toContain(rowId);
	});

	test("rem-update-roundtrip-tier2-prose", { timeout: 30_000 }, async () => {
		const rowId = await harness.seedMemory({ content: fixtures.tier2.text });
		const before = harness.readSnapshot(rowId);
		const job = await harness.runJob("rem-update");
		const after = harness.readSnapshot(rowId);

		expect(
			after.row?.["text"],
			`Tier-2 current prose must exclude the retired budget; journal=${JSON.stringify(harness.readJobJournal(job.jobId))}; sidecar=${job.sidecarStderr}`,
		).not.toContain(fixtures.tier2.retired);
		expect(after.row?.["text"]).toContain(fixtures.tier2.current);
		expect(after.row?.["text"]).toContain(
			"FinTech Digital Onboarding Optimization",
		);
		expect(after.row?.["id"]).toBe(before.row?.["id"]);
		expect(after.facets).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					facet: "history",
					text: fixtures.tier2.text,
				}),
			]),
		);
		expect(after.recovery).toHaveLength(1);
		const retired = await harness.keyword(fixtures.tier2.retired);
		const history = await harness.keyword(
			fixtures.tier2.retired,
			"include-history",
		);
		expect(
			retired
				.filter((result) => result.entry.id === rowId)
				.every((result) => !result.entry.text.includes(fixtures.tier2.retired)),
		).toBe(true);
		expect(history.map((result) => result.entry.id)).toContain(rowId);
	});

	test(
		"rem-update-roundtrip-idempotent-wave",
		{ timeout: 45_000 },
		async () => {
				const rowId = await harness.seedMemory({ content: fixtures.valueSwap.text });
			const first = await harness.runJob("rem-update");
			const afterFirst = harness.readSnapshot(rowId);
			const countsAfterFirst = {
				chunks: harness.readTableCount("nodix_memory_chunks"),
				recovery: harness.readTableCount("nodix_rem_recovery_history"),
			};
			const second = await harness.runJob("rem-update");
			const afterSecond = harness.readSnapshot(rowId);

			expect(
				first.operations,
				`first wave must perform the value-swap write; journal=${JSON.stringify(harness.readJobJournal(first.jobId))}; sidecar=${first.sidecarStderr}`,
			).toBe(1);
			expect(second.operations).toBe(0);
			expect(afterSecond).toEqual(afterFirst);
			expect(harness.readTableCount("nodix_memory_chunks")).toBe(
				countsAfterFirst.chunks,
			);
			expect(harness.readTableCount("nodix_rem_recovery_history")).toBe(
				countsAfterFirst.recovery,
			);
		},
	);

	test("rem-update-retrieval-sees-rewrite", { timeout: 35_000 }, async () => {
		const rowId = await harness.seedMemory({ content: fixtures.valueSwap.text });
		await harness.runJob("rem-update");
		const current = await harness.recall(fixtures.valueSwap.current);
		const retired = await harness.recall(fixtures.valueSwap.retired);

		expect(
			memoryTexts(current),
			"public memory_recall must serve the rewritten current value",
		).toEqual(expect.arrayContaining([expect.stringContaining(fixtures.valueSwap.current)]));
		expect(memoryIds(current)).toContain(rowId);
		expect(memoryTexts(current).join("\n")).not.toContain(fixtures.valueSwap.retired);
		expect(memoryTexts(retired).join("\n")).not.toContain(fixtures.valueSwap.retired);
	});

	test("rem-update-locale-policy", { timeout: 75_000 }, async () => {
		const rows: Array<{
			id: string;
			locale: string;
			current: string;
			prefix: string;
			retired: string;
		}> = [];
		for (const [index, fixture] of localeSwaps.entries()) {
			rows.push({
				id: await harness.seedMemory({
					content: fixture.text,
					metadata: { locale: fixture.locale },
				}),
				locale: fixture.locale,
				current: fixture.current,
				prefix: fixture.prefix,
				retired: fixture.retired,
			});
			console.info(`[locale-policy] ${index + 1}/${localeSwaps.length} seeded`);
		}
		const job = await harness.runJob("rem-update");
		for (const row of rows) {
			const snapshot = harness.readSnapshot(row.id);
			expect(snapshot.ledger, `${row.locale} must route to the update transition state`).toEqual([
				expect.objectContaining({ state: "transition" }),
			]);
			if (!localeModelBattery.has(row.locale)) continue;
			const text = String(harness.getMemory(row.id)?.text ?? "");
			// The model writes the whole current text now; there is no code-composed locale
			// template to pin. What must hold is the value survives and the retired one does not.
			expect(text, `${row.locale} must produce a non-empty rewrite`).not.toBe("");
			expect(text, `${row.locale} must retain its current value`).toContain(row.current);
			expect(text, `${row.locale} must retire its previous value`).not.toContain(row.retired);
		}
		expect(
			job.operations,
			`the English, non-CJK, and CJK model battery must all rewrite; journal=${JSON.stringify(harness.readJobJournal(job.jobId))}; sidecar=${job.sidecarStderr}`,
		).toBeGreaterThanOrEqual(localeModelBattery.size);
	});

	test("rem-update-atomic-transaction-restart", { timeout: 45_000 }, async () => {
		const rowId = await harness.seedMemory({ content: fixtures.valueSwap.text });
		const before = harness.readAtomicState(rowId);
		const job = await harness.runJob("rem-update", {
			allowFailure: true,
			sidecarEnv: { SNO_STATION_MEM_REM_TEST_FAILPOINT: "after_primary_write" },
		});

		// A mid-write failure refuses that row and lets the wave finish; what must never
		// happen is a silent partial write or a refusal with no named reason.
		const journal = harness.readJobJournal(job.jobId);
		const evidence = `operations=${job.operations}; journal=${JSON.stringify(journal)}`;
		expect(job.operations, `the injected failure must apply nothing; ${evidence}`).toBe(0);
		expect(journal, `the injected failure must be named in the journal; ${evidence}`).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ outcome: "refused", reason: "mutation_failed" }),
			]),
		);
		await harness.restartSidecar();
		const afterRestart = harness.readAtomicState(rowId);
		expect(afterRestart, `the row must be byte-identical after restart; ${evidence}`).toEqual(before);
	});

	test(
		"rem-wave-mixed-population-routing-census",
		{ timeout: 180_000 },
		async () => {
				const population = await harness.seedRowStatePopulation();
			await harness.runOrderedWave({ waitTimeoutSeconds: 150 });

			expect(
				harness.readRoutingCensus(),
				"all public rows must match the committed hand-labeled routing census",
			).toEqual(population.expectedCensus);
			expect(harness.readRowCensus().ids).toEqual(
				expect.arrayContaining(population.ids),
			);
		},
	);

	test("rem-wave-single-claim-per-row", { timeout: 45_000 }, async () => {
		const pair = await harness.seedProfilePair("single-claim", {
			current: "The current Atlas deployment region is eu-central-1.",
			stale:
				"The current Atlas deployment region shifted from us-east-1 to us-west-2.",
		});
		const rowId = pair.staleId;
		const replace = await harness.runJob("rem-replace");
		await harness.restartSidecar();
		const update = await harness.runJob("rem-update");
		// A claim row is released when its wave ends, so the durable record of who acted on
		// this row is the journal, not the claim table: exactly one operation applies an
		// action and the loser names why it stood down.
		const replaceJournal = harness.readJobJournal(replace.jobId);
		const updateJournal = harness.readJobJournal(update.jobId);
		const evidence = `replace=${JSON.stringify(replaceJournal)}; update=${JSON.stringify(updateJournal)}`;
		// The wave aggregate summarizes its stage rows; it is not a second action.
		const applied = [...replaceJournal, ...updateJournal].filter(
			(row) => row["stage"] !== row["job_type"] && Number(row["actions_applied"]) > 0,
		);
		const refusals = [...replaceJournal, ...updateJournal].filter(
			(row) => row["outcome"] === "refused",
		);
		expect(
			applied,
			`one stage row must receive exactly one terminal action, with the wave aggregate excluded; ${evidence}`,
		).toHaveLength(1);
		expect(
			refusals,
			`the losing action must record a visible claim refusal; ${evidence}`,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "owned_by_restate" }),
			]),
		);
	});

	test("rem-wave-replace-before-update", { timeout: 60_000 }, async () => {
		await harness.seedReplacePopulation();
		const updateId = await harness.seedMemory({ content: fixtures.valueSwap.text });
		const wave = await harness.runOrderedWave();

		expect(wave.order).toEqual(["rem-replace", "rem-update"]);
		expect(wave.replace.operations, "replace must act before update").toBeGreaterThan(0);
		expect(wave.update.operations, "update must act after replace").toBeGreaterThan(0);
		expect(wave.after).toEqual(wave.before);
		expect(String(harness.getMemory(updateId)?.text)).not.toContain(
			fixtures.valueSwap.retired,
		);
	});

	test("rem-update-cli-trigger-applies-action", { timeout: 35_000 }, async () => {
		const rowId = await harness.seedMemory({ content: fixtures.valueSwap.text });
		const before = harness.readSnapshot(rowId);
		const job = await harness.runJob("rem-update");
		const after = harness.readSnapshot(rowId);

		expect(job.operations, "installed rem-start must cause a real rewrite").toBeGreaterThan(0);
		expect(after.row?.["text"]).not.toBe(before.row?.["text"]);
		expect(after.row?.["text"]).not.toContain(fixtures.valueSwap.retired);
	});

	test("rem-update-cli-trigger-journal-visible", { timeout: 35_000 }, async () => {
		await harness.seedMemory({ content: fixtures.valueSwap.text });
		const job = await harness.runJob("rem-update");
		const durable = harness.readJobJournal(job.jobId);
		const chassis = harness.readChassisJournal(job.jobId);
		const audit = harness.readAuditRecords(job.jobId);
		const transitions = harness.readJobTransitions(job.jobId);

		// A wave journals its per-stage rows and one terminal aggregate named for the job
		// type; pinning the whole list to a single row pinned an older, quieter engine.
		expect(durable).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					actions_applied: job.operations,
					job_id: job.jobId,
					job_type: "rem-update",
					outcome: "done",
					stage: "rem-update",
					verdicts: expect.any(Number),
				}),
			]),
		);
		expect(
			durable.filter((row) => row["stage"] === "rem-update"),
			"durable journal must contain exactly one terminal aggregate",
		).toHaveLength(1);
		expect(chassis).toEqual([
			expect.objectContaining({
				actions_applied: job.operations,
				correlation_id: job.correlationId,
				job_id: job.jobId,
				job_type: "rem-update",
			}),
		]);
		expect(audit.some((row) => nestedDetail(row, "correlation_id") === job.correlationId)).toBe(true);
		expect(transitions.at(-1)).toEqual(
			expect.objectContaining({ correlationId: job.correlationId, state: "done" }),
		);
	});

	test("rem-update-cli-trigger-is-distinguishable", { timeout: 35_000 }, async () => {
		const before = {
			audit: harness.readAuditRecords(),
			chassis: harness.readChassisJournal(),
			jobs: harness.readJobTransitions(),
		};
		const job = await harness.runJob("rem-update");
		const completed = harness.readJobJournal(job.jobId);

		expect(job).toEqual(expect.objectContaining({ operations: 0, state: "done" }));
		// The wave aggregate summarizes its stage rows; it is not a second action.
		expect(completed).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ actions_applied: 0, outcome: "no-action", pairs_scanned: 0 }),
			]),
		);
		expect(harness.readAuditRecords().length).toBeGreaterThan(before.audit.length);
		expect(harness.readChassisJournal().length).toBeGreaterThan(before.chassis.length);
		expect(harness.readJobTransitions().length).toBeGreaterThan(before.jobs.length);
		expect(harness.readChassisJournal(job.jobId)).toEqual([
			expect.objectContaining({ correlation_id: job.correlationId }),
		]);
	});
});

function memoryIds(rows: Record<string, unknown>[]): unknown[] {
	return rows.map((row) => row["id"]);
}

function memoryTexts(rows: Record<string, unknown>[]): string[] {
	return rows.map((row) => String(row["text"] ?? ""));
}

function nestedDetail(row: Record<string, unknown>, key: string): unknown {
	const details = row["details"];
	return typeof details === "object" && details !== null && !Array.isArray(details)
		? (details as Record<string, unknown>)[key]
		: undefined;
}
