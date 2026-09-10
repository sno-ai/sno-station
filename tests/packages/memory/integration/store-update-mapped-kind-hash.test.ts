/** Real LLM API required. No mocking. Missing keys = FAIL. */

/**
 * MemoryStore.update — mappedKind discriminator must flow into content_hash.
 *
 * Recent fix (apps/mem-claw/src/storage/store.ts:1928):
 *   nextHash = stableHash(hashInputForEntry(nextText, nextMetadata));
 *
 * Before the fix, update() recomputed the hash from text alone, which
 * collapsed the (project_id, content_hash, category) UNIQUE invariant when two
 * rows shared text + category but had different metadata.mappedKind values
 * (PRD §4.2 reflection v3 — user-model vs agent-model both → preference).
 *
 * Verifies:
 *  1. store() inserts with same text + category but different mappedKind
 *     produce DISTINCT content_hash (the precondition the update path
 *     must preserve).
 *  2. update() that flips mappedKind to a new (unused) value rewrites
 *     content_hash to the value `stableHash(hashInputForEntry(text, meta))`
 *     would produce on a fresh insert.
 *  3. update() that flips mappedKind to match an existing sibling row's
 *     mappedKind raises StorageError because the widened collision check
 *     now fires on any hash change, not only text changes.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "@/extraction/embedding-provider-client";
import { sanitizeMemoryMetadataString } from "@/storage/content-sanitizer-bridge";
import { MemoryStore } from "@/storage/store";
import type { MemoryMetadata } from "@/shared/types";
import { stableHash } from "@/shared/utils";
import { createTestDb, createTestEmbedder } from "../helpers/test-db.ts";

let testEmbedder: Embedder;
const TEST_SECRET_VALUE = "test-secret-value-do-not-use-metadata";
const INTERNAL_IDEMPOTENCY_KEY = ["01234567", "89abcdef"].join("").repeat(4);

interface CountRow {
	count: number;
}

function sqliteFromStore(store: MemoryStore): {
	prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
} {
	return (
		store as unknown as {
			sqlite: {
				prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
			};
		}
	).sqlite;
}

function readMetadata(store: MemoryStore, id: string): Record<string, unknown> {
	const row = sqliteFromStore(store)
		.prepare("SELECT metadata FROM nodix_memories WHERE id = ? LIMIT 1")
		.get(id) as { metadata: string } | undefined;
	return JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
}

function readStoredRow(
	store: MemoryStore,
	id: string,
): { text: string; metadata: Record<string, unknown>; contentHash: string } {
	const row = sqliteFromStore(store)
		.prepare(
			"SELECT text, metadata, content_hash AS contentHash FROM nodix_memories WHERE id = ? LIMIT 1",
		)
		.get(id) as { text: string; metadata: string; contentHash: string } | undefined;
	if (!row) throw new Error(`missing test row ${id}`);
	return {
		text: row.text,
		metadata: JSON.parse(row.metadata) as Record<string, unknown>,
		contentHash: row.contentHash,
	};
}

// Mirror the (private) `hashInputForEntry` helper in store.ts so the test can
// independently compute the expected hash. Keeping a copy here is intentional —
// if the real helper drifts, this test must drift with it (machine contract).
function hashInputForEntry(text: string, metadata: string | undefined): string {
	if (!metadata) return text;
	let mappedKind: unknown;
	try {
		mappedKind = (JSON.parse(metadata) as { mappedKind?: unknown }).mappedKind;
	} catch {
		return text;
	}
	if (typeof mappedKind !== "string" || mappedKind.length === 0) return text;
	return JSON.stringify(["mem-claw:hash:v1", text, mappedKind]);
}

beforeAll(async () => {
	testEmbedder = await createTestEmbedder();
});

describe("MemoryStore.update mappedKind hash discriminator", () => {
	let dbPath: string;
	let cleanup: () => void;
	let store: MemoryStore;

	beforeEach(() => {
		const testDb = createTestDb();
		dbPath = testDb.dbPath;
		cleanup = testDb.cleanup;
		store = new MemoryStore({ dbPath, embedder: testEmbedder });
	});

	afterEach(async () => {
		await store.close();
		cleanup();
	});

	const SHARED_TEXT =
		"The deployment runbook for the staging gateway documents rollback steps and on-call paging.";
	const SCOPE = "global";

	it("store() with same text + category but different mappedKind yields distinct content_hash", async () => {
		const userModelEntry = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ mappedKind: "user-model" }),
		});
		const agentModelEntry = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ mappedKind: "agent-model" }),
		});

		expect(userModelEntry.contentHash).not.toBe(agentModelEntry.contentHash);
		expect(userModelEntry.id).not.toBe(agentModelEntry.id);
	});

	it("store() preserves metadata JSON keys after sanitizer so idempotency still deduplicates", async () => {
		const metadata = JSON.stringify({
			idempotency_key: INTERNAL_IDEMPOTENCY_KEY,
			mappedKind: "user-model",
			api_key: TEST_SECRET_VALUE,
		});
		const sanitizedMetadata = JSON.parse(
			sanitizeMemoryMetadataString(metadata) ?? "{}",
		) as Record<string, unknown>;
		expect(sanitizedMetadata.idempotency_key).toBe(INTERNAL_IDEMPOTENCY_KEY);
		const first = await store.store({
			text: "Metadata sanitizer first idempotent memory",
			category: "episodic",
			projectId: SCOPE,
			metadata,
		});
		const duplicate = await store.store({
			text: "Metadata sanitizer second idempotent memory with changed text",
			category: "episodic",
			projectId: SCOPE,
			metadata,
		});

		const parsed = readMetadata(store, first.id);
		const stored = readStoredRow(store, first.id);
		expect(parsed.idempotency_key).toBe(INTERNAL_IDEMPOTENCY_KEY);
		expect(duplicate.id).toBe(first.id);
		expect(duplicate.contentHash).toBe(first.contentHash);
		expect(stored.text).toBe("Metadata sanitizer first idempotent memory");
		expect(stored.contentHash).toBe(first.contentHash);
		expect(parsed.mappedKind).toBe("user-model");
		expect(parsed.api_key).toBe("[REDACTED_SECRET]");
		expect(JSON.stringify(parsed)).not.toContain(TEST_SECRET_VALUE);
		await expect(store.stats(SCOPE)).resolves.toMatchObject({ total: 1 });
	});

	it("importEntry() without contentHash preserves mappedKind in fallback hash", async () => {
		const userMetadata = JSON.stringify({ mappedKind: "user-model" });
		const agentMetadata = JSON.stringify({ mappedKind: "agent-model" });

		const userModelEntry = await store.importEntry({
			id: randomUUID(),
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			importance: 0.7,
			timestamp: Date.now(),
			metadata: userMetadata,
		} as Parameters<MemoryStore["importEntry"]>[0]);
		const agentModelEntry = await store.importEntry({
			id: randomUUID(),
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			importance: 0.7,
			timestamp: Date.now() + 1,
			metadata: agentMetadata,
		} as Parameters<MemoryStore["importEntry"]>[0]);

		expect(userModelEntry.contentHash).toBe(
			stableHash(hashInputForEntry(SHARED_TEXT, userMetadata)),
		);
		expect(agentModelEntry.contentHash).toBe(
			stableHash(hashInputForEntry(SHARED_TEXT, agentMetadata)),
		);
		expect(userModelEntry.contentHash).not.toBe(agentModelEntry.contentHash);
		await expect(store.stats(SCOPE)).resolves.toMatchObject({ total: 2 });
	});

	it("importEntry() preserves structured metadata JSON while redacting secret values", async () => {
		const metadata = JSON.stringify({
			mappedKind: "user-model",
			api_key: TEST_SECRET_VALUE,
			source_session: "metadata-sanitize-import-session",
		});

		const imported = await store.importEntry({
			id: randomUUID(),
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			importance: 0.7,
			timestamp: Date.now(),
			metadata,
		} as Parameters<MemoryStore["importEntry"]>[0]);

		const parsed = readMetadata(store, imported.id);
		expect(parsed.mappedKind).toBe("user-model");
		expect(parsed.api_key).toBe("[REDACTED_SECRET]");
		expect(parsed.source_session).toBe("metadata-sanitize-import-session");
		expect(JSON.stringify(parsed)).not.toContain(TEST_SECRET_VALUE);
		expect(imported.contentHash).toBe(stableHash(hashInputForEntry(SHARED_TEXT, imported.metadata)));
	});

	it("importEntry() rejects duplicate content key under another id without deleting existing chunks", async () => {
		const original = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ mappedKind: "user-model" }),
		});
		const duplicateId = randomUUID();

		await expect(
			store.importEntry({
				id: duplicateId,
				text: SHARED_TEXT,
				category: "episodic",
				projectId: SCOPE,
				importance: 0.7,
				timestamp: Date.now() + 1,
				metadata: original.metadata,
				contentHash: original.contentHash,
			}),
		).rejects.toThrow(
			/another memory in projectId 'global' already has the same content/,
		);

		expect(store.getById(original.id)).toMatchObject({
			id: original.id,
			contentHash: original.contentHash,
		});
		expect(store.getById(duplicateId)).toBeUndefined();

		const sqlite = sqliteFromStore(store);
		const memoryRows = sqlite
			.prepare("SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ?")
			.get(SCOPE) as CountRow;
		const chunkRows = sqlite
			.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunks WHERE memory_id = ?")
			.get(original.id) as CountRow;
		const vecRows = sqlite
			.prepare("SELECT COUNT(*) AS count FROM nodix_memory_chunk_vectors")
			.get() as CountRow;

		expect(memoryRows.count).toBe(1);
		expect(chunkRows.count).toBeGreaterThan(0);
		expect(vecRows.count).toBe(chunkRows.count);
	});

	it("update() that changes mappedKind to a new value rewrites content_hash via hashInputForEntry", async () => {
		const seed = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ mappedKind: "user-model" }),
		});

		const newMetadata = JSON.stringify({ mappedKind: "lesson" });
		const updated = await store.update(seed.id, { metadata: newMetadata });
		expect(updated).not.toBeNull();

		// Reload from DB so we read the durable hash, not the in-memory return.
		const reloaded = store.getById(seed.id);
		expect(reloaded).toBeDefined();

		const expectedHash = stableHash(
			hashInputForEntry(SHARED_TEXT, newMetadata),
		);
		expect(reloaded?.contentHash).toBe(expectedHash);
		// Sanity: the rewrite must differ from the seed's hash, otherwise the
		// discriminator did not flow through the update path.
		expect(reloaded?.contentHash).not.toBe(seed.contentHash);
	});

	it("update() preserves lifecycle metadata JSON while redacting secret values", async () => {
		const seed = await store.store({
			text: "Metadata sanitizer update lifecycle memory",
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ mappedKind: "user-model" }),
		});
		const invalidatedAt = Date.now() + 60_000;

		const updated = await store.update(seed.id, {
			metadata: JSON.stringify({
				mappedKind: "agent-model",
				invalidated_at: invalidatedAt,
				superseded_by: "replacement-memory-id",
				api_key: TEST_SECRET_VALUE,
			}),
		});

		expect(updated).not.toBeNull();
		const parsed = readMetadata(store, seed.id);
		expect(parsed.mappedKind).toBe("agent-model");
		expect(parsed.invalidated_at).toBe(invalidatedAt);
		expect(parsed.superseded_by).toBe("replacement-memory-id");
		expect(parsed.api_key).toBe("[REDACTED_SECRET]");
		expect(JSON.stringify(parsed)).not.toContain(TEST_SECRET_VALUE);
	});

	it("updateMetadata() rejects mappedKind changes that would leave stale content_hash", async () => {
		const seed = await store.store({
			text: "Metadata-only mappedKind mutation must not bypass hash recomputation.",
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ mappedKind: "user-model", tier: "peripheral" }),
		});

		await expect(
			store.updateMetadata(seed.id, {
				mappedKind: "agent-model",
			} as Parameters<MemoryStore["updateMetadata"]>[1]),
		).rejects.toThrow(/hash-significant metadata/);

		const stored = readStoredRow(store, seed.id);
		expect(stored.contentHash).toBe(seed.contentHash);
		expect(stored.metadata.mappedKind).toBe("user-model");
		expect(stored.metadata.tier).toBe("peripheral");
	});

	it("applyMetadataDelta() rejects idempotency key changes that would leave stale content_hash", async () => {
		const seed = await store.store({
			text: "Metadata-only idempotency mutation must not bypass hash recomputation.",
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({
				idempotency_key: "stable-delta-idempotency-key",
				tier: "peripheral",
			}),
		});

		await expect(
			// idempotency_key is hash-significant and intentionally excluded from the
			// MemoryMetadata delta type; cast to exercise the runtime rejection guard.
			store.applyMetadataDelta(seed.id, () => ({
				idempotency_key: "changed-delta-idempotency-key",
			}) as unknown as Partial<MemoryMetadata>),
		).rejects.toThrow(/idempotency_key/);

		const stored = readStoredRow(store, seed.id);
		expect(stored.contentHash).toBe(seed.contentHash);
		expect(stored.metadata.idempotency_key).toBe("stable-delta-idempotency-key");
		expect(stored.metadata.tier).toBe("peripheral");
	});

	it("updateTier() preserves content_hash while allowing non-hash metadata changes", async () => {
		const seed = await store.store({
			text: "Tier transition should not rewrite a content identity field.",
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ mappedKind: "user-model", tier: "peripheral" }),
		});

		await store.updateTier(seed.id, "core", { writerAuthority: "offline-family" });

		const stored = readStoredRow(store, seed.id);
		expect(stored.contentHash).toBe(seed.contentHash);
		expect(stored.metadata.mappedKind).toBe("user-model");
		expect(stored.metadata.tier).toBe("core");
	});

	it("updateMetadata() rejects ambient capture hash metadata changes", async () => {
		const seed = await store.store({
			text: "Ambient chunk hash metadata must stay tied to the original chunk coordinates.",
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({
				source: "agent_end",
				role: "user",
				session_key: "ambient-session-a",
				chunk_index: 0,
				chunk_count: 1,
				chunking_version: "test-chunking-version",
				content_type: "prose",
			}),
		});

		await expect(
			store.updateMetadata(seed.id, {
				session_key: "ambient-session-b",
			} as Parameters<MemoryStore["updateMetadata"]>[1]),
		).rejects.toThrow(/ambient_capture/);

		const stored = readStoredRow(store, seed.id);
		expect(stored.contentHash).toBe(seed.contentHash);
		expect(stored.metadata.session_key).toBe("ambient-session-a");
	});

	it("update() rejects mappedKind flip that would collide with a sibling row's hash", async () => {
		const userModelSeed = await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ mappedKind: "user-model" }),
		});
		await store.store({
			text: SHARED_TEXT,
			category: "episodic",
			projectId: SCOPE,
			metadata: JSON.stringify({ mappedKind: "agent-model" }),
		});

		// Flipping the user-model row's mappedKind to "agent-model" would make
		// its content_hash collide with the second row. The widened
		// precondition in update() now fires on any hash change, so this must
		// throw — not silently corrupt the UNIQUE(project_id, content_hash, category)
		// invariant.
		await expect(
			store.update(userModelSeed.id, {
				metadata: JSON.stringify({ mappedKind: "agent-model" }),
			}),
		).rejects.toThrow(/already has the same content/);
	});
});
