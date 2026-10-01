/** Blank model action arguments return the invalid-input result. */
import { expect, it } from "vitest";
import { correctCommand, getCommand, recallCommand, rememberCommand } from "../../../apps/mem-codex/src/explicit";

it("rejects blank arguments to each model action", async () => {
	for (const result of [
		await recallCommand(" "), await getCommand(" "), await rememberCommand(" "),
		await correctCommand("", "a corrected fact"), await correctCommand("memory-id", " "),
	]) expect(result).toEqual({ ok: false, text: "invalid-input" });
});
