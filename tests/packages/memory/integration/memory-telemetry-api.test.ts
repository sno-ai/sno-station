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
	createMemoryTelemetryApi,
	type MemoryTelemetryApi,
} from "../../../../packages/sno-station-mem/src/engine/telemetry/memory-telemetry-api.ts";
import { MemoryTelemetryUsageOutbox } from "../../../../packages/sno-station-mem/src/engine/telemetry/memory-telemetry-outbox.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

let testEmbedder: Embedder;

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("memory telemetry local query API", () => {
	let cleanup: () => void;
	let store: MemoryStore;
	let api: MemoryTelemetryApi;
	let outbox: MemoryTelemetryUsageOutbox;
	let auditStateRoot: string;
	const previousStateDir = process.env.OPENCLAW_STATE_DIR;
	const keySet = {
		enabled: true,
		current: { version: 1, key: "api-test-key" },
		historic: new Map<number, string>(),
	};

	beforeEach(() => {
		auditStateRoot = mkdtempSync(join(tmpdir(), "memory-telemetry-api-audit-"));
		process.env.OPENCLAW_STATE_DIR = auditStateRoot;
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({
			dbPath: testDb.dbPath,
			embedder: testEmbedder,
			memoryTelemetry: { keySet },
		});
		outbox = new MemoryTelemetryUsageOutbox({
			sqlite: store["sqlite"],
			dbPath: testDb.dbPath,
			agentId: "api-test-agent",
		});
		api = createMemoryTelemetryApi({
			sqlite: store["sqlite"],
			usageOutbox: outbox,
			keySet,
		});
	});

	afterEach(async () => {
		await store.close();
		cleanup();
		rmSync(auditStateRoot, { recursive: true, force: true });
		if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = previousStateDir;
	});

	it("verifies the latest local receipt and reports tampering from primary-row hash drift", async () => {
		const stored = await store.store({
			text: "Telemetry API receipt memory",
			category: "episodic",
			projectId: "telemetry-api",
		});

		const valid = api.verifyReceipt(stored.factId ?? stored.id);

		expect(valid.status).toBe("valid");
		expect(valid.terminalFactId).toBe(stored.factId ?? stored.id);
		expect(valid.latestReceipt).toEqual(
			expect.objectContaining({
				factId: stored.factId ?? stored.id,
				contentHash: stored.contentHash,
				keyVersion: 1,
			}),
		);
		expect(valid.historicalReceipts).toHaveLength(1);

		store["sqlite"]
			.prepare("UPDATE nodix_memories SET content_hash = ? WHERE id = ?")
			.run("f".repeat(64), stored.id);

		expect(api.verifyReceipt(stored.factId ?? stored.id).status).toBe("tampered");
		const auditRecords = readFileSync(getAuditPath(getMemClawStateDir()), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { details?: Record<string, unknown> });
		expect(
			auditRecords.filter(
				(record) =>
					record.details?.["operation"] === "verifyReceipt" &&
					record.details?.["audit_phase"] === "completed",
			),
		).toHaveLength(2);
	});

	it("returns provenance nodes ordered by local event causality", async () => {
		const original = await store.store({
			text: "Telemetry API provenance original",
			category: "episodic",
			projectId: "telemetry-api-provenance",
		});
		await store.update(original.id, { importance: 0.9 });
		await store.supersede({
			create: {
				text: "Telemetry API provenance replacement",
				category: "episodic",
				projectId: "telemetry-api-provenance",
				metadata: "{}",
			},
			closes: [
				{
					id: original.id,
					buildMetadata: (createdId) => JSON.stringify({ superseded_by: createdId }),
				},
			],
		});

		const provenance = api.provenanceChain(original.factId ?? original.id);
		// supersede()'s replacement now gets its own signed creation receipt
		// (codex adversarial review 2026-07-13), written last so the supersede
		// close's sourceEventId still resolves to the original's own receipt
		// rather than to itself.
		expect(provenance.nodes.map((node) => node.eventType)).toEqual([
			"create",
			"update",
			"supersede",
			"create",
		]);
		// currentState reads the chain's LAST node. Before the missing-receipt
		// fix, the chain ended at "supersede" and every replaced fact_id was
		// permanently misreported as dead even though a live replacement
		// existed under the same fact_id. It now correctly ends at the
		// replacement's own "create", reporting "active".
		expect(provenance.currentState).toBe("active");
	});

	it("summarizes usage from committed events plus pending local outbox rows without cloud input", async () => {
		const stored = await store.store({
			text: "Telemetry API usage memory",
			category: "episodic",
			projectId: "telemetry-api-usage",
		});
		const factId = stored.factId ?? stored.id;
		outbox.acceptUsage({
			eventType: "recall",
			factId,
			memoryKind: "episodic",
			projectId: "telemetry-api-usage",
			agentId: "api-test-agent",
			sessionUuid: "session-api",
			turnId: "turn-1",
			retrievalRank: 1,
			retrievalScore: 0.91,
			metadata: { retrieval_rank: 1, retrieval_score: 0.91 },
		});
		outbox.acceptUsage({
			eventType: "inject",
			factId,
			memoryKind: "episodic",
			projectId: "telemetry-api-usage",
			agentId: "api-test-agent",
			sessionUuid: "session-api",
			turnId: "turn-1",
			retrievalRank: 1,
			retrievalScore: 0.91,
			metadata: {
				injection_surface: "auto_recall_prepend_context",
				retrieval_rank: 1,
				retrieval_score: 0.91,
			},
		});

		expect(api.usageSummary({ factId })).toEqual(
			expect.objectContaining({
				factId,
				recallCount: 1,
				injectionCount: 1,
				source: "local",
				cloudForwarding: "ignored",
				tenantBoundary: {
					status: "unavailable",
					queryTenantId: null,
					resultTenantId: null,
				},
			}),
		);

		outbox.flushPending();

		expect(api.usageSummary({ factId })).toEqual(
			expect.objectContaining({
				recallCount: 1,
				injectionCount: 1,
			}),
		);
	});

	it("does not double count a committed usage event with a leftover outbox row", async () => {
		const stored = await store.store({
			text: "Telemetry API usage recovery memory",
			category: "episodic",
			projectId: "telemetry-api-recovery",
		});
		const factId = stored.factId ?? stored.id;
		outbox.acceptUsage({
			eventType: "recall",
			factId,
			memoryKind: "episodic",
			projectId: "telemetry-api-recovery",
			agentId: "api-test-agent",
			sessionUuid: "session-recovery",
			turnId: "turn-recovery",
			retrievalRank: 1,
			retrievalScore: 0.42,
			metadata: { retrieval_rank: 1, retrieval_score: 0.42 },
		});
		const outboxRow = store["sqlite"]
			.prepare("SELECT accepted_at_ms FROM nodix_memory_usage_outbox LIMIT 1")
			.get() as { accepted_at_ms: number };
		store["sqlite"]
			.prepare(
				`INSERT INTO nodix_memory_events
				 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id,
				  session_uuid, turn_id, retrieval_rank, retrieval_score, metadata_json)
				 VALUES ('recall', ?, 'episodic', ?, 'api-test-agent', 'telemetry-api-recovery',
				  'session-recovery', 'turn-recovery', 1, 0.42, '{"retrieval_rank":1,"retrieval_score":0.42}')`,
			)
			.run(factId, outboxRow.accepted_at_ms);
		store["sqlite"]
			.prepare(
				"UPDATE nodix_memory_usage_outbox SET status = 'failed', last_error = 'recovery duplicate'",
			)
			.run();

		expect(api.usageSummary({ factId })).toEqual(
			expect.objectContaining({
				recallCount: 1,
				injectionCount: 0,
			}),
		);
	});

	it("counts pending usage under the outbox default agent before flush", async () => {
		const stored = await store.store({
			text: "Telemetry API default-agent usage memory",
			category: "episodic",
			projectId: "telemetry-api-default-agent",
		});
		const factId = stored.factId ?? stored.id;
		outbox.acceptUsage({
			eventType: "recall",
			factId,
			memoryKind: "episodic",
			projectId: "telemetry-api-default-agent",
			sessionUuid: "session-default-agent",
			turnId: "turn-default-agent",
			retrievalRank: 1,
			retrievalScore: 0.8,
			metadata: { retrieval_rank: 1, retrieval_score: 0.8 },
		});

		expect(api.usageSummary({ agentId: "api-test-agent" })).toEqual(
			expect.objectContaining({
				agentId: "api-test-agent",
				recallCount: 1,
				injectionCount: 0,
			}),
		);

		outbox.flushPending();

		expect(api.usageSummary({ agentId: "api-test-agent" })).toEqual(
			expect.objectContaining({
				recallCount: 1,
				injectionCount: 0,
			}),
		);
	});

	it("returns recall trace only for a session-scoped turn", async () => {
		const stored = await store.store({
			text: "Telemetry API recall trace memory",
			category: "episodic",
			projectId: "telemetry-api-trace",
		});
		outbox.acceptUsage({
			eventType: "recall",
			factId: stored.factId ?? stored.id,
			memoryKind: "episodic",
			projectId: "telemetry-api-trace",
			agentId: "api-test-agent",
			sessionUuid: "session-trace",
			turnId: "turn-trace",
			retrievalRank: 2,
			retrievalScore: 0.72,
			metadata: { retrieval_rank: 2, retrieval_score: 0.72 },
		});
		outbox.flushPending();

		expect(() => api.recallTrace({ sessionUuid: "session-trace" })).toThrow("turn_id");
		expect(api.recallTrace({ sessionUuid: "session-trace", turnId: "turn-trace" }).events).toEqual([
			expect.objectContaining({
				factId: stored.factId ?? stored.id,
				rank: 2,
				score: 0.72,
			}),
		]);
	});

	it("reports synthetic epoch consumers without fabricating real epoch production", async () => {
		store["sqlite"]
			.prepare(
				`INSERT INTO nodix_memory_events
				 (event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id, consolidation_epoch_id, metadata_json)
				 VALUES
				 ('epoch_boundary', NULL, NULL, 1700000000000, 'api-test-agent', 'telemetry-api', 'epoch-1', '{"subtype":"synthetic"}'),
				 ('create', 'fact-created', 'episodic', 1700000000001, 'api-test-agent', 'telemetry-api', 'epoch-1', '{"operation_source":"test","receipt_status":"signed"}'),
				 ('supersede', 'fact-superseded', 'episodic', 1700000000002, 'api-test-agent', 'telemetry-api', 'epoch-1', '{"superseded_by":"fact-created","supersedes":"fact-superseded","supersede_mode":"one_to_one"}')`,
			)
			.run();

		expect(api.epochReport("epoch-1")).toEqual(
			expect.objectContaining({
				epochId: "epoch-1",
				status: "synthetic",
				createdFactIds: ["fact-created"],
				supersededFactIds: ["fact-superseded"],
			}),
		);
		expect(api.epochReport("missing-epoch")).toEqual({
			epochId: "missing-epoch",
			status: "unavailable",
			boundaryEvents: [],
			createdFactIds: [],
			supersededFactIds: [],
		});
	});

	it("exposes impact preview and operator-only confirmed purge through the local API", async () => {
		const parent = await store.store({
			text: "Telemetry API purge parent",
			category: "episodic",
			projectId: "telemetry-api-purge",
		});
		const child = await store.store({
			text: "Telemetry API purge child",
			category: "episodic",
			projectId: "telemetry-api-purge",
		});
		const parentFactId = parent.factId ?? parent.id;
		const childFactId = child.factId ?? child.id;
		store["sqlite"]
			.prepare("UPDATE nodix_memories SET derived_from = ? WHERE id = ?")
			.run(JSON.stringify([parentFactId]), child.id);

		expect(api.editImpactPreview(parentFactId, { actor: "agent" }).affectedFactIds).toEqual([
			parentFactId,
			childFactId,
		]);
		expect(() =>
			api.confirmPurge({
				factId: parentFactId,
				actor: "agent",
				confirmationToken: `PURGE ${parentFactId}`,
			}),
		).toThrow("operator");

		expect(
			api.confirmPurge({
				factId: parentFactId,
				actor: "operator",
				confirmationToken: `PURGE ${parentFactId}`,
			}),
		).toEqual(
			expect.objectContaining({
				status: "complete",
				purgedFactIds: [parentFactId, childFactId],
				failedFactIds: [],
			}),
		);
		expect(
			store["sqlite"].prepare("SELECT COUNT(*) AS count FROM nodix_memories").get(),
		).toEqual({ count: 0 });
	});
});
