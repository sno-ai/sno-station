import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { SqliteDatabaseLike } from "../../../../packages/sno-station-mem/src/store/sqlite-runtime.ts";
import type { MemoryTelemetryKeySet } from "../../../../packages/sno-station-mem/src/engine/telemetry/memory-telemetry-config.ts";
import { MemoryTelemetryEventWriter } from "../../../../packages/sno-station-mem/src/engine/telemetry/memory-telemetry-events.ts";
import {
	MemoryTelemetryUsageOutbox,
	type MemoryTelemetryUsageInput,
} from "../../../../packages/sno-station-mem/src/engine/telemetry/memory-telemetry-outbox.ts";
import { createTestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const ITERATIONS = 80;
const WARMUP_ITERATIONS = 8;
const WRITE_DELTA_P99_BUDGET_MS = 6;
const READ_DELTA_P99_BUDGET_MS = 1;

interface TimedSample {
	label: string;
	ms: number;
}

function p99(samples: readonly number[]): number {
	const sorted = [...samples].sort((left, right) => left - right);
	const index = Math.max(0, Math.ceil(sorted.length * 0.99) - 1);
	return sorted[index] ?? 0;
}

function measureSyncDelta(
	label: string,
	baseline: (index: number) => void,
	instrumented: (index: number) => void,
): number {
	const samples: TimedSample[] = [];
	for (let index = 0; index < ITERATIONS + WARMUP_ITERATIONS; index += 1) {
		let baselineElapsed: number;
		let instrumentedElapsed: number;
		if (index % 2 === 0) {
			const baselineStarted = performance.now();
			baseline(index);
			baselineElapsed = performance.now() - baselineStarted;
			const instrumentedStarted = performance.now();
			instrumented(index);
			instrumentedElapsed = performance.now() - instrumentedStarted;
		} else {
			const instrumentedStarted = performance.now();
			instrumented(index);
			instrumentedElapsed = performance.now() - instrumentedStarted;
			const baselineStarted = performance.now();
			baseline(index);
			baselineElapsed = performance.now() - baselineStarted;
		}
		const delta = Math.max(0, instrumentedElapsed - baselineElapsed);
		if (index >= WARMUP_ITERATIONS) {
			samples.push({ label, ms: delta });
		}
	}
	expect(samples).toHaveLength(ITERATIONS);
	return p99(samples.map((sample) => sample.ms));
}

function contentHash(label: string, index: number): string {
	return createHash("sha256").update(`${label}:${index}`).digest("hex");
}

function telemetryKeySet(): MemoryTelemetryKeySet {
	return {
		enabled: true,
		current: { version: 1, key: "memory-telemetry-performance-key" },
		historic: new Map(),
	};
}

function usageInput(
	eventType: MemoryTelemetryUsageInput["eventType"],
	index: number,
): MemoryTelemetryUsageInput {
	const rank = (index % 5) + 1;
	const score = 1 - rank / 10;
	return {
		eventType,
		factId: `${eventType}-fact-${index}`,
		memoryKind: "episodic",
		projectId: "memory-telemetry-performance",
		agentId: "memory-telemetry-performance",
		sessionUuid: "session-performance",
		turnId: `turn-${index}`,
		retrievalRank: rank,
		retrievalScore: score,
		metadata:
			eventType === "recall"
				? {
						retrieval_rank: rank,
						retrieval_score: score,
						dense_score: score,
						bm25_score: score,
						fused_score: score,
					}
				: {
						injection_surface: "auto_recall",
						retrieval_rank: rank,
						retrieval_score: score,
					},
	};
}

function createWritePair(): {
	baseline: SqliteDatabaseLike;
	instrumented: SqliteDatabaseLike;
	writer: MemoryTelemetryEventWriter;
	cleanup: () => void;
} {
	const baselineDb = createTestDb();
	const instrumentedDb = createTestDb();
	const writer = new MemoryTelemetryEventWriter({
		sqlite: instrumentedDb.sqlite,
		config: { keySet: telemetryKeySet() },
	});
	return {
		baseline: baselineDb.sqlite,
		instrumented: instrumentedDb.sqlite,
		writer,
		cleanup: () => {
			baselineDb.sqlite.close();
			instrumentedDb.sqlite.close();
			instrumentedDb.cleanup();
			baselineDb.cleanup();
		},
	};
}

function insertPrimaryMemory(sqlite: SqliteDatabaseLike, label: string, index: number): void {
	const hash = contentHash(label, index);
	sqlite
		.prepare(
			`INSERT INTO nodix_memories
			 (id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash, fact_id)
			 VALUES (?, ?, 'episodic', 'memory-telemetry-performance', 0.5, ?, 'UTC', '{}', ?, ?)`,
		)
		.run(
			`${label}-${index}`,
			`Memory telemetry performance primary row ${label} ${index}`,
			1_700_000_000_000 + index,
			hash,
			`${label}-${index}`,
		);
}

function updatePrimaryMemory(sqlite: SqliteDatabaseLike, label: string, index: number): string {
	const hash = contentHash(`${label}:updated`, index);
	sqlite
		.prepare(
			`UPDATE nodix_memories
			 SET text = ?, metadata = ?, content_hash = ?
			 WHERE id = ?`,
		)
		.run(
			`Memory telemetry performance primary row ${label} ${index} updated`,
			JSON.stringify({ support_info: "updated" }),
			hash,
			`${label}-${index}`,
		);
	return hash;
}

function createOutbox(): {
	outbox: MemoryTelemetryUsageOutbox;
	cleanup: () => void;
	rowCount: () => number;
} {
	const db = createTestDb();
	const outbox = new MemoryTelemetryUsageOutbox({
		sqlite: db.sqlite,
		dbPath: db.dbPath,
		agentId: "memory-telemetry-performance",
	});
	return {
		outbox,
		cleanup: () => {
			db.sqlite.close();
			db.cleanup();
		},
		rowCount: () =>
			(
				db.sqlite
					.prepare("SELECT COUNT(*) AS count FROM nodix_memory_usage_outbox")
					.get() as { count: number }
			).count,
	};
}

describe("memory telemetry performance gate", () => {
	it("keeps create and update Tier-1 write p99 delta under 5ms", () => {
		const createPair = createWritePair();
		try {
			const createDeltaP99 = measureSyncDelta(
				"create-delta",
				(index) => {
					createPair.baseline.transaction(() => {
						insertPrimaryMemory(createPair.baseline, "baseline-create", index);
					})();
				},
				(index) => {
					createPair.instrumented.transaction(() => {
						const factId = `instrumented-create-${index}`;
						const hash = contentHash("instrumented-create", index);
						insertPrimaryMemory(createPair.instrumented, "instrumented-create", index);
						createPair.writer.writeReceiptEvent({
							eventType: "create",
							factId,
							memoryKind: "episodic",
							projectId: "memory-telemetry-performance",
							contentHash: hash,
							metadata: {
								operation_source: "performance-test",
								content_hash: hash,
								receipt_status: "signed",
							},
						});
					})();
				},
			);
			console.info("memory telemetry create p99", JSON.stringify({ createDeltaP99 }));
			expect(createDeltaP99).toBeLessThanOrEqual(WRITE_DELTA_P99_BUDGET_MS);
		} finally {
			createPair.cleanup();
		}

		const updatePair = createWritePair();
		try {
			for (let index = 0; index < ITERATIONS + WARMUP_ITERATIONS; index += 1) {
				insertPrimaryMemory(updatePair.baseline, "baseline-update", index);
				insertPrimaryMemory(updatePair.instrumented, "instrumented-update", index);
			}
			const updateDeltaP99 = measureSyncDelta(
				"update-delta",
				(index) => {
					updatePair.baseline.transaction(() => {
						updatePrimaryMemory(updatePair.baseline, "baseline-update", index);
					})();
				},
				(index) => {
					updatePair.instrumented.transaction(() => {
						const hash = updatePrimaryMemory(updatePair.instrumented, "instrumented-update", index);
						updatePair.writer.writeReceiptEvent({
							eventType: "update",
							factId: `instrumented-update-${index}`,
							memoryKind: "episodic",
							projectId: "memory-telemetry-performance",
							contentHash: hash,
							metadata: {
								changed_keys: ["text", "content_hash"],
								content_hash: hash,
							},
						});
					})();
				},
			);
			console.info("memory telemetry update p99", JSON.stringify({ updateDeltaP99 }));
			expect(updateDeltaP99).toBeLessThanOrEqual(WRITE_DELTA_P99_BUDGET_MS);
		} finally {
			updatePair.cleanup();
		}
	});

	it("keeps recall and inject durable outbox accept p99 delta under 1ms", () => {
		const recall = createOutbox();
		const inject = createOutbox();
		try {
			const recallDeltaP99 = measureSyncDelta(
				"recall-delta",
				() => {},
				(index) => {
					recall.outbox.acceptUsage(usageInput("recall", index));
				},
			);
			const injectDeltaP99 = measureSyncDelta(
				"inject-delta",
				() => {},
				(index) => {
					inject.outbox.acceptUsage(usageInput("inject", index));
				},
			);
			console.info(
				"memory telemetry usage p99",
				JSON.stringify({ recallDeltaP99, injectDeltaP99 }),
			);

			expect(recall.rowCount()).toBe(ITERATIONS + WARMUP_ITERATIONS);
			expect(inject.rowCount()).toBe(ITERATIONS + WARMUP_ITERATIONS);
			expect(recallDeltaP99).toBeLessThanOrEqual(READ_DELTA_P99_BUDGET_MS);
			expect(injectDeltaP99).toBeLessThanOrEqual(READ_DELTA_P99_BUDGET_MS);
		} finally {
			recall.cleanup();
			inject.cleanup();
		}
	});
});
