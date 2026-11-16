import { afterEach, beforeEach, expect, it } from "vitest";
import { createPrecisionCliFixture } from "../mem-claude/fixtures/precision-cli-fixture";

let fixture: Awaited<ReturnType<typeof createPrecisionCliFixture>>;
beforeEach(async () => { fixture = await createPrecisionCliFixture("cursor"); });
afterEach(async () => { await fixture?.close(); });

it("doctor keeps its four existing lines and appends the service's three-night lines", async () => {
	const result = await fixture.run(["doctor", "--cursor-home", fixture.home]);
	expect.soft(result.code, result.stderr).toBe(0);
	expect.soft(result.stdout.trimEnd().split("\n").slice(0, 4)).toEqual([
		"sidecar: healthy",
		"hooks: sessionStart=absent beforeSubmitPrompt=absent afterAgentResponse=absent stop=absent preCompact=absent sessionEnd=absent",
		"permission rule: absent",
		"IDE permission rule: absent",
	]);
	expect.soft(fixture.inspections).toEqual([{ op: "precision" }]);
	expect(result.stdout.trimEnd().split("\n").slice(4)).toEqual([
		"project 2026-11-15: checked 12, replaced 2, merged 1, corrected 3, removed 1, undecided 2",
		"shared 2026-11-15: checked 8, replaced 1, merged 0, corrected 2, removed 1, undecided 1",
		"project 2026-11-14: checked 7, replaced 1, merged 2, corrected 0, removed 1, undecided 1",
		"shared 2026-11-14: checked 5, replaced 0, merged 1, corrected 1, removed 1, undecided 0",
		"project 2026-11-13: checked 6, replaced 2, merged 0, corrected 1, removed 0, undecided 1",
		"shared 2026-11-13: checked 4, replaced 0, merged 0, corrected 1, removed 1, undecided 1",
	]);
});

it("correct --undo sends the undo mutation and prints its result", async () => {
	const result = await fixture.run(["correct", "--undo", "wrong-rule"]);
	expect.soft(fixture.mutations).toEqual([{ op: "undo", id: "wrong-rule" }]);
	expect.soft(result.code, result.stderr).toBe(0);
	expect(result.stdout).toBe("restored-rule\n");
});
