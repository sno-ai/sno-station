import { describe, expect, it } from "vitest";
import {
	MEMORY_TELEMETRY_EVENT_TYPES,
	isMemoryTelemetryEventType,
	type MemoryTelemetryEventType,
} from "../../../../apps/mem-claw/src/telemetry/memory-telemetry-types.ts";
import { validateMemoryTelemetryMetadata } from "../../../../apps/mem-claw/src/telemetry/memory-telemetry-metadata.ts";

describe("memory telemetry metadata validation", () => {
	it("accepts the canonical event enum and rejects removed names", () => {
		expect(MEMORY_TELEMETRY_EVENT_TYPES).toEqual([
			"create",
			"update",
			"recall",
			"supersede",
			"delete",
			"inject",
			"epoch_boundary",
			"purge",
		]);

		for (const eventType of MEMORY_TELEMETRY_EVENT_TYPES) {
			expect(isMemoryTelemetryEventType(eventType)).toBe(true);
		}
		for (const removed of ["write", "forget", "evict", "unknown"]) {
			expect(isMemoryTelemetryEventType(removed)).toBe(false);
			expect(() => validateMemoryTelemetryMetadata(removed as MemoryTelemetryEventType, {})).toThrow(
				/Unsupported memory telemetry event type/,
			);
		}
	});

	it("accepts only per-event allowlisted metadata keys", () => {
		expect(
			validateMemoryTelemetryMetadata("recall", {
				dense_score: 0.8,
				bm25_score: 0.4,
				fused_score: 0.7,
				rerank_score: 0.9,
				mmr_score: 0.6,
				retrieval_rank: 1,
				retrieval_score: 0.9,
			}),
		).toEqual({
			dense_score: 0.8,
			bm25_score: 0.4,
			fused_score: 0.7,
			rerank_score: 0.9,
			mmr_score: 0.6,
			retrieval_rank: 1,
			retrieval_score: 0.9,
		});

		expect(() =>
			validateMemoryTelemetryMetadata("recall", {
				retrieval_rank: 1,
				delete_reason: "memory_forget",
			}),
		).toThrow(/not allowed for recall/);

		expect(
			validateMemoryTelemetryMetadata("inject", {
				injection_surface: "reflection_inherited_rules",
				retrieval_rank: 1,
				retrieval_score: 0.9,
				source_agent_id: "main",
			}),
		).toEqual({
			injection_surface: "reflection_inherited_rules",
			retrieval_rank: 1,
			retrieval_score: 0.9,
			source_agent_id: "main",
		});
	});

	it("rejects raw content keys for every event type", () => {
		for (const eventType of MEMORY_TELEMETRY_EVENT_TYPES) {
			for (const rawKey of ["text", "l0_abstract", "l1_overview", "l2_content", "content"]) {
				expect(() => validateMemoryTelemetryMetadata(eventType, { [rawKey]: "raw memory text" })).toThrow(
					/raw content/i,
				);
			}
		}
	});

	it("requires a non-empty delete reason for delete events", () => {
		expect(validateMemoryTelemetryMetadata("delete", { delete_reason: "memory_forget" })).toEqual({
			delete_reason: "memory_forget",
		});
		expect(() => validateMemoryTelemetryMetadata("delete", {})).toThrow(/delete_reason/);
		expect(() => validateMemoryTelemetryMetadata("delete", { delete_reason: "" })).toThrow(
			/delete_reason/,
		);
	});
});
