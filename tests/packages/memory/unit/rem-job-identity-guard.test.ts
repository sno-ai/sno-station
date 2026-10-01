/** @file rem-job-identity-guard.test.ts
 * @purpose Proves a REM write is refused outright when its audit identity is not real.
 * @boundary assertJobIdentity, the guard all three REM journal writers call before opening a transaction.
 * @see rem-batch-crash-resume.test.ts, rem-defect-repair.test.ts.
 *
 * Why this exists. Three journal writes used to take the job id and job type as optional arguments,
 * so whether a refusal survived in the ledger depended on a caller remembering to pass them. Making
 * them required fixes the callers the compiler can see; it does not fix the ones it cannot. A
 * required `string` still accepts `""`, the journal's columns are `NOT NULL` but not non-blank, and
 * a child process or JavaScript entry point can pass nothing at all — which is exactly what one
 * crash-resume helper was doing.
 *
 * The rule this pins: no valid identity, no write. The guard refuses the operation rather than
 * writing an unattributable row, and it says which value was wrong instead of dying on it.
 */

import { describe, expect, it } from "vitest";
import { assertJobIdentity } from "../../../../packages/memory/src/engine/rem/types.ts";

describe("assertJobIdentity", () => {
	it("accepts every operation type the system defines", () => {
		for (const jobType of ["rem-update", "rem-replace", "rem-distill", "rem-retire"]) {
			expect(() => assertJobIdentity("wave-1", jobType)).not.toThrow();
		}
	});

	it("refuses a blank job id and prints the value it refused", () => {
		// Whitespace, not just empty: the column check is NOT NULL, which " " satisfies.
		expect(() => assertJobIdentity("   ", "rem-update")).toThrow(/non-blank job id/u);
		expect(() => assertJobIdentity("", "rem-update")).toThrow(/non-blank job id/u);
	});

	it("refuses an absent job id without dying on it", () => {
		// The failure that motivated the type check: a child-process caller passes nothing, and the
		// guard used to throw `Cannot read properties of undefined` — louder than silence, but it
		// named neither the field nor the caller's mistake.
		const absent = undefined as unknown as string;
		expect(() => assertJobIdentity(absent, "rem-update")).toThrow(/non-blank job id, got: undefined/u);
	});

	it("refuses a job type outside the defined set, including one that merely looks right", () => {
		expect(() => assertJobIdentity("wave-1", "rem-update-v2")).toThrow(/known job type/u);
		expect(() => assertJobIdentity("wave-1", "")).toThrow(/known job type/u);
		const absent = undefined as unknown as string;
		expect(() => assertJobIdentity("wave-1", absent)).toThrow(/known job type, got: undefined/u);
	});
});
