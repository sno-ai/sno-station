/** @file rem-update-judgment.test.ts
 * @purpose Proves the rem-update decision functions of 90-rem-update-model-judgment-prd.md v2.0:
 * the first call's decision is STRUCTURE ONLY (REQ-2), the meaning questions belong to the
 * verification call (REQ-12), and no string comparison decides any outcome (DEC-6).
 * @boundary Pure deterministic logic; no model, no store.
 * @acceptance QCG-10 unit half, QCG-11 and QCG-12 at the unit tier
 * @class product
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	decideRemUpdateFromReply,
	decideRemUpdateRelationFromReply,
	decideRemUpdateVerification,
	renderRemUpdateJudgmentPrompt,
	renderRemUpdateRelationJudgmentPrompt,
	renderRemUpdateVerificationPrompt,
} from "../../../../packages/rem-core/src/index.ts";
import { REM_UPDATE_JUDGMENT_SKILL } from "../../../../apps/mem-claw/src/sidecar/rem-update-judgment-skill.ts";

const SOURCE =
	"The user used to really like books about social dynamics, but is currently drawn to books about tragedy.";

function judgment(proposedCurrent: string, retiredValues: string[]): string {
	return JSON.stringify({ proposed_current: proposedCurrent, retired_values: retiredValues });
}

describe("first call — structure only, never meaning", () => {
	it("sends a structurally usable reply on to verification instead of deciding it", () => {
		expect(
			decideRemUpdateFromReply(
				judgment("The user is currently drawn to books about tragedy.", [
					"books about social dynamics",
				]),
			),
		).toEqual({
			outcome: "verify",
			proposedCurrent: "The user is currently drawn to books about tragedy.",
			retiredValues: ["books about social dynamics"],
		});
	});

	it("passes a reply whose wording differs from the source — the string rules are gone", () => {
		// Exactly the case the 2026-08-21 review used to refute the old token check:
		// "pets"/"are" become "pet"/"is", words absent from the source as written.
		const decision = decideRemUpdateFromReply(judgment("Her pet is Alice.", ["Bob"]));
		expect(decision.outcome).toBe("verify");
	});

	it("passes a shortened name that the old substring check refused", () => {
		const decision = decideRemUpdateFromReply(
			judgment("Ann prefers tea.", ["coffee"]),
		);
		expect(decision.outcome).toBe("verify");
	});

	it("passes a proposal carrying a fact absent from the source — that is verification's job", () => {
		const decision = decideRemUpdateFromReply(
			judgment("The user moved to Reykjavik.", ["books about social dynamics"]),
		);
		expect(decision.outcome).toBe("verify");
	});

	it("refuses an unparseable reply as model_response_invalid", () => {
		for (const bad of [
			"",
			"not json",
			'{"proposed_current":"x"}',
			'{"proposed_current":"x","retired_values":[],"extra":1}',
		]) {
			expect(decideRemUpdateFromReply(bad)).toEqual({
				outcome: "refuse",
				reason: "model_response_invalid",
			});
		}
	});

	it("parses a fenced reply", () => {
		const fenced = `\`\`\`json\n${judgment("Lives in San Diego.", ["San Francisco"])}\n\`\`\``;
		expect(decideRemUpdateFromReply(fenced).outcome).toBe("verify");
	});

	it("routes the model's own empty retired list as no_retired_fact", () => {
		expect(decideRemUpdateFromReply(judgment("anything at all", []))).toEqual({
			outcome: "refuse",
			reason: "no_retired_fact",
		});
	});

	it("refuses retired values with an empty proposal as no_surviving_remainder", () => {
		expect(decideRemUpdateFromReply(judgment("   ", ["'Research workshop'"]))).toEqual({
			outcome: "refuse",
			reason: "no_surviving_remainder",
		});
	});
});

describe("verification call — the meaning questions", () => {
	const verify = (faithful: boolean, retiredAbsent: boolean, allAccounted = true): string =>
		JSON.stringify({ faithful, retired_absent: retiredAbsent, all_facts_accounted: allAccounted });

	it("applies when both judgements are true", () => {
		expect(decideRemUpdateVerification(verify(true, true))).toEqual({ outcome: "apply" });
	});

	it("refuses an unfaithful proposal as proposal_not_faithful", () => {
		expect(decideRemUpdateVerification(verify(false, true))).toEqual({
			outcome: "refuse",
			reason: "proposal_not_faithful",
		});
	});

	it("refuses a surviving retired meaning as retired_value_survives", () => {
		expect(decideRemUpdateVerification(verify(true, false))).toEqual({
			outcome: "refuse",
			reason: "retired_value_survives",
		});
	});

	it("refuses a rewrite that silently dropped a surviving fact", () => {
		expect(decideRemUpdateVerification(verify(true, true, false))).toEqual({
			outcome: "refuse",
			reason: "surviving_fact_lost",
		});
	});

	it("refuses an unparseable or wrong-shaped verification reply", () => {
		for (const bad of [
			"",
			"nope",
			'{"faithful":true}',
			// the pre-2026-08-21 two-field shape no longer satisfies the contract
			'{"faithful":true,"retired_absent":true}',
			'{"faithful":true,"retired_absent":true,"all_facts_accounted":true,"x":1}',
		]) {
			expect(decideRemUpdateVerification(bad)).toEqual({
				outcome: "refuse",
				reason: "model_response_invalid",
			});
		}
	});

	it("includes the newer record when verifying a partial relation rewrite", () => {
		const prompt = renderRemUpdateVerificationPrompt({
			judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.verification,
			source: "Works at Acme and lives in London.",
			supersedingText: "Lives in Paris.",
			proposedCurrent: "Works at Acme.",
			retiredValues: ["lives in London"],
		});

		expect(prompt).toContain('Newer record: "Lives in Paris."');
	});
});

describe("relation judgement — three booleans, no positions", () => {
	const relation = (supersedes: boolean, retires: boolean, everything = true): string =>
		JSON.stringify({ supersedes, retires_anything: retires, supersedes_everything: everything });

	it("allows only when the newer record supersedes and something is retired, and reports totality", () => {
		expect(decideRemUpdateRelationFromReply(relation(true, true, true))).toEqual({
			outcome: "allow",
			supersedesEverything: true,
		});
		// A partial supersession still allows, but the caller must route it away from a close.
		expect(decideRemUpdateRelationFromReply(relation(true, true, false))).toEqual({
			outcome: "allow",
			supersedesEverything: false,
		});
	});

	it("routes both negative answers to no_retired_fact", () => {
		expect(decideRemUpdateRelationFromReply(relation(false, true))).toEqual({
			outcome: "refuse",
			reason: "no_retired_fact",
		});
		expect(decideRemUpdateRelationFromReply(relation(true, false))).toEqual({
			outcome: "refuse",
			reason: "no_retired_fact",
		});
	});

	it("refuses an unparseable reply", () => {
		expect(decideRemUpdateRelationFromReply("{}")).toEqual({
			outcome: "refuse",
			reason: "model_response_invalid",
		});
	});
});

describe("the owner's law, enforced on the source itself", () => {
	const modulePath = resolve(
		import.meta.dirname,
		"../../../../packages/rem-core/src/rem-update-judgment.ts",
	);
	const source = readFileSync(modulePath, "utf8");

	it("no prompt on this path asks for offsets, spans, clauses, sentences or exact wording", () => {
		for (const prompt of [
			renderRemUpdateJudgmentPrompt({
				judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.rewrite,
				source: SOURCE,
			}),
			renderRemUpdateRelationJudgmentPrompt({
				judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.relation,
				rowText: SOURCE,
				predecessorTexts: ["older"],
				successorTexts: [],
			}),
			renderRemUpdateVerificationPrompt({
				judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.verification,
				source: SOURCE,
				proposedCurrent: "The user is drawn to books about tragedy.",
				retiredValues: ["books about social dynamics"],
			}),
		]) {
			// "verbatim" is allowed and load-bearing: it asks the model to QUOTE the retired
			// value from the row, which is what lets a human read the journal. It asks for no
			// position and imposes no wording rule on the rewrite.
			expect(prompt).not.toMatch(/offset|\bspan\b|zero-based|character position|clause|sentence|exact wording/iu);
		}
	});

	it("the module performs no substring or token comparison of model text", () => {
		expect(source).not.toMatch(/\.includes\(/u);
		expect(source).not.toMatch(/tokenize|normalizeForSubstring|sourceTokens/u);
		expect(source).not.toMatch(/\.startsWith\(|\.endsWith\(/u);
	});

	it("keeps judgment instructions in the bundled skill instead of the engine module", () => {
		expect(REM_UPDATE_JUDGMENT_SKILL.relation).toContain("replaces meaning");
		expect(REM_UPDATE_JUDGMENT_SKILL.rewrite).toContain("facts that remain current");
		expect(source).not.toContain("Judge the relation between");
		expect(source).not.toContain("A paraphrase that carries the same meaning");
	});
});
