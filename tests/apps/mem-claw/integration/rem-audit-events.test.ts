/** @file rem-audit-events.test.ts
 * @purpose Proves production memory wrappers append local REM gateway audit events.
 * @boundary Real encrypted SQLite, local ONNX embeddings, wrapper seams, and audit JSONL.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	flushAuditWrites,
	getAuditPath,
	getSnoStationMemStateDir,
} from "../../../../packages/memory/src/engine/operations/runtime-audit-log.ts";
import { PluginObservability } from "../../../../packages/memory/src/engine/observability/adapter.ts";
import { ObservableMemoryRetriever } from "../../../../packages/memory/src/engine/observability/observable-retriever.ts";
import { ObservableMemoryStore } from "../../../../packages/memory/src/engine/observability/observable-memory-store.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { pluginConfigSchema } from "../../../../packages/memory/config/plugin-config-schema.ts";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

const cleanupPaths: string[] = [];
const cleanupDatabases: Array<() => void> = [];
const stores: ObservableMemoryStore[] = [];
const previousStateDir = process.env.SNO_PROFILE_DIR;
let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

beforeEach(() => {
	const stateRoot = mkdtempSync(join(tmpdir(), "mem-claw-rem-audit-"));
	cleanupPaths.push(stateRoot);
	process.env.SNO_PROFILE_DIR = stateRoot;
});

afterAll(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const cleanup of cleanupDatabases.splice(0)) cleanup();
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
	if (previousStateDir === undefined) delete process.env.SNO_PROFILE_DIR;
	else process.env.SNO_PROFILE_DIR = previousStateDir;
});

describe("REM gateway audit events", () => {
	it("writes a correlated memory_injected pair for a bulk store operation", async () => {
		const store = createStore();

		await store.bulkStore([
			{
				text: "Falcon prefers deterministic local memory tests.",
				category: "episodic",
				projectId: "persona:test-68a19d8c",
			},
			{
				text: "Falcon records REM execution audit events.",
				category: "episodic",
				projectId: "persona:test-68a19d8c",
			},
		]);
		await flushAuditWrites();

		const injected = readAudit().filter(
			(entry) =>
				entry.event === "memory_injected" && entry.details?.["operation"] === "bulkStore",
		);
		assertAuditPair(injected);
		expect(injected[1]).toMatchObject({
			resultStatus: "ok",
			details: {
				scope: "persona:test-68a19d8c",
				category: "episodic",
				lane: "active",
				count: 2,
				operation: "bulkStore",
				audit_phase: "completed",
				write_outcome: "created",
				created_count: 2,
				existing_count: 0,
			},
		});
	});

	it("writes one top-level audit pair for a superseding profile write", async () => {
		const store = createStore();

		await store.supersede({
			create: {
				text: "Field work schedule",
				category: "profile",
				projectId: "persona:test-68a19d8c",
				trusted: true,
				metadata: JSON.stringify({
					section_name: "schedule",
					source: "ambient-learning",
				}),
			},
			closes: [],
		});
		await flushAuditWrites();

		const records = readAudit();
		const superseded = records.filter(
			(entry) =>
				entry.event === "memory_superseded" && entry.details?.["operation"] === "supersede",
		);
		assertAuditPair(superseded);
		expect(superseded[1]).toEqual(
			expect.objectContaining({
				scope: "persona:test-68a19d8c",
				resultStatus: "ok",
				details: expect.objectContaining({
					scope: "persona:test-68a19d8c",
					audit_phase: "completed",
					write_outcome: "created",
				}),
			}),
		);
		expect(
			records.filter(
				(entry) =>
					entry.event === "memory_injected" && entry.details?.["operation"] === "supersede",
			),
		).toHaveLength(0);
	});

	it("writes one top-level search audit pair while keeping direct searches audited", async () => {
		const store = createStore();
		await store.store({
			text: "Falcon verifies the local REM audit pipeline.",
			category: "episodic",
			projectId: "persona:test-68a19d8c",
		});
		const config = pluginConfigSchema.parse({
			embedding: { provider: "local-onnx" },
		});
		const retriever = new ObservableMemoryRetriever(
			store,
			embedder,
			undefined,
			{
				...DEFAULT_RETRIEVAL_CONFIG,
				rerank: "none",
				hardMinScore: 0,
				minScore: 0,
			},
			new PluginObservability(config, process.cwd()),
			() => undefined,
			config.embedding,
		);

		const results = await retriever.retrieve({
			query: "local REM audit pipeline",
			limit: 3,
			scopeFilter: ["persona:test-68a19d8c"],
			source: "manual",
		});
		await flushAuditWrites();

		expect(results.length).toBeGreaterThan(0);
		const retrievalRecords = readAudit().filter(
			(entry) => entry.event === "memory_searched",
		);
		assertAuditPair(retrievalRecords);
		expect(retrievalRecords[1]).toMatchObject({
			scope: "persona:test-68a19d8c",
			resultStatus: "ok",
			details: {
				operation: "retrieve",
				scope: ["persona:test-68a19d8c"],
				query_kind: "manual",
				result_count: results.length,
			},
		});

		await store.searchKeyword("local REM audit pipeline", {
			projectIdFilter: ["persona:test-68a19d8c"],
		});
		await flushAuditWrites();

		const directSearchRecords = readAudit().filter(
			(entry) =>
				entry.event === "memory_searched" &&
				entry.details?.["operation"] === "searchKeyword",
		);
		assertAuditPair(directSearchRecords);

		const traced = await retriever.retrieveWithTrace({
			query: "local REM audit pipeline",
			limit: 3,
			scopeFilter: ["persona:test-68a19d8c"],
			source: "manual",
		});
		await flushAuditWrites();
		expect(traced.results.length).toBeGreaterThan(0);
		const tracedRecords = readAudit().filter(
			(entry) =>
				entry.event === "memory_searched" &&
				entry.details?.["operation"] === "retrieveWithTrace",
		);
		assertAuditPair(tracedRecords);

		const directCountBeforeConcurrency = directSearchRecords.length;
		const retrievalCountBeforeConcurrency = retrievalRecords.length;
		await Promise.all([
			retriever.retrieve({
				query: "local REM audit pipeline",
				limit: 3,
				scopeFilter: ["persona:test-68a19d8c"],
				source: "manual",
			}),
			store.searchKeyword("local REM audit pipeline", {
				projectIdFilter: ["persona:test-68a19d8c"],
			}),
		]);
		await flushAuditWrites();

		const concurrentRecords = readAudit();
		const concurrentDirectPair = concurrentRecords
			.filter(
				(entry) =>
					entry.event === "memory_searched" &&
					entry.details?.["operation"] === "searchKeyword",
			)
			.slice(directCountBeforeConcurrency);
		const concurrentRetrievalPair = concurrentRecords
			.filter(
				(entry) =>
					entry.event === "memory_searched" && entry.details?.["operation"] === "retrieve",
			)
			.slice(retrievalCountBeforeConcurrency);
		assertAuditPair(concurrentDirectPair);
		assertAuditPair(concurrentRetrievalPair);
	});

	it("keeps both production wrapper constructions in runtime registration", () => {
		const registration = readFileSync(
			resolve(
				import.meta.dirname,
				"../../../../apps/mem-claw/src/install/openclaw-runtime-registration.ts",
			),
			"utf8",
		);

		expect(registration).toContain("new ObservableMemoryStore(");
		expect(registration).toContain("new ObservableMemoryRetriever(");
	});
});

function createStore(): ObservableMemoryStore {
	const testDb = createTestDb();
	cleanupDatabases.push(testDb.cleanup);
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

interface AuditRecord {
	event?: string;
	scope?: string;
	resultStatus?: string;
	details?: Record<string, unknown>;
}

function readAudit(): AuditRecord[] {
	return readFileSync(getAuditPath(getSnoStationMemStateDir()), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as AuditRecord);
}

function assertAuditPair(records: AuditRecord[]): void {
	expect(records).toHaveLength(2);
	expect(records.map((record) => record.details?.["audit_phase"])).toEqual([
		"started",
		"completed",
	]);
	expect(records[0]?.details?.["audit_operation_id"]).toBe(
		records[1]?.details?.["audit_operation_id"],
	);
}
