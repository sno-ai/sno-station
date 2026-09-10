import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import {
	getAuditPath,
	getMemClawStateDir,
} from "../../../../packages/sno-station-mem/src/engine/operations/runtime-audit-log.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import {
	createMemoryTelemetryPurgeService,
	type MemoryTelemetryPurgeService,
} from "../../../../packages/sno-station-mem/src/engine/telemetry/memory-telemetry-purge.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

interface AuditRecord {
	event?: string;
	resultStatus?: string;
	errorCode?: string;
	details?: Record<string, unknown>;
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("memory telemetry purge preview and confirmed cascade purge", () => {
	let cleanup: () => void;
	let store: MemoryStore;
	let purge: MemoryTelemetryPurgeService;
	let auditStateRoot: string;
	const previousStateDir = process.env.SNO_PROFILE_DIR;

	beforeEach(() => {
		auditStateRoot = mkdtempSync(join(tmpdir(), "memory-telemetry-purge-audit-"));
		process.env.SNO_PROFILE_DIR = auditStateRoot;
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({
			dbPath: testDb.dbPath,
			embedder: testEmbedder,
			memoryTelemetry: {
				keySet: {
					enabled: true,
					current: { version: 1, key: "purge-test-key" },
					historic: new Map(),
				},
			},
		});
		purge = createMemoryTelemetryPurgeService({
			sqlite: store["sqlite"],
			agentId: "purge-test-agent",
		});
	});

	afterEach(async () => {
		await store.close();
		cleanup();
		rmSync(auditStateRoot, { recursive: true, force: true });
		if (previousStateDir === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = previousStateDir;
	});

	function auditRecords(operation: string): AuditRecord[] {
		return readFileSync(getAuditPath(getMemClawStateDir()), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as AuditRecord)
			.filter((record) => record.details?.["operation"] === operation);
	}

	function expectAuditPair(
		operation: string,
		terminalPhase: "completed" | "failed",
		terminalDetails: Record<string, unknown>,
	): void {
		const records = auditRecords(operation);
		expect(records).toHaveLength(2);
		expect(records.map((record) => record.details?.["audit_phase"])).toEqual([
			"started",
			terminalPhase,
		]);
		expect(records[0]?.details?.["audit_operation_id"]).toBe(
			records[1]?.details?.["audit_operation_id"],
		);
		expect(records[1]).toEqual(
			expect.objectContaining({
				resultStatus: terminalPhase === "completed" ? "ok" : "error",
				details: expect.objectContaining(terminalDetails),
			}),
		);
	}

	async function createDerivedPair(): Promise<{ parentFactId: string; childFactId: string }> {
		const parent = await store.store({
			text: "Telemetry purge parent fact",
			category: "episodic",
			projectId: "telemetry-purge",
		});
		const child = await store.store({
			text: "Telemetry purge child fact",
			category: "episodic",
			projectId: "telemetry-purge",
		});
		const parentFactId = parent.factId ?? parent.id;
		const childFactId = child.factId ?? child.id;
		store["sqlite"]
			.prepare("UPDATE nodix_memories SET derived_from = ? WHERE id = ?")
			.run(JSON.stringify([parentFactId]), child.id);
		return { parentFactId, childFactId };
	}

	function memoryFactIds(): string[] {
		return (
			store["sqlite"]
				.prepare("SELECT fact_id FROM nodix_memories ORDER BY fact_id")
				.all() as Array<{ fact_id: string }>
		).map((row) => row.fact_id);
	}

	function purgeEvents(): Array<{
		event_type: string;
		fact_id: string;
		memory_kind: string | null;
		project_id: string | null;
		metadata_json: string;
	}> {
		return store["sqlite"]
			.prepare(
				"SELECT event_type, fact_id, memory_kind, project_id, metadata_json FROM nodix_memory_events WHERE event_type = 'purge'",
			)
			.all() as Array<{
			event_type: string;
			fact_id: string;
			memory_kind: string | null;
			project_id: string | null;
			metadata_json: string;
		}>;
	}

	it("previews downstream impact without mutating primary memory rows", async () => {
		const { parentFactId, childFactId } = await createDerivedPair();
		const now = Date.now();
		store["sqlite"]
			.prepare(
				`INSERT INTO nodix_memory_events
				 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id, retrieval_rank, metadata_json)
				 VALUES
				 ('recall', ?, 'episodic', ?, 'purge-test-agent', 'telemetry-purge', 1, '{"retrieval_rank":1}'),
				 ('recall', ?, 'episodic', ?, 'purge-test-agent', 'telemetry-purge', 2, '{"retrieval_rank":2}'),
				 ('recall', ?, 'episodic', ?, 'purge-test-agent', 'telemetry-purge', 3, '{"retrieval_rank":3}')`,
			)
			.run(
				parentFactId,
				now,
				parentFactId,
				now - 31 * 24 * 60 * 60 * 1000,
				childFactId,
				now,
			);
		store["sqlite"]
			.prepare(
				`INSERT INTO nodix_memory_events
				 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id, consolidation_epoch_id, metadata_json)
				 VALUES ('update', ?, 'episodic', ?, 'purge-test-agent', 'telemetry-purge', 'epoch-purge-preview', '{"changed_lifecycle_keys":["consolidation_epoch_id"]}')`,
			)
			.run(childFactId, now);

		expect(purge.previewImpact(parentFactId)).toEqual(
			expect.objectContaining({
				targetFactId: parentFactId,
				affectedFactIds: [parentFactId, childFactId],
				downstreamFactIds: [childFactId],
				recentRecallCount: 1,
				affectedEpochIds: ["epoch-purge-preview"],
				blocked: false,
			}),
		);
		expect(memoryFactIds()).toEqual([childFactId, parentFactId].sort());
		expect(purgeEvents()).toEqual([]);
		expectAuditPair("previewImpact", "completed", {
			requested_fact_id: parentFactId,
			resolved_fact_id: parentFactId,
			fact_ids: [parentFactId, childFactId],
		});
	});

	it("allows agent preview but rejects agent purge confirmation", async () => {
		const { parentFactId, childFactId } = await createDerivedPair();

		expect(purge.previewImpact(parentFactId, { actor: "agent" }).affectedFactIds).toEqual([
			parentFactId,
			childFactId,
		]);
		expect(() =>
			purge.confirmPurge({
				factId: parentFactId,
				actor: "agent",
				confirmationToken: `PURGE ${parentFactId}`,
			}),
		).toThrow("operator");
		expect(memoryFactIds()).toEqual([childFactId, parentFactId].sort());
	});

	it("deletes reachable primary rows and emits one complete purge event", async () => {
		const { parentFactId, childFactId } = await createDerivedPair();

		const result = purge.confirmPurge({
			factId: parentFactId,
			actor: "operator",
			confirmationToken: `PURGE ${parentFactId}`,
		});

		expect(result).toEqual(
			expect.objectContaining({
				status: "complete",
				purgedFactIds: [parentFactId, childFactId],
				failedFactIds: [],
			}),
		);
		expect(memoryFactIds()).toEqual([]);
		const [event] = purgeEvents();
		expect(event).toEqual(
			expect.objectContaining({
				event_type: "purge",
				fact_id: parentFactId,
				memory_kind: "episodic",
				project_id: "telemetry-purge",
			}),
		);
		expect(JSON.parse(event?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({
				status: "complete",
				affected_fact_count: 2,
				purged_fact_ids: [parentFactId, childFactId],
				failed_fact_ids: [],
			}),
		);
		expectAuditPair("confirmPurge", "completed", {
			target_fact_id: parentFactId,
			purged_fact_ids: [parentFactId, childFactId],
			failed_fact_ids: [],
			status: "complete",
		});
	});

	it("reports an event-only descendant as failed instead of purged", async () => {
		const parent = await store.store({
			text: "Telemetry purge primary fact",
			category: "episodic",
			projectId: "telemetry-purge",
		});
		const parentFactId = parent.factId ?? parent.id;
		const eventOnlyFactId = `event-only-${parentFactId}`;
		store["sqlite"]
			.prepare(
				`INSERT INTO nodix_memory_events
				 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id, derived_from, metadata_json)
				 VALUES ('update', ?, 'episodic', 1700000000000, 'purge-test-agent', 'telemetry-purge', ?, '{"changed_keys":["derived_from"]}')`,
			)
			.run(eventOnlyFactId, JSON.stringify([parentFactId]));

		const result = purge.confirmPurge({
			factId: parentFactId,
			actor: "operator",
			confirmationToken: `PURGE ${parentFactId}`,
		});

		expect(result).toEqual(
			expect.objectContaining({
				status: "partial",
				purgedFactIds: [parentFactId],
				failedFactIds: [eventOnlyFactId],
			}),
		);
		expect(memoryFactIds()).toEqual([]);
		const completedAudit = auditRecords("confirmPurge")[1];
		expect(completedAudit).toEqual(
			expect.objectContaining({
				event: "memory_purged",
				resultStatus: "ok",
				details: expect.objectContaining({
					purged_fact_ids: [parentFactId],
					failed_fact_ids: [eventOnlyFactId],
					status: "partial",
				}),
			}),
		);
	});

	it("blocks a confirmed purge when a descendant was recalled inside the retention window", async () => {
		const { parentFactId, childFactId } = await createDerivedPair();
		store["sqlite"]
			.prepare(
				`INSERT INTO nodix_memory_events
				 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id, retrieval_rank, metadata_json)
				 VALUES ('recall', ?, 'episodic', ?, 'purge-test-agent', 'telemetry-purge', 1, '{"retrieval_rank":1}')`,
			)
			.run(childFactId, Date.now());

		const result = purge.confirmPurge({
			factId: parentFactId,
			actor: "operator",
			confirmationToken: `PURGE ${parentFactId}`,
		});

		// Purge-safety invariant: a recent recall on ANY affected fact blocks
		// the whole cascade, not only a recall on the target itself.
		expect(result).toEqual(
			expect.objectContaining({
				status: "blocked",
				purgedFactIds: [],
				failedFactIds: [parentFactId, childFactId],
				blockedReason: "recent_recall",
			}),
		);
		expect(memoryFactIds()).toEqual([childFactId, parentFactId].sort());
		const [event] = purgeEvents();
		expect(JSON.parse(event?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({ status: "blocked", blocked_reason: "recent_recall" }),
		);
		expectAuditPair("confirmPurge", "completed", {
			target_fact_id: parentFactId,
			purged_fact_ids: [],
			failed_fact_ids: [parentFactId, childFactId],
			status: "blocked",
			blocked_reason: "recent_recall",
		});
	});

	it("rejects missing facts instead of emitting a successful purge receipt", () => {
		expect(() => purge.previewImpact("missing-fact")).toThrow("missing fact");
		expect(() =>
			purge.confirmPurge({
				factId: "missing-fact",
				actor: "operator",
				confirmationToken: "PURGE missing-fact",
			}),
		).toThrow("missing fact");
		expect(purgeEvents()).toEqual([]);
		expectAuditPair("previewImpact", "failed", {
			requested_fact_id: "missing-fact",
		});
		expectAuditPair("confirmPurge", "failed", {
			target_fact_id: "missing-fact",
		});
	});

	it("rolls back primary deletes when purge event insert fails", async () => {
		const { parentFactId, childFactId } = await createDerivedPair();
		store["sqlite"].exec(`
			CREATE TRIGGER force_purge_event_failure
			BEFORE INSERT ON nodix_memory_events
			WHEN NEW.event_type = 'purge'
			BEGIN SELECT RAISE(ABORT, 'forced purge failure'); END;
		`);

		expect(() =>
			purge.confirmPurge({
				factId: parentFactId,
				actor: "operator",
				confirmationToken: `PURGE ${parentFactId}`,
			}),
		).toThrow("forced purge failure");

		expect(memoryFactIds()).toEqual([childFactId, parentFactId].sort());
		expect(purgeEvents()).toEqual([]);
		expectAuditPair("confirmPurge", "failed", {
			target_fact_id: parentFactId,
		});
		expect(auditRecords("confirmPurge")[1]).toEqual(
			expect.objectContaining({ errorCode: "memory_operation_failed" }),
		);
	});

	it("commits a partial purge event with failed fact ids when one reachable fact cannot be deleted", async () => {
		const { parentFactId, childFactId } = await createDerivedPair();
		purge = createMemoryTelemetryPurgeService({
			sqlite: store["sqlite"],
			agentId: "purge-test-agent",
			canDeleteFact: (factId) => factId !== childFactId,
		});

		const result = purge.confirmPurge({
			factId: parentFactId,
			actor: "operator",
			confirmationToken: `PURGE ${parentFactId}`,
		});

		expect(result).toEqual(
			expect.objectContaining({
				status: "partial",
				purgedFactIds: [parentFactId],
				failedFactIds: [childFactId],
			}),
		);
		expect(memoryFactIds()).toEqual([childFactId]);
		const [event] = purgeEvents();
		expect(JSON.parse(event?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({
				status: "partial",
				purged_fact_ids: [parentFactId],
				failed_fact_ids: [childFactId],
			}),
		);
		expectAuditPair("confirmPurge", "completed", {
			target_fact_id: parentFactId,
			purged_fact_ids: [parentFactId],
			failed_fact_ids: [childFactId],
			status: "partial",
		});
	});

	it("blocks true provenance cycles instead of looping", async () => {
		const { parentFactId, childFactId } = await createDerivedPair();
		store["sqlite"]
			.prepare("UPDATE nodix_memories SET derived_from = ? WHERE fact_id = ?")
			.run(JSON.stringify([childFactId]), parentFactId);

		expect(purge.previewImpact(parentFactId)).toEqual(
			expect.objectContaining({
				blocked: true,
				blockedReason: "cycle_detected",
			}),
		);
	});

	it("uses event-derived edges when primary rows do not carry derived_from", async () => {
		const { parentFactId, childFactId } = await createDerivedPair();
		store["sqlite"]
			.prepare("UPDATE nodix_memories SET derived_from = NULL WHERE fact_id = ?")
			.run(childFactId);
		store["sqlite"]
			.prepare(
				`INSERT INTO nodix_memory_events
				 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id, derived_from, metadata_json)
				 VALUES ('update', ?, 'episodic', 1700000000000, 'purge-test-agent', 'telemetry-purge', ?, '{"changed_keys":["derived_from"]}')`,
			)
			.run(childFactId, JSON.stringify([parentFactId]));

		expect(purge.previewImpact(parentFactId).affectedFactIds).toEqual([
			parentFactId,
			childFactId,
		]);
	});
});
