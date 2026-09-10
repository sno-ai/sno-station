/** Real encrypted SQLite and local embeddings. No mocks. */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import {
	appendAuditEntryStrict,
	flushAuditWrites,
	getAuditPath,
	getMemClawStateDir,
	runWithMemoryAuditSync,
} from "../../../../packages/sno-station-mem/src/engine/operations/runtime-audit-log.ts";
import { PluginObservability } from "../../../../packages/sno-station-mem/src/engine/observability/adapter.ts";
import { ObservableMemoryStore } from "../../../../packages/sno-station-mem/src/engine/observability/observable-memory-store.ts";
import { pluginConfigSchema } from "../../../../packages/sno-station-mem/src/contract/config/plugin-config-schema.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

interface AuditRecord {
	event: string;
	resultStatus: string;
	details?: Record<string, unknown>;
}

const stores: ObservableMemoryStore[] = [];
const cleanups: Array<() => void> = [];
const stateRoots: string[] = [];
const previousStateDir = process.env.OPENCLAW_STATE_DIR;
let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

beforeEach(() => {
	const stateRoot = mkdtempSync(join(tmpdir(), "mem-claw-audit-coverage-"));
	stateRoots.push(stateRoot);
	process.env.OPENCLAW_STATE_DIR = stateRoot;
});

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const stateRoot of stateRoots.splice(0)) {
		rmSync(stateRoot, { recursive: true, force: true });
	}
	if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
	else process.env.OPENCLAW_STATE_DIR = previousStateDir;
});

describe("production memory audit coverage", () => {
	it("preserves the bulk delete safety-cap result through the audit wrapper", async () => {
		const store = {
			writeMutex: {
				runExclusive<T>(run: () => T): T {
					return run();
				},
			},
			readBulkDeleteIds: () => [],
		} as unknown as ObservableMemoryStore;
		const safetyCapResult = { deleted: 50_000, truncated: true };
		const baseBulkDelete = vi
			.spyOn(MemoryStore.prototype, "bulkDelete")
			.mockResolvedValue(safetyCapResult);

		try {
			await expect(
				ObservableMemoryStore.prototype.bulkDelete.call(store, {
					projectId: "large-scope",
				}),
			).resolves.toEqual(safetyCapResult);
			expect(baseBulkDelete).toHaveBeenCalledWith({ projectId: "large-scope" }, undefined);
		} finally {
			baseBulkDelete.mockRestore();
		}
	});

	it("records correlated created and existing outcomes without raw content or secrets", async () => {
		const store = createStore();
		const text = "RAW-MEMORY-SENTINEL user keeps the launch checklist in the blue notebook.";
		const metadata = JSON.stringify({
			fact_key: "audit-duplicate-fact",
			source: "password=supersecretcredential123",
			section_name: "api_key=supersecretcredential456",
		});

		const [first, second] = await Promise.all([
			store.store({
				text,
				category: "episodic",
				projectId: "audit-duplicate-project",
				metadata,
			}),
			store.store({
				text,
				category: "episodic",
				projectId: "audit-duplicate-project",
				metadata,
			}),
		]);
		await flushAuditWrites();

		expect(new Set([first.storeWriteOutcome, second.storeWriteOutcome])).toEqual(
			new Set(["created", "existing"]),
		);
		const records = readAudit();
		const storeRecords = records.filter((record) => record.details?.["operation"] === "store");
		expect(storeRecords).toHaveLength(4);
		assertPaired(storeRecords, 2);
		const outcomes = terminalRecords(storeRecords).map(
			(record) => record.details?.["write_outcome"],
		);
		expect(new Set(outcomes)).toEqual(new Set(["created", "existing"]));

		const rawAudit = readFileSync(getAuditPath(getMemClawStateDir()), "utf8");
		expect(rawAudit).not.toContain("RAW-MEMORY-SENTINEL");
		expect(rawAudit).not.toContain("supersecretcredential123");
		expect(rawAudit).not.toContain("supersecretcredential456");
	});

	it("audits every production content, fact-identity, search, and metadata surface", async () => {
		const store = createStore();
		const scope = "audit-surface-project";
		const sourceMessageId = "message-audit-surface-01";
		const seed = await store.store({
			text: "Audit surface remembers the deterministic launch checklist.",
			category: "episodic",
			projectId: scope,
			metadata: JSON.stringify({
				fact_key: "audit-surface-fact",
				idempotency_key: "audit-surface-idempotency",
				source_message_id: sourceMessageId,
				normalized_done_assertion: "The checklist is complete.",
			}),
		});
		const reflectionId = "reflection-audit-surface";
		store.sqlite
			.prepare(
				"INSERT INTO nodix_memories (id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, 'lesson', ?, 0.7, ?, 'UTC', ?, ?)",
			)
			.run(
				reflectionId,
				reflectionId,
				"Reflection audit surface content.",
				scope,
				Date.now(),
				JSON.stringify({ type: "memory-reflection-item", itemKind: "invariant" }),
				"reflection-audit-surface-hash",
			);

		store.findByContentHash(seed.contentHash, scope);
		store.findByExtractionIdempotencyKey(scope, "audit-surface-idempotency");
		store.getById(seed.id);
		store.getByFactKey(scope, "audit-surface-fact");
		await store.hasId(seed.id);
		await store.list({ projectId: scope });
		await store.listReflectionItems({ projectIdFilter: [scope] });
		await store.getMemoryMetadata(seed.id);

		const queryVector = await embedder.embed("deterministic launch checklist");
		const semanticChunks = await store.searchChunksSemantic(queryVector, {
			projectIdFilter: [scope],
			limit: 3,
			minScore: 0,
		});
		await store.searchChunksKeyword("deterministic launch checklist", {
			projectIdFilter: [scope],
			limit: 3,
		});
		await store.searchSemantic(queryVector, {
			projectIdFilter: [scope],
			limit: 3,
			minScore: 0,
		});
		await store.searchKeyword("deterministic launch checklist", {
			projectIdFilter: [scope],
			limit: 3,
		});
		store.fetchMemoriesInOrder([seed.id]);
		store.getChunksByParent([seed.id]);
		const chunkId = semanticChunks[0]?.chunkId;
		expect(chunkId).toBeDefined();
		store.getVectorsByIds(chunkId ? [chunkId] : []);

		await store.update(seed.id, { importance: 0.8 });
		await store.updateTier(seed.id, "core", { writerAuthority: "offline-family" });
		await store.updateMetadata(seed.id, { bad_recall_count: 1 });
		await store.applyMetadataDelta(seed.id, () => ({ last_accessed_at: Date.now() }));
		await store.applyMetadataDeltas([
			{
				memoryId: seed.id,
				deltaFn: () => ({ last_accessed_at: Date.now() + 1 }),
			},
		]);
		await store.resolveReflectionItem(reflectionId, {
			resolvedAt: Date.now(),
			writerAuthority: "offline-family",
		});

		await store.importEntry({
			id: "audit-imported-memory",
			text: "Imported audit coverage memory.",
			category: "episodic",
			projectId: scope,
			importance: 0.7,
			timestamp: Date.now(),
			metadata: "{}",
			contentHash: "recomputed-by-import",
			lane: "active",
		});
		store.sqlite.prepare("DELETE FROM nodix_memory_chunk_vectors").run();
		store.sqlite.prepare("DELETE FROM nodix_memory_chunks WHERE memory_id = ?").run(seed.id);
		expect(await store.backfillMissingChunks()).toBeGreaterThanOrEqual(1);
		await flushAuditWrites();

		const operations = new Set(
			terminalRecords(readAudit()).map((record) => record.details?.["operation"]),
		);
		expect([...operations]).toEqual(
			expect.arrayContaining([
				"findByContentHash",
				"findByExtractionIdempotencyKey",
				"getById",
				"getByFactKey",
				"hasId",
				"list",
				"listReflectionItems",
				"getMemoryMetadata",
				"searchChunksSemantic",
				"searchChunksKeyword",
				"searchSemantic",
				"searchKeyword",
				"fetchMemoriesInOrder",
				"getChunksByParent",
				"getVectorsByIds",
				"update",
				"updateTier",
				"updateMetadata",
				"applyMetadataDelta",
				"applyMetadataDeltas",
				"resolveReflectionItem",
				"importEntry",
				"backfillMissingChunks",
			]),
		);
	});

	it("records compound close identities and every deletion chokepoint", async () => {
		const store = createStore();
		const scope = "audit-close-delete-project";
		const original = await store.store({
			text: "Original fact for supersede audit.",
			category: "episodic",
			projectId: scope,
		});
		const replacement = await store.supersede({
			create: {
				text: "Replacement fact for supersede audit.",
				category: "episodic",
				projectId: scope,
			},
			closes: [
				{
					id: original.id,
					buildMetadata: (createdId) => JSON.stringify({ superseded_by: createdId }),
				},
			],
		});

		const mergeClose = await store.store({
			text: "Existing fact closed by raw-lineage merge.",
			category: "episodic",
			projectId: scope,
		});
		await store.createMergeWithRawLineage({
			rawSource: {
				text: "Raw source retained for the merge audit.",
				category: "episodic",
				projectId: scope,
			},
			merged: {
				text: "Merged replacement retained for the merge audit.",
				category: "episodic",
				projectId: scope,
			},
			closeExisting: [
				{
					id: mergeClose.id,
					buildMetadata: ({ mergedId }) => JSON.stringify({ superseded_by: mergedId }),
				},
			],
			buildRawSourceMetadata: ({ mergedId }) => JSON.stringify({ superseded_by: mergedId }),
		});

		const eventClose = await store.store({
			text: "Existing fact closed by event supersede.",
			category: "episodic",
			projectId: scope,
		});
		await store.createEventAndSupersede({
			event: {
				text: "Event fact retained for event supersede audit.",
				category: "episodic",
				projectId: scope,
			},
			replacement: {
				text: "Event replacement retained for audit.",
				category: "episodic",
				projectId: scope,
			},
			closeExisting: [
				{
					id: eventClose.id,
					buildMetadata: ({ replacementId }) =>
						JSON.stringify({ superseded_by: replacementId }),
				},
			],
		});

		const direct = await store.store({
			text: "Direct delete audit row.",
			category: "episodic",
			projectId: scope,
		});
		const manyA = await store.store({
			text: "Delete many audit row A.",
			category: "episodic",
			projectId: scope,
		});
		const manyB = await store.store({
			text: "Delete many audit row B.",
			category: "episodic",
			projectId: scope,
		});
		const prefix = await store.store({
			text: "Wildcard delete audit row.",
			category: "episodic",
			projectId: scope,
		});
		const rawIds = await Promise.all(
			["A", "B"].map((suffix) =>
				store.store({
					text: `Direct deleteByIds audit row ${suffix}.`,
					category: "episodic",
					projectId: scope,
				}),
			),
		);
		await store.delete(direct.id);
		await store.deleteMany([manyA.id, manyB.id]);
		await store.delete(`${prefix.id.slice(0, 8)}*`);
		await store.delete("missing-direct-delete");
		await store.deleteMany(["missing-delete-many"]);
		store.deleteByIds(rawIds.map((entry) => entry.id));
		store.deleteByIds(["missing-delete-by-ids"]);

		const bulkScope = "audit-unfiltered-bulk-delete";
		await store.store({
			text: "Unfiltered bulk delete audit row.",
			category: "episodic",
			projectId: bulkScope,
		});
		await store.bulkDelete({});
		await store.bulkDelete({});
		await flushAuditWrites();

		const completed = terminalRecords(readAudit());
		expect(completed).toContainEqual(
			expect.objectContaining({
				event: "memory_superseded",
				details: expect.objectContaining({
					operation: "supersede",
					replacement_memory_id: replacement.id,
					closed_memory_ids: [original.id],
				}),
			}),
		);
		expect(
			completed.filter((record) => record.event === "memory_superseded").map(
				(record) => record.details?.["operation"],
			),
		).toEqual(
			expect.arrayContaining(["supersede", "createMergeWithRawLineage", "createEventAndSupersede"]),
		);
		expect(
			completed.filter((record) => record.event === "memory_deleted").map(
				(record) => record.details?.["operation"],
			),
		).toEqual(expect.arrayContaining(["delete", "deleteMany", "deleteByIds", "bulkDelete"]));
		for (const operation of ["delete", "deleteMany", "deleteByIds", "bulkDelete"]) {
			const outcomes = completed
				.filter(
					(record) =>
						record.event === "memory_deleted" &&
						record.details?.["operation"] === operation,
				)
				.map((record) => record.details?.["outcome"]);
			expect(outcomes).toEqual(expect.arrayContaining(["deleted", "noop"]));
		}
		expect(completed).toContainEqual(
			expect.objectContaining({
				event: "memory_deleted",
				details: expect.objectContaining({
					operation: "delete",
					deleted_memory_ids: [direct.id],
				}),
			}),
		);
		expect(completed).toContainEqual(
			expect.objectContaining({
				event: "memory_deleted",
				details: expect.objectContaining({
					operation: "delete",
					deleted_memory_ids: [prefix.id],
				}),
			}),
		);
		expect(completed).toContainEqual(
			expect.objectContaining({
				event: "memory_deleted",
				details: expect.objectContaining({
					operation: "deleteMany",
					deleted_memory_ids: expect.arrayContaining([manyA.id, manyB.id]),
				}),
			}),
		);
		});

	it("fails before mutation when the start record cannot persist", async () => {
		const store = createStore();
		const auditPath = getAuditPath(getMemClawStateDir());
		mkdirSync(auditPath, { recursive: true });

		await expect(
			store.store({
				text: "This row must not be stored when audit start fails.",
				category: "episodic",
				projectId: "audit-start-failure",
			}),
		).rejects.toThrow();

		const row = store.sqlite
			.prepare("SELECT COUNT(*) AS count FROM nodix_memories")
			.get() as { count: number };
		expect(row.count).toBe(0);
	});

	it("withholds a terminal result when the terminal record cannot persist", () => {
		const store = createStore();
		const seedId = "audit-terminal-failure-row";
		store.sqlite
			.prepare(
				"INSERT INTO nodix_memories (id, fact_id, text, category, project_id, importance, timestamp, timezone, metadata, content_hash) VALUES (?, ?, ?, 'episodic', 'audit-terminal-failure', 0.7, ?, 'UTC', '{}', ?)",
			)
			.run(seedId, seedId, "Terminal failure seed.", Date.now(), `${seedId}-hash`);
		const stateDir = getMemClawStateDir();
		const auditPath = getAuditPath(stateDir);
		const startedPath = `${auditPath}.started`;

		expect(() =>
			runWithMemoryAuditSync({
				stateDir,
				event: "memory_updated",
				operation: "terminalFailureProbe",
				run: () => {
					store.sqlite
						.prepare("UPDATE nodix_memories SET importance = 0.9 WHERE id = ?")
						.run(seedId);
					renameSync(auditPath, startedPath);
					mkdirSync(auditPath);
					return seedId;
				},
				completedDetails: (memoryId) => ({ memory_ids: [memoryId], outcome: "updated" }),
			}),
		).toThrow();

		const row = store.sqlite
			.prepare("SELECT importance FROM nodix_memories WHERE id = ?")
			.get(seedId) as { importance: number };
		expect(row.importance).toBe(0.9);
		const started = readAuditFile(startedPath);
		expect(started).toHaveLength(1);
		expect(started[0]?.details?.["audit_phase"]).toBe("started");
	});

	it("rejects unknown memory audit detail keys before append", async () => {
		await expect(
			appendAuditEntryStrict(getMemClawStateDir(), {
				event: "memory_deleted",
				resultStatus: "ok",
				details: {
					operation: "deleteByIds",
					audit_phase: "completed",
					audit_operation_id: "unknown-key-test",
					raw_memory_content: "must never be accepted",
				},
			}),
		).rejects.toThrow(/unknown memory audit detail key/);
		expect(() => readFileSync(getAuditPath(getMemClawStateDir()), "utf8")).toThrow();
	});
});

function createStore(): ObservableMemoryStore {
	const testDb = createTestDb();
	cleanups.push(testDb.cleanup);
	const config = pluginConfigSchema.parse({
		embedding: { provider: "local-onnx" },
	});
	const store = new ObservableMemoryStore(
		{ dbPath: testDb.dbPath, embedder },
		new PluginObservability(config, process.cwd()),
		() => undefined,
		config.embedding,
	);
	stores.push(store);
	return store;
}

function readAudit(): AuditRecord[] {
	return readAuditFile(getAuditPath(getMemClawStateDir()));
}

function readAuditFile(auditPath: string): AuditRecord[] {
	return readFileSync(auditPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as AuditRecord);
}

function terminalRecords(records: AuditRecord[]): AuditRecord[] {
	return records.filter((record) => record.details?.["audit_phase"] === "completed");
}

function assertPaired(records: AuditRecord[], expectedOperations: number): void {
	const byId = new Map<string, AuditRecord[]>();
	for (const record of records) {
		const operationId = record.details?.["audit_operation_id"];
		expect(typeof operationId).toBe("string");
		if (typeof operationId !== "string") continue;
		const operationRecords = byId.get(operationId) ?? [];
		operationRecords.push(record);
		byId.set(operationId, operationRecords);
	}
	expect(byId.size).toBe(expectedOperations);
	for (const operationRecords of byId.values()) {
		expect(operationRecords.map((record) => record.details?.["audit_phase"])).toEqual([
			"started",
			"completed",
		]);
	}
}
