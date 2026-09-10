/** Real LLM API required. No mocking. Missing keys = FAIL. */

/**
 * PARSER_HEADINGS machine-contract drift guard.
 *
 * Rationale for unit-tier placement (per SUITE_POLICY.md exception):
 * `PARSER_HEADINGS` is a frozen string-literal constant table — a pure
 * data transformation with zero I/O. Verifying that 9 locale bundles emit
 * those exact literals is a configuration-coherence check, not a
 * behavioral test. No DB / embedder / network is involved.
 *
 * Recent change: `apps/mem-claw/src/reflection/markdown-slice-parser.ts`
 * extracted hardcoded English heading literals into the exported
 * `PARSER_HEADINGS` const; the parser now references those instead of
 * inline strings.
 *
 * Verifies:
 *  1. The frozen key/value list of `PARSER_HEADINGS` matches the contract
 *     callers across the codebase + i18n bundles depend on. A diff here
 *     forces a reviewer to look at both the parser and every locale.
 *  2. For each of the 9 supported locales, `buildReflectionPrompt(...)`
 *     emits every value of `PARSER_HEADINGS` verbatim. Catches a
 *     translator who accidentally translates a parser heading.
 *  3. Same check on `buildReflectionFallbackText()` for each locale.
 */

import { describe, expect, it } from "vitest";
import { RESOURCES_BY_LOCALE } from "../../../../packages/sno-station-mem/src/engine/i18n/all-resources";
import { SUPPORTED_LOCALES } from "../../../../packages/sno-station-mem/src/engine/i18n/locales";
import { PARSER_HEADINGS } from "../../../../packages/sno-station-mem/src/engine/reflection/markdown-slice-parser";

const EXPECTED_PARSER_HEADINGS = {
	context: "Context",
	decisionsDurable: "Decisions (durable)",
	invariants: "Invariants",
	invariantsAndReflections: "Invariants & Reflections",
	derived: "Derived",
	openLoops: "Open loops / next actions",
	userModelDeltas: "User model deltas (about the human)",
	agentModelDeltas: "Agent model deltas (about the assistant/system)",
	lessonsAndPitfalls:
		"Lessons & pitfalls (symptom / cause / fix / prevention)",
	learningGovernance:
		"Learning governance candidates (.learnings / promotion / skill extraction)",
} as const;

describe("PARSER_HEADINGS machine contract", () => {
	it("freezes the exact key/value list parser + i18n bundles depend on", () => {
		// Compare structurally so a reordering or typo flips the test.
		expect(PARSER_HEADINGS).toEqual(EXPECTED_PARSER_HEADINGS);

		// And independently assert the keys, so adding a new key (e.g. a future
		// section) without updating EXPECTED above also fails this test.
		expect(Object.keys(PARSER_HEADINGS).sort()).toEqual(
			Object.keys(EXPECTED_PARSER_HEADINGS).sort(),
		);
	});

	// Headings actually emitted by the prompt + fallback templates. Three of the
	// keys (`invariantsAndReflections`, plus the merged `## Context`/`## Derived`
	// shapes) only appear in legacy / parser-side fallbacks, not in every locale's
	// fresh prompt. The set below is the subset every locale MUST emit verbatim.
	const REQUIRED_EMITTED_HEADINGS: ReadonlyArray<string> = [
		PARSER_HEADINGS.context,
		PARSER_HEADINGS.decisionsDurable,
		PARSER_HEADINGS.invariants,
		PARSER_HEADINGS.derived,
		PARSER_HEADINGS.openLoops,
		PARSER_HEADINGS.userModelDeltas,
		PARSER_HEADINGS.agentModelDeltas,
		PARSER_HEADINGS.lessonsAndPitfalls,
		PARSER_HEADINGS.learningGovernance,
	];

	for (const locale of SUPPORTED_LOCALES) {
		describe(`locale: ${locale}`, () => {
			it("buildReflectionPrompt emits every required PARSER_HEADINGS value verbatim", () => {
				const prompt = RESOURCES_BY_LOCALE[
					locale
				].reflectionPrompts.buildReflectionPrompt("dummy conversation", 100);

				for (const heading of REQUIRED_EMITTED_HEADINGS) {
					// Match `## <heading>` exactly — translators who localize the
					// heading text would break this assertion immediately.
					expect(
						prompt,
						`locale=${locale} prompt missing heading "## ${heading}"`,
					).toContain(`## ${heading}`);
				}
			});

			it("buildReflectionFallbackText emits every required PARSER_HEADINGS value verbatim", () => {
				const fallback =
					RESOURCES_BY_LOCALE[locale].reflectionPrompts
						.buildReflectionFallbackText();

				for (const heading of REQUIRED_EMITTED_HEADINGS) {
					expect(
						fallback,
						`locale=${locale} fallback missing heading "## ${heading}"`,
					).toContain(`## ${heading}`);
				}
			});
		});
	}
});
