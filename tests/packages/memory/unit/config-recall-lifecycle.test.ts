/**
 * Phase 0 §2 — recallLifecycle Zod schema with safe defaults.
 *
 * Pins every default in `recallLifecycleSchema` to PRD §6.1 values, asserts
 * the block defaults to `{}` so legacy configs continue to parse.
 *
 * Spec: openspec/changes/mem-lifecycle/specs/config/spec.md.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_RECALL_LIFECYCLE,
	type RecallLifecycleConfig,
	recallLifecycleSchema,
} from "@/config";

// PRD §6.1 pinned values. Changing any entry here SHALL require a new
// openspec change proposal — defaults SHALL NOT drift through casual edits.
const EXPECTED_DEFAULTS: RecallLifecycleConfig = {
	retentionScorer: true,
	tierPromoter: true,
	autoRecallAccessTracking: true,
	tierFloorMode: "bare",
	tierPromotionTopK: 3,
	accessRateLimitMs: 3_600_000,
	accessCountCeiling: 20,
	traceEnabled: true,
};

describe("recallLifecycleSchema — defaults pinned by PRD §6.1", () => {
	it("schema.parse({}) yields every default at the PRD §6.1 pinned value", () => {
		const parsed = recallLifecycleSchema.parse({});
		expect(parsed).toEqual(EXPECTED_DEFAULTS);
	});

	it("DEFAULT_RECALL_LIFECYCLE equals the schema defaults", () => {
		expect(DEFAULT_RECALL_LIFECYCLE).toEqual(EXPECTED_DEFAULTS);
	});

	it("parent config without a recallLifecycle key yields all defaults", () => {
		// Mirror the gateway-level integration: nest under a parent object that
		// itself defaults the whole block to `{}` so legacy configs missing the
		// key still produce the full pinned default set.
		const parentSchema = recallLifecycleSchema; // standalone block in Phase 0
		const parsed = parentSchema.parse(undefined);
		expect(parsed).toEqual(EXPECTED_DEFAULTS);
	});

	it("rejects tierFloorMode = 'bareWithFloor' with an enum violation", () => {
		const result = recallLifecycleSchema.safeParse({
			tierFloorMode: "bareWithFloor",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) =>
				i.path.includes("tierFloorMode"),
			);
			// zod 4 renamed the enum-violation code from `invalid_enum_value`.
			// The rejection itself is unchanged; only the code string moved.
			expect(issue?.code).toBe("invalid_value");
		}
	});

	it("rejects negative accessRateLimitMs", () => {
		const result = recallLifecycleSchema.safeParse({
			accessRateLimitMs: -1,
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const issue = result.error.issues.find((i) =>
				i.path.includes("accessRateLimitMs"),
			);
			expect(issue).toBeDefined();
		}
	});
});
