import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/sno-station-mem/src/engine/extraction/embedding-provider-client.ts";
import { MemoryStore } from "../../../../packages/sno-station-mem/src/store/store.ts";
import { createTestDb, createTestEmbedder } from "../../../apps/mem-claw/helpers/test-db.ts";

interface MemoryEventRow {
	id: number;
	event_type: string;
	fact_id: string;
	memory_kind: string;
	timestamp_ms: number;
	agent_id: string;
	project_id: string | null;
	source_event_id: number | null;
	derived_from: string | null;
	content_hash: string | null;
	receipt_hmac: string | null;
	key_version: number | null;
	metadata_json: string | null;
}

let testEmbedder: Embedder;
const TEST_SECRET_VALUE = "test-secret-value-do-not-use-telemetry";

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

function eventRows(store: MemoryStore): MemoryEventRow[] {
	return store["sqlite"]
		.prepare(
			`SELECT id, event_type, fact_id, memory_kind, timestamp_ms, agent_id, project_id,
				source_event_id, derived_from, content_hash, receipt_hmac, key_version, metadata_json
			 FROM nodix_memory_events
			 ORDER BY id ASC`,
		)
		.all() as MemoryEventRow[];
}

function memoryFactRow(
	store: MemoryStore,
	id: string,
): { fact_id: string; derived_from: string | null } | undefined {
	return store["sqlite"]
		.prepare("SELECT fact_id, derived_from FROM nodix_memories WHERE id = ? LIMIT 1")
		.get(id) as { fact_id: string; derived_from: string | null } | undefined;
}

function memoryMetadata(store: MemoryStore, id: string): string | undefined {
	const row = store["sqlite"]
		.prepare("SELECT metadata FROM nodix_memories WHERE id = ? LIMIT 1")
		.get(id) as { metadata: string } | undefined;
	return row?.metadata;
}

function memoryCount(store: MemoryStore): number {
	const row = store["sqlite"]
		.prepare("SELECT COUNT(*) AS count FROM nodix_memories")
		.get() as { count: number };
	return row.count;
}

function memoryArtifactCounts(store: MemoryStore): {
	memories: number;
	chunks: number;
	vectors: number;
} {
	const memories = store["sqlite"]
		.prepare("SELECT COUNT(*) AS count FROM nodix_memories")
		.get() as { count: number };
	const chunks = store["sqlite"]
		.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunks")
		.get() as { count: number };
	const vectors = store["sqlite"]
		.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunk_vectors")
		.get() as { count: number };
	return {
		memories: memories.count,
		chunks: chunks.count,
		vectors: vectors.count,
	};
}

function sentinelHits(store: MemoryStore, sentinel: string): number {
	const escaped = `%${sentinel}%`;
	const queries = [
		"SELECT COUNT(*) AS count FROM nodix_memory_events WHERE event_type LIKE ? OR fact_id LIKE ? OR memory_kind LIKE ? OR agent_id LIKE ? OR project_id LIKE ? OR metadata_json LIKE ?",
		"SELECT COUNT(*) AS count FROM nodix_memory_usage_outbox WHERE payload_json LIKE ?",
		"SELECT COUNT(*) AS count FROM nodix_memory_telemetry_incidents WHERE message LIKE ? OR payload_json LIKE ?",
		"SELECT COUNT(*) AS count FROM nodix_memory_telemetry_sync_state WHERE sink LIKE ?",
	];
	let total = 0;
	for (const query of queries) {
		const placeholders = Array.from({ length: (query.match(/\?/g) ?? []).length }, () => escaped);
		const row = store["sqlite"].prepare(query).get(...placeholders) as { count: number };
		total += row.count;
	}
	return total;
}

describe("memory telemetry Tier-1 create/import events", () => {
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		const testDb = createTestDb();
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath: testDb.dbPath, embedder: testEmbedder });
	});

	afterEach(async () => {
		await store.close();
		cleanup();
	});

	it("records a create event with receipt fields inside store()", async () => {
		const stored = await store.store({
			text: "Telemetry create event test memory",
			category: "episodic",
			projectId: "telemetry-tier1",
		});

		expect(eventRows(store)).toEqual([
			expect.objectContaining({
				event_type: "create",
				fact_id: stored.id,
				memory_kind: "episodic",
				agent_id: expect.any(String),
				project_id: "telemetry-tier1",
				content_hash: stored.contentHash,
				key_version: 1,
			}),
		]);
		const [event] = eventRows(store);
		expect(event?.timestamp_ms).toBeGreaterThan(0);
		expect(event?.receipt_hmac).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.parse(event?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({ operation_source: "store", receipt_status: "signed" }),
		);
	});

	it("records create events for every inserted bulkStore row", async () => {
		const stored = await store.bulkStore([
			{
				text: "Telemetry bulk create first memory",
				category: "episodic",
				projectId: "telemetry-tier1-bulk",
			},
			{
				text: "Telemetry bulk create second memory",
				category: "episodic",
				projectId: "telemetry-tier1-bulk",
			},
		]);

		expect(stored).toHaveLength(2);
		expect(eventRows(store).map((row) => [row.event_type, row.fact_id, row.memory_kind])).toEqual([
			["create", stored[0]?.id, "episodic"],
			["create", stored[1]?.id, "episodic"],
		]);
	});

	it("records create then update receipts for importEntry upserts", async () => {
		const imported = await store.importEntry({
			id: "imported-fact-1",
			text: "Telemetry import initial memory",
			category: "episodic",
			projectId: "telemetry-import",
			importance: 0.8,
			timestamp: 1_700_000_000_000,
			metadata: "{}",
			contentHash: "c".repeat(64),
		});
		const updated = await store.importEntry({
			...imported,
			text: "Telemetry import updated memory",
			contentHash: "d".repeat(64),
			timestamp: 1_700_000_000_100,
		});

		expect(updated.id).toBe("imported-fact-1");
		expect(eventRows(store).map((row) => [row.event_type, row.fact_id, row.content_hash])).toEqual([
			["create", "imported-fact-1", imported.contentHash],
			["update", "imported-fact-1", updated.contentHash],
		]);
	});

	it("rolls back a single create when Tier-1 event insert fails", async () => {
		store["sqlite"].prepare("DROP TABLE nodix_memory_events").run();

		await expect(
			store.store({
				text: "Telemetry rollback single create",
				category: "episodic",
				projectId: "telemetry-rollback",
			}),
		).rejects.toThrow();
		expect(memoryArtifactCounts(store)).toEqual({ memories: 0, chunks: 0, vectors: 0 });
	});

	it("rolls back the full bulkStore batch when Tier-1 event insert fails", async () => {
		store["sqlite"].prepare("DROP TABLE nodix_memory_events").run();

		await expect(
			store.bulkStore([
				{
					text: "Telemetry rollback bulk first",
					category: "episodic",
					projectId: "telemetry-rollback-bulk",
				},
				{
					text: "Telemetry rollback bulk second",
					category: "episodic",
					projectId: "telemetry-rollback-bulk",
				},
				]),
		).rejects.toThrow();
		expect(memoryArtifactCounts(store)).toEqual({ memories: 0, chunks: 0, vectors: 0 });
	});

	it("does not copy raw memory text into telemetry tables", async () => {
		const sentinel = "RAW_TELEMETRY_SENTINEL_CREATE_42";
		await store.store({
			text: `The raw sentinel ${sentinel} must stay out of telemetry tables.`,
			category: "episodic",
			projectId: "telemetry-sentinel",
		});

		expect(sentinelHits(store, sentinel)).toBe(0);
	});

	it("records a fresh receipt when update changes fact content", async () => {
		const stored = await store.store({
			text: "Telemetry update initial content",
			category: "episodic",
			projectId: "telemetry-update",
		});

		const updated = await store.update(stored.id, {
			text: "Telemetry update changed content",
		});

		expect(updated?.contentHash).not.toBe(stored.contentHash);
		const rows = eventRows(store);
		expect(rows.map((row) => row.event_type)).toEqual(["create", "update"]);
		expect(rows[1]).toEqual(
			expect.objectContaining({
				event_type: "update",
				fact_id: stored.id,
				memory_kind: "episodic",
				project_id: "telemetry-update",
				source_event_id: rows[0]?.id,
				content_hash: updated?.contentHash,
				key_version: 1,
			}),
		);
		expect(rows[1]?.receipt_hmac).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.parse(rows[1]?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({
				changed_keys: ["text", "content_hash"],
				content_hash: updated?.contentHash,
			}),
		);
	});

	it("records lifecycle metadata updates but ignores access-only metadata churn", async () => {
		const stored = await store.store({
			text: "Telemetry lifecycle metadata fact",
			category: "episodic",
			projectId: "telemetry-update-metadata",
		});
		const invalidatedAt = Date.now() + 60_000;

		await store.update(stored.id, {
			metadata: JSON.stringify({ invalidated_at: invalidatedAt }),
		});
		await store.update(stored.id, {
			metadata: JSON.stringify({
				invalidated_at: invalidatedAt,
				access_count: 5,
				last_accessed_at: 1_700_000_000_002,
			}),
		});

		const rows = eventRows(store);
		expect(rows.map((row) => row.event_type)).toEqual(["create", "update"]);
		expect(JSON.parse(rows[1]?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({
				changed_lifecycle_keys: ["invalidated_at"],
			}),
		);
		expect(rows[1]?.receipt_hmac).toBeNull();
	});

	it("records one-to-one supersede with preserved fact identity and source event", async () => {
		const original = await store.store({
			text: "Telemetry supersede original fact",
			category: "episodic",
			projectId: "telemetry-supersede",
		});

		const replacement = await store.supersede({
			create: {
				text: "Telemetry supersede replacement fact",
				category: "episodic",
				projectId: "telemetry-supersede",
			},
			closes: [
				{
					id: original.id,
					buildMetadata: (createdId) =>
						JSON.stringify({ superseded_by: createdId, api_key: TEST_SECRET_VALUE }),
				},
			],
		});

		expect(memoryFactRow(store, replacement.id)).toEqual({
			fact_id: original.id,
			derived_from: null,
		});
		const rows = eventRows(store);
		// The supersede close is written first so its sourceEventId still
		// resolves to the original's own receipt (rows[0]); the replacement's
		// new receipt (codex adversarial review 2026-07-13: previously missing
		// entirely) is written last, sharing fact_id with the row it replaces
		// ("preserved fact identity").
		expect(rows.map((row) => row.event_type)).toEqual(["create", "supersede", "create"]);
		expect(rows[1]).toEqual(
			expect.objectContaining({
				event_type: "supersede",
				fact_id: original.id,
				memory_kind: "episodic",
				project_id: "telemetry-supersede",
				source_event_id: rows[0]?.id,
				derived_from: null,
			}),
		);
		const supersedeMetadata = JSON.parse(rows[1]?.metadata_json ?? "{}") as Record<
			string,
			unknown
		>;
		expect(supersedeMetadata).toEqual(
			expect.objectContaining({
				superseded_by: replacement.id,
				supersedes: original.id,
				supersede_mode: "one_to_one",
			}),
		);
		expect([undefined, "[REDACTED_SECRET]"]).toContain(supersedeMetadata.api_key);
		expect(JSON.stringify(supersedeMetadata)).not.toContain(TEST_SECRET_VALUE);
		expect(rows[2]).toEqual(
			expect.objectContaining({
				event_type: "create",
				fact_id: original.id,
				memory_kind: "episodic",
				project_id: "telemetry-supersede",
				content_hash: replacement.contentHash,
			}),
		);
		expect(JSON.parse(rows[2]?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({ operation_source: "supersede", receipt_status: "signed" }),
		);
		const closedMetadata = JSON.parse(memoryMetadata(store, original.id) ?? "{}") as Record<
			string,
			unknown
		>;
		expect(closedMetadata.superseded_by).toBe(replacement.id);
		expect(closedMetadata.api_key).toBe("[REDACTED_SECRET]");
		expect(JSON.stringify(closedMetadata)).not.toContain(TEST_SECRET_VALUE);
	});

	it("rejects cross-project supersede closes without mutating the foreign row", async () => {
		const foreign = await store.store({
			text: "Telemetry cross-project supersede source fact",
			category: "episodic",
			projectId: "telemetry-supersede-a",
		});

		await expect(
			store.supersede({
				create: {
					text: "Telemetry cross-project supersede replacement fact",
					category: "episodic",
					projectId: "telemetry-supersede-b",
				},
				closes: [
					{
						id: foreign.id,
						buildMetadata: (createdId) => JSON.stringify({ superseded_by: createdId }),
					},
				],
			}),
		).rejects.toThrow(/projectId/);

		expect(memoryCount(store)).toBe(1);
		expect(memoryFactRow(store, foreign.id)).toEqual({
			fact_id: foreign.id,
			derived_from: null,
		});
		expect(JSON.parse(memoryMetadata(store, foreign.id) ?? "{}")).not.toHaveProperty(
			"superseded_by",
		);
		expect(eventRows(store).map((row) => row.event_type)).toEqual(["create"]);
	});

	it("records raw-source merge lineage as create plus supersede events", async () => {
		const original = await store.store({
			text: "Telemetry merge original fact",
			category: "episodic",
			projectId: "telemetry-merge",
		});

		const created = await store.createMergeWithRawLineage({
			rawSource: {
				text: "Telemetry merge raw source fact",
				category: "episodic",
				projectId: "telemetry-merge",
			},
			merged: {
				text: "Telemetry merge consolidated fact",
				category: "episodic",
				projectId: "telemetry-merge",
			},
			closeExisting: [
				{
					id: original.id,
					buildMetadata: ({ mergedId }) => JSON.stringify({ superseded_by: mergedId }),
				},
			],
			buildRawSourceMetadata: ({ mergedId }) => JSON.stringify({ superseded_by: mergedId }),
		});

		expect(memoryFactRow(store, created.rawSource.id)).toEqual({
			fact_id: created.rawSource.id,
			derived_from: null,
		});
		const mergedFact = memoryFactRow(store, created.merged.id);
		expect(mergedFact?.fact_id).toBe(created.merged.id);
		expect(JSON.parse(mergedFact?.derived_from ?? "[]")).toEqual([
			created.rawSource.id,
			original.id,
		]);

		const rows = eventRows(store);
		expect(rows.map((row) => [row.event_type, row.fact_id])).toEqual([
			["create", original.id],
			["create", created.rawSource.id],
			["create", created.merged.id],
			["supersede", created.rawSource.id],
			["supersede", original.id],
		]);
		expect(rows[2]?.derived_from).toBe(mergedFact?.derived_from);
		expect(JSON.parse(rows[3]?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({
				superseded_by: created.merged.id,
				supersedes: created.rawSource.id,
				supersede_mode: "merge",
			}),
		);
		expect(JSON.parse(rows[4]?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({
				superseded_by: created.merged.id,
				supersedes: original.id,
				supersede_mode: "merge",
			}),
		);
	});

	it("rejects cross-project merge closes without mutating the foreign row", async () => {
		const foreign = await store.store({
			text: "Telemetry cross-project merge source fact",
			category: "episodic",
			projectId: "telemetry-merge-a",
		});

		await expect(
			store.createMergeWithRawLineage({
				rawSource: {
					text: "Telemetry cross-project merge raw source fact",
					category: "episodic",
					projectId: "telemetry-merge-b",
				},
				merged: {
					text: "Telemetry cross-project merge consolidated fact",
					category: "episodic",
					projectId: "telemetry-merge-b",
				},
				closeExisting: [
					{
						id: foreign.id,
						buildMetadata: ({ mergedId }) => JSON.stringify({ superseded_by: mergedId }),
					},
				],
				buildRawSourceMetadata: ({ mergedId }) => JSON.stringify({ superseded_by: mergedId }),
			}),
		).rejects.toThrow(/projectId/);

		expect(memoryCount(store)).toBe(1);
		expect(memoryFactRow(store, foreign.id)).toEqual({
			fact_id: foreign.id,
			derived_from: null,
		});
		expect(JSON.parse(memoryMetadata(store, foreign.id) ?? "{}")).not.toHaveProperty(
			"superseded_by",
		);
		expect(eventRows(store).map((row) => row.event_type)).toEqual(["create"]);
	});

	it("rejects duplicate raw-source merge content before mutating closed rows", async () => {
		await store.store({
			text: "Telemetry duplicate raw-source merge fact",
			category: "episodic",
			projectId: "telemetry-merge-duplicate",
		});
		const original = await store.store({
			text: "Telemetry merge duplicate close candidate",
			category: "episodic",
			projectId: "telemetry-merge-duplicate",
		});

		await expect(
			store.createMergeWithRawLineage({
				rawSource: {
					text: "Telemetry duplicate raw-source merge fact",
					category: "episodic",
					projectId: "telemetry-merge-duplicate",
				},
				merged: {
					text: "Telemetry duplicate raw-source merged output",
					category: "episodic",
					projectId: "telemetry-merge-duplicate",
				},
				closeExisting: [
					{
						id: original.id,
						buildMetadata: ({ mergedId }) => JSON.stringify({ superseded_by: mergedId }),
					},
				],
				buildRawSourceMetadata: ({ mergedId }) => JSON.stringify({ superseded_by: mergedId }),
			}),
		).rejects.toThrow(/same raw source content/);

		expect(memoryCount(store)).toBe(2);
		expect(JSON.parse(memoryMetadata(store, original.id) ?? "{}")).not.toHaveProperty(
			"superseded_by",
		);
		expect(eventRows(store).map((row) => row.event_type)).toEqual(["create", "create"]);
	});

	it("records event creation and replacement supersede in one transaction", async () => {
		const original = await store.store({
			text: "Telemetry event supersede original fact",
			category: "episodic",
			projectId: "telemetry-event-supersede",
		});

		const created = await store.createEventAndSupersede({
			event: {
				text: "Telemetry event supersede event fact",
				category: "episodic",
				projectId: "telemetry-event-supersede",
			},
			replacement: {
				text: "Telemetry event supersede replacement fact",
				category: "episodic",
				projectId: "telemetry-event-supersede",
			},
			closeExisting: [
				{
					id: original.id,
					buildMetadata: ({ replacementId }) =>
						JSON.stringify({ superseded_by: replacementId }),
				},
			],
		});

		expect(memoryFactRow(store, created.event.id)).toEqual({
			fact_id: created.event.id,
			derived_from: null,
		});
		expect(memoryFactRow(store, created.replacement.id)).toEqual({
			fact_id: original.id,
			derived_from: null,
		});

		const rows = eventRows(store);
		expect(rows.map((row) => [row.event_type, row.fact_id])).toEqual([
			["create", original.id],
			["create", created.event.id],
			["create", original.id],
			["supersede", original.id],
		]);
		expect(rows[2]).toEqual(
			expect.objectContaining({
				source_event_id: rows[0]?.id,
				project_id: "telemetry-event-supersede",
				content_hash: created.replacement.contentHash,
				key_version: 1,
			}),
		);
		expect(JSON.parse(rows[2]?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({
				operation_source: "createEventAndSupersede.replacement",
				content_hash: created.replacement.contentHash,
				receipt_status: "signed",
			}),
		);
		expect(rows[3]).toEqual(
			expect.objectContaining({
				source_event_id: rows[0]?.id,
				project_id: "telemetry-event-supersede",
			}),
		);
		expect(JSON.parse(rows[3]?.metadata_json ?? "{}")).toEqual(
			expect.objectContaining({
				superseded_by: created.replacement.id,
				supersedes: original.id,
				supersede_mode: "one_to_one",
			}),
		);
	});

	it("rejects duplicate event replacement content before mutating closed rows", async () => {
		const original = await store.store({
			text: "Telemetry duplicate event original fact",
			category: "episodic",
			projectId: "telemetry-event-duplicate",
		});
		await store.store({
			text: "Telemetry duplicate event replacement fact",
			category: "episodic",
			projectId: "telemetry-event-duplicate",
		});

		await expect(
			store.createEventAndSupersede({
				event: {
					text: "Telemetry duplicate event marker fact",
					category: "episodic",
					projectId: "telemetry-event-duplicate",
				},
				replacement: {
					text: "Telemetry duplicate event replacement fact",
					category: "episodic",
					projectId: "telemetry-event-duplicate",
				},
				closeExisting: [
					{
						id: original.id,
						buildMetadata: ({ replacementId }) =>
							JSON.stringify({ superseded_by: replacementId }),
					},
				],
			}),
		).rejects.toThrow(/same replacement content/);

		expect(memoryCount(store)).toBe(2);
		expect(JSON.parse(memoryMetadata(store, original.id) ?? "{}")).not.toHaveProperty(
			"superseded_by",
		);
		expect(eventRows(store).map((row) => row.event_type)).toEqual(["create", "create"]);
	});

	it("rejects cross-project event replacement closes without mutating the foreign row", async () => {
		const foreign = await store.store({
			text: "Telemetry cross-project event supersede source fact",
			category: "episodic",
			projectId: "telemetry-event-a",
		});

		await expect(
			store.createEventAndSupersede({
				event: {
					text: "Telemetry cross-project event fact",
					category: "episodic",
					projectId: "telemetry-event-b",
				},
				replacement: {
					text: "Telemetry cross-project replacement fact",
					category: "episodic",
					projectId: "telemetry-event-b",
				},
				closeExisting: [
					{
						id: foreign.id,
						buildMetadata: ({ replacementId }) =>
							JSON.stringify({ superseded_by: replacementId }),
					},
				],
			}),
		).rejects.toThrow(/projectId/);

		expect(memoryCount(store)).toBe(1);
		expect(memoryFactRow(store, foreign.id)).toEqual({
			fact_id: foreign.id,
			derived_from: null,
		});
		expect(JSON.parse(memoryMetadata(store, foreign.id) ?? "{}")).not.toHaveProperty(
			"superseded_by",
		);
		expect(eventRows(store).map((row) => row.event_type)).toEqual(["create"]);
	});
});
