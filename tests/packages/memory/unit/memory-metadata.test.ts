/** @file memory-metadata.test.ts
 * @purpose RED test for mem-lifecycle Phase 0 §1: MemoryMetadata type contract.
 * @boundary Type-only — verifies the structural shape from the spec is exported.
 */

import { describe, expect, it } from "vitest";
import { parseAccessMetadata } from "../../../../apps/mem-claw/src/retrieval/access-tracker.ts";
import type { MemoryMetadata } from "../../../../apps/mem-claw/src/shared/types.ts";

describe("MemoryMetadata structural type", () => {
	it("accepts a fully populated record with all PRD §6.1 fields", () => {
		const full: MemoryMetadata = {
			accessCount: 3,
			lastAccessedAt: 1700000000000,
			last_bad_recall_at: 1700000001000,
			bad_recall_count: 1,
			suppressed_until_ms: 1700000060000,
			intrinsic: {
				confidence: 0.7,
				importance: 0.9,
			},
		};

		expect(full.accessCount).toBe(3);
		expect(full.intrinsic?.confidence).toBe(0.7);
		expect(full.intrinsic?.importance).toBe(0.9);
		expect(full.suppressed_until_ms).toBe(1700000060000);
	});

	it("accepts the empty record (all fields optional)", () => {
		const empty: MemoryMetadata = {};
		expect(empty).toEqual({});
	});

	it("rejects unknown fields at compile time", () => {
		// Once MemoryMetadata is exported and structurally exact, the typo below must
		// produce a TS2353 error. Until the type lands this whole file fails at the import,
		// so the @ts-expect-error directive carries the gate for the post-impl GREEN phase.
		const sample = {
			// @ts-expect-error — `accessCunt` is a typo; MemoryMetadata must NOT allow extra keys
			accessCunt: 1,
		} satisfies MemoryMetadata;
		expect(sample).toBeDefined();
	});

	it("parseAccessMetadata output is assignable to Partial<MemoryMetadata>", () => {
		const parsed = parseAccessMetadata(JSON.stringify({ accessCount: 5, lastAccessedAt: 123 }));
		const asPartial: Partial<MemoryMetadata> = parsed;
		expect(asPartial.accessCount).toBe(5);
		expect(asPartial.lastAccessedAt).toBe(123);
	});
});
