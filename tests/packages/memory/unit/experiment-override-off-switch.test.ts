/** @file experiment-override-off-switch.test.ts
 * Block 210's measurement-only overrides must be OFF unless the experiment
 * harness asks for them, and must refuse a value that cannot be a pool size.
 *
 * These are read at call time rather than at import time, because the harness
 * sets them on a server process that has already loaded the module. A reader
 * that captured the value at import would silently serve the shipped default
 * and report the cell as if it had run.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	experimentCandidatePoolOverride,
	experimentMmrDisabled,
} from "../../../../packages/sno-station-mem/config/index.ts";

const POOL = "MEM_CLAW_EXPERIMENT_CANDIDATE_POOL_SIZE";
const MMR = "MEM_CLAW_EXPERIMENT_DISABLE_MMR";

describe("block 210 experiment overrides", () => {
	let savedPool: string | undefined;
	let savedMmr: string | undefined;

	beforeEach(() => {
		savedPool = process.env[POOL];
		savedMmr = process.env[MMR];
		delete process.env[POOL];
		delete process.env[MMR];
	});

	afterEach(() => {
		if (savedPool === undefined) delete process.env[POOL];
		else process.env[POOL] = savedPool;
		if (savedMmr === undefined) delete process.env[MMR];
		else process.env[MMR] = savedMmr;
	});

	it("are off when nothing sets them — the shipped default path", () => {
		expect(experimentCandidatePoolOverride()).toBeUndefined();
		expect(experimentMmrDisabled()).toBe(false);
	});

	it("take effect only while the variable is set, and go back off when it is cleared", () => {
		process.env[POOL] = "200";
		process.env[MMR] = "1";
		expect(experimentCandidatePoolOverride()).toBe(200);
		expect(experimentMmrDisabled()).toBe(true);

		delete process.env[POOL];
		delete process.env[MMR];
		expect(experimentCandidatePoolOverride()).toBeUndefined();
		expect(experimentMmrDisabled()).toBe(false);
	});

	it("refuse a pool value that is not a usable row count", () => {
		// "1e3" is deliberately absent: it parses to 1000, which is a usable row
		// count, so refusing it would be the defect rather than the guard.
		for (const bad of ["", "  ", "0", "-5", "12.5", "abc", "NaN", "Infinity"]) {
			process.env[POOL] = bad;
			expect(experimentCandidatePoolOverride()).toBeUndefined();
		}
	});

	it("treat any MMR value other than the exact flag as off", () => {
		for (const notSet of ["", "0", "true", "yes", "on", "11"]) {
			process.env[MMR] = notSet;
			expect(experimentMmrDisabled()).toBe(false);
		}
	});
});
