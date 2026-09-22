/** @file memory-support-info.test.ts
 * @purpose Regression coverage for updateSupportStats event-time handling.
 * @boundary Pure function; no DB, no LLM, no mocks needed.
 *
 * Guards the out-of-order replay regression: support observations carry a
 * session event time (`at`), so a historical session replayed or imported
 * after a newer one must not drag an existing slice's `last_observed_at`
 * backward — the newest-N prune would otherwise drop a genuinely recent slice.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_SUPPORT_SLICES,
	type SupportInfoV2,
	updateSupportStats,
} from "../../../../packages/memory/src/engine/extraction/memory-support-info.ts";

const EMPTY: SupportInfoV2 = { global_strength: 0.5, total_observations: 0, slices: [] };

describe("updateSupportStats event-time handling", () => {
	it("does not move an existing slice's last_observed_at backward on out-of-order replay", () => {
		const tNew = Date.parse("2025-09-15T00:00:00Z");
		const tOld = Date.parse("2025-01-10T00:00:00Z");

		const afterNew = updateSupportStats(EMPTY, "work", "support", tNew);
		expect(afterNew.slices[0]?.last_observed_at).toBe(tNew);

		// An OLDER session supports the same context after the newer one.
		const afterOld = updateSupportStats(afterNew, "work", "support", tOld);
		const work = afterOld.slices.find((s) => s.context === "work");

		// The observation still counts...
		expect(work?.confirmations).toBe(2);
		// ...but the event time must stay at the newest observation.
		expect(work?.last_observed_at).toBe(tNew);
	});

	it("advances last_observed_at when a newer observation arrives", () => {
		const tOld = Date.parse("2025-01-10T00:00:00Z");
		const tNew = Date.parse("2025-09-15T00:00:00Z");

		const afterOld = updateSupportStats(EMPTY, "work", "support", tOld);
		const afterNew = updateSupportStats(afterOld, "work", "support", tNew);
		const work = afterNew.slices.find((s) => s.context === "work");

		expect(work?.confirmations).toBe(2);
		expect(work?.last_observed_at).toBe(tNew);
	});

	it("keeps a recent slice from being pruned when an out-of-order older observation arrives", () => {
		const base = Date.parse("2025-02-01T00:00:00Z");
		const day = 24 * 60 * 60 * 1000;

		// Fill exactly MAX_SUPPORT_SLICES slices at strictly increasing times.
		let info = EMPTY;
		for (let i = 0; i < MAX_SUPPORT_SLICES; i++) {
			info = updateSupportStats(info, `ctx-${i}`, "support", base + i * day);
		}
		expect(info.slices).toHaveLength(MAX_SUPPORT_SLICES);

		// The newest slice (ctx-7) receives an out-of-order, far-older
		// observation. Its real recency must be preserved.
		const newestContext = `ctx-${MAX_SUPPORT_SLICES - 1}`;
		info = updateSupportStats(info, newestContext, "support", base - 100 * day);

		// A brand-new context forces a prune back down to MAX_SUPPORT_SLICES.
		info = updateSupportStats(info, "ctx-new", "support", base + 100 * day);

		expect(info.slices).toHaveLength(MAX_SUPPORT_SLICES);
		const kept = new Set(info.slices.map((s) => s.context));
		// The genuinely-recent slice survives; the genuinely-oldest is dropped.
		expect(kept.has(newestContext)).toBe(true);
		expect(kept.has("ctx-0")).toBe(false);
	});
});
