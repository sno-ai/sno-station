import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../apps/mem-claw/src/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../apps/mem-claw/src/storage/store.ts";
import {
	createMemoryTelemetryApi,
	type MemoryTelemetryUsageSummaryResult,
} from "../../../../apps/mem-claw/src/telemetry/memory-telemetry-api.ts";
import {
	forwardMemoryTelemetryToObserve,
	type MemoryTelemetryObserveEmitInput,
} from "../../../../apps/mem-claw/src/telemetry/memory-telemetry-sno-observe.ts";
import { MemoryTelemetryUsageOutbox } from "../../../../apps/mem-claw/src/telemetry/memory-telemetry-outbox.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

function readWatermark(store: MemoryStore): number {
	const row = store.sqlite
		.prepare("SELECT last_event_id FROM nodix_memory_telemetry_sync_state WHERE sink = ?")
		.get("sno-observe") as { last_event_id: number } | undefined;
	return row?.last_event_id ?? 0;
}

describe("memory telemetry sno-observe forwarding", () => {
	let cleanup: () => void;
	let dbPath: string;
	let store: MemoryStore;
	let originalTelemetryKey: string | undefined;

	beforeEach(() => {
		originalTelemetryKey = process.env.SNO_MEM_TELEMETRY_HMAC_KEY;
		process.env.SNO_MEM_TELEMETRY_HMAC_KEY = "memory-telemetry-observe-test-key";
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
	});

	afterEach(async () => {
		await store.close();
		cleanup();
		if (originalTelemetryKey === undefined) {
			delete process.env.SNO_MEM_TELEMETRY_HMAC_KEY;
		} else {
			process.env.SNO_MEM_TELEMETRY_HMAC_KEY = originalTelemetryKey;
		}
	});

	it("forwards only after local rows exist and advances the watermark only after success", async () => {
		const emitted: MemoryTelemetryObserveEmitInput[] = [];
		const idle = await forwardMemoryTelemetryToObserve({
			sqlite: store.sqlite,
			observe: {
				tryEmit: async (input) => {
					emitted.push(input);
					return true;
				},
			},
		});
		expect(idle).toEqual({ status: "idle", forwarded: 0, lastEventId: 0 });
		expect(emitted).toHaveLength(0);
		expect(readWatermark(store)).toBe(0);

		const stored = await store.store({
			text: "Telemetry observe raw sentinel must stay local",
			category: "episodic",
			projectId: "telemetry-observe",
		});
		const factId = stored.factId ?? stored.id;
		const outbox = new MemoryTelemetryUsageOutbox({
			sqlite: store.sqlite,
			dbPath,
			agentId: "memory-telemetry-observe",
		});
		outbox.acceptUsage({
			eventType: "recall",
			factId,
			memoryKind: "episodic",
			projectId: "telemetry-observe",
			agentId: "memory-telemetry-observe",
			sessionUuid: "session-observe",
			turnId: "turn-observe",
			retrievalRank: 1,
			retrievalScore: 0.88,
			metadata: { retrieval_rank: 1, retrieval_score: 0.88 },
		});
		outbox.flushPending();
		const api = createMemoryTelemetryApi({ sqlite: store.sqlite });
		const usageBeforeFailure: MemoryTelemetryUsageSummaryResult = api.usageSummary({ factId });

		const failed = await forwardMemoryTelemetryToObserve({
			sqlite: store.sqlite,
			observe: {
				tryEmit: async () => {
					throw new Error("sno-observe unavailable");
				},
			},
		});
		expect(failed).toEqual({ status: "failed", forwarded: 0, lastEventId: 0 });
		expect(readWatermark(store)).toBe(0);
		expect(api.usageSummary({ factId })).toEqual(usageBeforeFailure);

		const success = await forwardMemoryTelemetryToObserve({
			sqlite: store.sqlite,
			observe: {
				tryEmit: async (input) => {
					emitted.push(input);
					return true;
				},
			},
		});
		expect(success).toEqual({ status: "forwarded", forwarded: 2, lastEventId: 2 });
		expect(readWatermark(store)).toBe(2);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toEqual(
			expect.objectContaining({
				eventType: "memory.telemetry",
				payload: expect.objectContaining({
					sync_kind: "nodix_memory_events",
					first_event_id: 1,
					last_event_id: 2,
					event_count: 2,
					events: [
						expect.objectContaining({ event_id: 1, event_type: "create", fact_id: factId }),
						expect.objectContaining({ event_id: 2, event_type: "recall", fact_id: factId }),
					],
				}),
			}),
		);
		expect(JSON.stringify(emitted[0])).not.toContain("Telemetry observe raw sentinel");

		const duplicate = await forwardMemoryTelemetryToObserve({
			sqlite: store.sqlite,
			observe: {
				tryEmit: async (input) => {
					emitted.push(input);
					return true;
				},
			},
		});
		expect(duplicate).toEqual({ status: "idle", forwarded: 0, lastEventId: 2 });
		expect(emitted).toHaveLength(1);
	});
});
