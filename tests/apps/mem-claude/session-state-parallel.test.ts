/** Tool hooks run as parallel processes on one session file; no update may be lost. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSession, updateSession } from "../../../apps/mem-claude/src/session-state.js";

describe("mem-claude session state under parallel hooks", () => {
	let profile: string;
	beforeEach(async () => {
		profile = await mkdtemp(join(tmpdir(), "session-parallel-"));
		process.env["SNO_PROFILE_DIR"] = profile;
	});
	afterEach(async () => {
		delete process.env["SNO_PROFILE_DIR"];
		await rm(profile, { recursive: true, force: true });
	});

	it("keeps every tool start and receipt count when 30 updates run at once", async () => {
		const ids = Array.from({ length: 30 }, (_, index) => `tool-${index}`);
		await Promise.all(ids.map(id => updateSession("s1", (state) => {
			state.toolStarts[id] = 1;
			state.receipt["PostToolUse"] = { ...(state.receipt["PostToolUse"] ?? { invocations: 0, lookups: 0, itemsInjected: 0, charsInjected: 0, skips: {}, degraded: {}, resets: 0, latencyMs: [] }) };
			state.receipt["PostToolUse"].invocations += 1;
		})));
		const state = await readSession("s1");
		expect(Object.keys(state.toolStarts).sort()).toEqual([...ids].sort());
		expect(state.receipt["PostToolUse"]?.invocations).toBe(30);
	});
});
