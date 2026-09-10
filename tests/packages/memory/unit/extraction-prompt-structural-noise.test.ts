import { describe, expect, it } from "vitest";

import { SUPPORTED_LOCALES } from "../../../../apps/mem-claw/src/i18n/locales.ts";
import { t } from "../../../../apps/mem-claw/src/i18n/registry.ts";

/**
 * Structural-noise guard parity (upstream #836 port, D-number in DEVIATIONS).
 *
 * The extraction prompt is the FIRST line of defense against raw-transcript
 * carryover: claw's post-extraction validation only runs the noise gate on
 * `abstract` (insight-distill-candidate-parser.ts), so `content` / `overview`
 * transcript blobs are never deterministically filtered downstream. These
 * anchors therefore must be present in every locale's prompt, not just en.
 */
describe("extraction prompt — structural-noise guards exist in every locale", () => {
	it("locks the extraction prompt to the nine reviewed locales", () => {
		expect([...SUPPORTED_LOCALES].sort()).toEqual(
			["de", "en", "es", "fr", "ja", "ko", "ru", "zh", "zh-Hant"].sort(),
		);
	});

	for (const locale of SUPPORTED_LOCALES) {
		it(`${locale} prompt carries the structural-noise anchors`, async () => {
			const prompts = await t(locale, "extractionPrompts");
			const prompt = prompts.buildExtractionPrompt(
				"placeholder conversation",
				"test-user",
				undefined,
				undefined,
				["preferences.budget", "entities.project-orion"],
			);

			// Scope the carryover-bullet anchors to the bullet's own line. `JSON`
			// already appears in the existing System/platform-metadata bullet, so a
			// global toContain would pass even if a locale dropped the new bullet —
			// asserting these anchors co-occur on the "user:"/"assistant:" line
			// proves the carryover bullet itself landed (Codex review).
			const carryover = prompt
				.split("\n")
				.find((line) => line.includes('"user:"') && line.includes('"assistant:"'));
			expect(carryover, `${locale}: carryover bullet missing`).toBeDefined();
			expect(carryover, `${locale}: carryover bullet missing 3+ anchor`).toContain("3+");
			expect(carryover, `${locale}: carryover bullet missing raw JSON blob anchor`).toContain(
				"JSON",
			);
			expect(carryover, `${locale}: carryover bullet missing category tokens`).toContain(
				"fact/preference/entity/decision",
			);

			// Output-principle distillation gate is shared English prose in every
			// locale (matches the existing all-English Output Principles section).
			expect(prompt, `${locale}: missing distillation principle`).toContain(
				"Distillation over transcription",
			);
			expect(prompt, `${locale}: missing ~200-char distillation gate`).toContain("~200");
			expect(prompt, `${locale}: missing two-record mutation rule`).toContain(
				"ALWAYS emit the dated `episodic` occurrence AND a `profile` mutation candidate",
			);
			expect(prompt, `${locale}: missing embedded durable-assertion rule`).toContain(
				"A general or habitual assertion with stable or recurring scope remains a durable",
			);
			expect(prompt, `${locale}: missing reporting-act exclusion`).toContain(
				"The act of remembering, noticing, or realizing is not itself an occurrence",
			);
			expect(prompt, `${locale}: missing reporting-verb profile-only example`).toContain(
				"## reporting verb: durable content only, no episodic record",
			);
			expect(prompt, `${locale}: missing mutation-versus-preference boundary`).toContain(
				"A command to add, remove, complete, or stop tracking content expresses a requested state",
			);
			expect(prompt, `${locale}: missing current-state history exclusion`).toContain(
				"prior, incorrect, completed, removed, and retracted values stay out",
			);
			expect(prompt, `${locale}: missing episodic-only transition dating rule`).toContain(
				"Include dates and transition context in `episodic` records",
			);
			expect(prompt, `${locale}: missing profile field boundary`).toContain(
				"Never include prior or incorrect values, transition narration, or event dates",
			);
			expect(prompt, `${locale}: missing category-scoped verbatim rule`).toContain(
				"RECORD_BOUNDARY_V1 — CATEGORY-SCOPED PRESERVATION",
			);
			expect(prompt, `${locale}: profile verbatim rule still admits historical details`).toContain(
				"`profile`: preserve only post-change current-state details",
			);
			expect(prompt, `${locale}: episodic verbatim rule weakened`).toContain(
				"`episodic`: preserve event amounts and dates byte-for-byte, at full strength",
			);
			expect(prompt, `${locale}: current-state example still carries a prior value`).not.toContain(
				"Replaced: Redis on 2026-05-03",
			);
			expect(prompt, `${locale}: current-state example still carries transition narration`).not.toContain(
				"replacing Redis as of May 3, 2026",
			);
			expect(prompt, `${locale}: missing active section address list`).toContain(
				'["preferences.budget","entities.project-orion"]',
			);
			expect(prompt, `${locale}: missing exact address reuse rule`).toContain(
				"reuse its exact existing name",
			);
			expect(prompt, `${locale}: multi-record example uses a bare array`).not.toContain(
				"```json\n[",
			);
			const dedupPrompt = prompts.buildDedupPrompt(
				"candidate abstract",
				"candidate overview",
				"candidate content",
				"existing memories",
			);
			expect(
				dedupPrompt,
				`${locale}: retired current-state date/change arbitration remains`,
			).not.toContain(
				"replacement memory should include the new value and the date/change evidence",
			);

			// Canonical kind vocabulary must remain the five locked memory kinds.
			for (const category of ["episodic", "profile", "persona", "lesson", "summary"]) {
				expect(prompt, `${locale}: missing category ${category}`).toContain(category);
			}
		});
	}
});

describe("extraction prompt (en) — all four #836 guards are spelled out", () => {
	it("rejects transcript carryover, fragment blobs, and enforces atomic distillation", async () => {
		const prompts = await t("en", "extractionPrompts");
		const prompt = prompts.buildExtractionPrompt("placeholder conversation", "test-user");

		// 1. Raw conversation carryover.
		expect(prompt).toContain("Raw conversation carryover");
		expect(prompt).toContain("compaction notices");
		expect(prompt).toContain("model-switch or session-reset traces");
		// 2. Fragment blobs.
		expect(prompt).toContain("Fragment blobs");
		expect(prompt).toContain("partial sentences");
		// 3 + 4. Atomic shape + length/distillation gate (one Output Principle).
		expect(prompt).toContain("not an excerpt, log, or transcript");
		expect(prompt).toContain("rewrite it as one factual statement");
	});
});
