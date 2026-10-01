/** Current model-judgment coverage plus production-entry acceptance. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	decideRemUpdateRelationFromReply,
	decideRemUpdateVerification,
	renderRemUpdateRelationJudgmentPrompt,
} from "../../../../packages/memory/src/engine/rem/index.ts";
import { REM_UPDATE_JUDGMENT_SKILL } from "../../../../packages/memory/src/sidecar/rem-update-judgment-skill.ts";
import {
	seedProductionMemory,
	startRemProductionEntryFixture,
} from "../../../apps/mem-claw/helpers/rem-production-entry-fixture.ts";
import { startRemScriptedModelFixture } from "../../../apps/mem-claw/helpers/rem-scripted-model-fixture.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const judgmentSource = readFileSync(
	resolve(repoRoot, "packages/memory/src/engine/rem/rem-update-judgment.ts"),
	"utf8",
);
const executorSource = readFileSync(
	resolve(repoRoot, "packages/memory/src/sidecar/rem-batch-executor.ts"),
	"utf8",
);

describe("REM model relation surface", () => {
	it("keeps the relation schema in the model-judgment module", () => {
		expect(judgmentSource).toMatch(/relationJudgmentSchema\s*=\s*z/u);
		expect(executorSource).not.toMatch(/relationJudgmentSchema\s*=\s*z/u);
	});

	it("asks the model for all three relation decisions", () => {
		const prompt = renderRelationPrompt();
		for (const field of ["supersedes", "retires_anything", "supersedes_everything"]) {
			expect(prompt).toContain(field);
		}
	});

	it("refuses a malformed relation reply", () => {
		expect(decideRemUpdateRelationFromReply("not-json")).toEqual({
			outcome: "refuse",
			reason: "model_response_invalid",
		});
	});

	it("imports the model relation decision into the production executor", () => {
		expect(executorSource).toContain("decideRemUpdateRelationFromReply");
	});

	it("calls the model relation decision in the update path", () => {
		expect(executorSource).toMatch(/decideRemUpdateRelationFromReply\s*\(/u);
	});
});

describe("REM model-derived update route", () => {
	it("keeps rewrite shape out of the relation response schema", () => {
		const schema = judgmentSource.match(/relationJudgmentSchema[\s\S]*?\.strict\(\)/u)?.[0] ?? "";
		expect(schema).not.toMatch(/rewrite[_A-Z-]?shape/iu);
	});

	it("routes a total supersession from the model decision", () => {
		expect(
			decideRemUpdateRelationFromReply(
				'{"supersedes":true,"retires_anything":true,"supersedes_everything":true}',
			),
		).toEqual({ outcome: "allow", supersedesEverything: true });
	});

	it("routes a partial supersession from the model decision", () => {
		expect(
			decideRemUpdateRelationFromReply(
				'{"supersedes":true,"retires_anything":true,"supersedes_everything":false}',
			),
		).toEqual({ outcome: "allow", supersedesEverything: false });
	});
});

describe("REM invalid relation replies", () => {
	it("refuses an absent reply", () => {
		expect(decideRemUpdateRelationFromReply("")).toEqual({
			outcome: "refuse",
			reason: "model_response_invalid",
		});
	});

	it("refuses a reply with the wrong fields", () => {
		expect(decideRemUpdateRelationFromReply('{"decision":"replace"}')).toEqual({
			outcome: "refuse",
			reason: "model_response_invalid",
		});
	});
});

describe("REM relation evidence rendering", () => {
	it("preserves a changed row under judgment", () => {
		const first = renderRelationPrompt();
		const second = renderRemUpdateRelationJudgmentPrompt({
			judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.relation,
			rowText: "The user now prefers a window desk.",
			predecessorTexts: ["The user preferred a standing desk."],
			successorTexts: ["The user also prefers quiet."],
		});
		expect(second).not.toBe(first);
		expect(second).toContain("window desk");
	});

	it("preserves changed predecessor evidence", () => {
		const prompt = renderRemUpdateRelationJudgmentPrompt({
			judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.relation,
			rowText: "The user prefers a quiet desk.",
			predecessorTexts: ["The user preferred a garden desk."],
			successorTexts: [],
		});
		expect(prompt).toContain("garden desk");
	});

	it("preserves changed related-record evidence", () => {
		const prompt = renderRemUpdateRelationJudgmentPrompt({
			judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.relation,
			rowText: "The user prefers a quiet desk.",
			predecessorTexts: [],
			successorTexts: ["The user also prefers a library."],
		});
		expect(prompt).toContain("library");
	});
});

describe("REM model verification", () => {
	it("refuses when the model reports a surviving fact was lost", () => {
		expect(
			decideRemUpdateVerification(
				'{"faithful":true,"retired_absent":true,"all_facts_accounted":false}',
			),
		).toEqual({ outcome: "refuse", reason: "surviving_fact_lost" });
	});

	it("applies when the model verifies all three conditions", () => {
		expect(
			decideRemUpdateVerification(
				'{"faithful":true,"retired_absent":true,"all_facts_accounted":true}',
			),
		).toEqual({ outcome: "apply" });
	});
});

describe("ACC-37 production edge: live judgment decisions", () => {
	it("makes model relation and verification decisions control the durable write", { timeout: 90_000 }, async () => {
		const model = await startRemScriptedModelFixture([
			'{"supersedes":true,"retires_anything":true,"supersedes_everything":true}',
			'{"faithful":true,"retired_absent":true,"all_facts_accounted":true}',
		]);
		const fixture = await startRemProductionEntryFixture({ gpuBaseUrl: model.url });
		try {
			const scope = "persona:production-live-judgment";
			const affirmativeId = seedProductionMemory(fixture.database.sqlite, {
				id: "clremjudgmentaffirmative0001",
				metadata: { section_name: "preferences.tea", topic: "preferences.tea" },
				scope,
				text: "The user likes jasmine tea every afternoon.",
				timestamp: "2026-08-08T08:00:00.000Z",
			});
			const retractionId = seedProductionMemory(fixture.database.sqlite, {
				id: "clremjudgmentretraction00001",
				metadata: { section_name: "preferences.tea", topic: "preferences.tea" },
				scope,
				text: "The user no longer likes jasmine tea in the afternoon.",
				timestamp: "2026-08-09T08:00:00.000Z",
			});
			const unsupportedId = seedProductionMemory(fixture.database.sqlite, {
				id: "clremjudgmentunsupported001",
				metadata: {
					rem_retired_section: "preferences.workspace",
					section_name: "preferences.workspace",
					topic: "preferences.workspace",
				},
				scope,
				text: "A model advisory guesses that the user prefers a standing desk.",
				timestamp: "2026-08-09T08:01:00.000Z",
			});
			const beforeUnsupported = fixture.database.sqlite
				.prepare("SELECT * FROM nodix_memories WHERE id = ?")
				.get(unsupportedId);
			const started = await fixture.submit(
				"rem-update",
				scope,
				"correlation-production-live-judgment",
			);
			const identity = productionIdentity(started);
			const terminal = await fixture.waitForTerminal(identity, 80_000);
			expect(terminal["state"]).toBe("done");
			expect(
				fixture.database.sqlite
					.prepare("SELECT facet FROM nodix_rem_memory_facets WHERE memory_id = ?")
					.all(affirmativeId),
			).toEqual([{ facet: "history" }]);
			expect(
				fixture.database.sqlite
					.prepare("SELECT facet FROM nodix_rem_memory_facets WHERE memory_id = ?")
					.all(retractionId),
			).toEqual([{ facet: "current" }]);
			expect(
				fixture.database.sqlite
					.prepare("SELECT * FROM nodix_memories WHERE id = ?")
					.get(unsupportedId),
			).toEqual(beforeUnsupported);
			expect(
				fixture.database.sqlite
					.prepare("SELECT outcome FROM nodix_rem_write_attempts WHERE job_id = ?")
					.all(identity),
			).toContainEqual({ outcome: "succeeded" });
			expect(model.requestCount()).toBe(2);
		} finally {
			await fixture.stop();
			await model.close();
		}
	});
});

function renderRelationPrompt(): string {
	return renderRemUpdateRelationJudgmentPrompt({
		judgmentSkill: REM_UPDATE_JUDGMENT_SKILL.relation,
		rowText: "The user prefers a quiet desk.",
		predecessorTexts: ["The user preferred a standing desk."],
		successorTexts: ["The user also prefers quiet."],
	});
}

function productionIdentity(response: Record<string, unknown>): string {
	for (const key of ["waveId", "wave_id", "job_id"]) {
		const value = response[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	throw new Error(`production response omitted wave identity: ${JSON.stringify(response)}`);
}
