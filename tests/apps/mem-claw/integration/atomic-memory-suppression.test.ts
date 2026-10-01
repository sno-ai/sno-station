/** @file atomic-memory-suppression.test.ts
 * @purpose Proves project-scoped key/content suppression at the atomic write door.
 * @boundary Real encrypted SQLite, forget parameter parsing, and the registered forget tool.
 */

import { dirname } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { executeMemoryForgetTool } from "../../../../packages/memory/src/engine/bindings/memory-forget-tool.ts";
import type { ToolContext } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas.ts";
import { forgetParamsSchema } from "../../../../packages/memory/src/engine/bindings/memory-tool-schemas";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes";
import {
	type AtomicExtractionLedgerKey,
	type AtomicExtractionRunParameters,
	type AtomicExtractionWriteCard,
	hashMemorySuppressionContent,
	MemoryStore,
} from "../../../../packages/memory/src/store/store";
import type { SqliteDatabaseLike } from "../../../../packages/memory/src/store/sqlite-runtime";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db";
import { asClawResult } from "../helpers/tool-result";

const RUN_PARAMETERS: AtomicExtractionRunParameters = {
	maxInputTokens: 4_096,
	outputTokenBudget: 2_000,
	subchunkCount: 1,
};

const PROJECT_A = "suppression-project-a";
const PROJECT_B = "suppression-project-b";
const EXTRACTOR_VERSION = "atomic-v3-suppression-test";

interface CountRow {
	count: number;
}

interface SuppressionRow {
	project_id: string;
	subject: string | null;
	attribute: string | null;
	content_hash: string | null;
	created_at: number;
}

function ledgerKey(suffix: string): AtomicExtractionLedgerKey {
	return {
		conversationId: `conversation-${suffix}`,
		chunkHash: `chunk-${suffix}`,
		pipelineVersion: EXTRACTOR_VERSION,
	};
}

function card(
	idempotencyKey: string,
	overrides: Partial<AtomicExtractionWriteCard> = {},
): AtomicExtractionWriteCard {
	return {
		idempotencyKey,
		text: "The user lives in Kyoto.",
		category: "episodic",
		subject: "user",
		attribute: "identity.location",
		timestamp: Date.UTC(2026, 5, 4, 9, 30),
		validFrom: null,
		validUntil: null,
		importance: 0.8,
		timezone: "Asia/Tokyo",
		lane: "active",
		dispositionReason: null,
		rawCandidateJson: null,
		metadata: { value: "Kyoto" },
		relations: [],
		...overrides,
	};
}

function readCount(database: SqliteDatabaseLike, sql: string, ...parameters: unknown[]): number {
	return (database.prepare(sql).get(...parameters) as CountRow).count;
}

function readSuppressions(database: SqliteDatabaseLike): SuppressionRow[] {
	return database
		.prepare(
			`SELECT project_id, subject, attribute, content_hash, created_at
			FROM nodix_memory_suppressions
			ORDER BY created_at, project_id`,
		)
		.all() as SuppressionRow[];
}

async function writeChunk(
	store: MemoryStore,
	database: SqliteDatabaseLike,
	input: {
		suffix: string;
		projectId: string;
		nowMs: number;
		cards: readonly AtomicExtractionWriteCard[];
	},
) {
	const key = ledgerKey(input.suffix);
	expect(
		store.beginAtomicExtractionChunk({
			...key,
			rawChunk: `raw transcript for ${input.suffix}`,
			routingSnapshotId: "routing-snapshot-suppression",
			runParameters: RUN_PARAMETERS,
			nowMs: input.nowMs,
		}),
	).toMatchObject({ action: "run", entry: { state: "open" } });
	store.recordAtomicExtractionCalls(key, input.nowMs + 1);
	const result = await store.storeAtomicExtractionChunk({
		ledgerKey: key,
		projectId: input.projectId,
		extractorVersion: EXTRACTOR_VERSION,
		nowMs: input.nowMs + 2,
		cards: input.cards,
	});
	expect(result.ledger.state).toBe("complete");
	expect(
		(database
			.prepare(
				"SELECT state FROM nodix_atomic_extraction_ledger WHERE conversation_id = ? AND chunk_hash = ? AND pipeline_version = ?",
			)
			.get(key.conversationId, key.chunkHash, key.pipelineVersion) as { state: string }).state,
	).toBe("complete");
	return result;
}

let embedder: Embedder;

beforeAll(async () => {
	embedder = await createTestEmbedder();
});

describe("atomic memory suppression", () => {
	let fixture: TestDb;
	let store: MemoryStore;

	beforeEach(() => {
		fixture = createTestDb();
		store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
	});

	afterEach(async () => {
		await store.close();
		fixture.cleanup();
	});

	it("rejects blank inputs and creates exactly the key and content shapes", async () => {
		await expect(
			store.createMemorySuppression({
				projectId: PROJECT_A,
				subject: " ",
				attribute: "identity.location",
				nowMs: 1,
			}),
		).rejects.toThrow(/subject must not be empty/u);
		await expect(
			store.createMemorySuppression({
				projectId: PROJECT_A,
				subject: "user",
				attribute: "\t",
				nowMs: 2,
			}),
		).rejects.toThrow(/attribute must not be empty/u);
		await expect(
			store.createMemorySuppression({ projectId: PROJECT_A, content: "  ", nowMs: 3 }),
		).rejects.toThrow(/content must not be empty/u);
		expect(readSuppressions(fixture.runtime.db)).toEqual([]);

		await expect(
			store.createMemorySuppression({
				projectId: PROJECT_A,
				subject: "user",
				attribute: "identity.location",
				nowMs: 10,
			}),
		).resolves.toEqual({ created: true, shape: "key", projectId: PROJECT_A });
		const content = "Caf\u00e9 is the preferred meeting place.";
		await expect(
			store.createMemorySuppression({ projectId: PROJECT_A, content, nowMs: 11 }),
		).resolves.toEqual({ created: true, shape: "content", projectId: PROJECT_A });

		expect(readSuppressions(fixture.runtime.db)).toEqual([
			{
				project_id: PROJECT_A,
				subject: "user",
				attribute: "identity.location",
				content_hash: null,
				created_at: 10,
			},
			{
				project_id: PROJECT_A,
				subject: null,
				attribute: null,
				content_hash: hashMemorySuppressionContent(content),
				created_at: 11,
			},
		]);
	});

	it("refuses same-project matches while preserving other projects and admitted batch cards", async () => {
		await store.createMemorySuppression({
			projectId: PROJECT_A,
			subject: "user",
			attribute: "identity.location",
			nowMs: 20,
		});
		const composedContent = "Caf\u00e9 is the preferred meeting place.";
		await store.createMemorySuppression({
			projectId: PROJECT_A,
			content: composedContent,
			nowMs: 21,
		});

		const keySuppressed = await writeChunk(store, fixture.runtime.db, {
			suffix: "key-suppressed-one",
			projectId: PROJECT_A,
			nowMs: 30,
			cards: [card("key-suppressed-one")],
		});
		expect(keySuppressed).toMatchObject({
			createdCount: 0,
			cardIds: [],
			suppressed: [{ idempotencyKey: "key-suppressed-one", reason: "key-suppressed" }],
		});

		const differentValueSameKey = await writeChunk(store, fixture.runtime.db, {
			suffix: "key-suppressed-two",
			projectId: PROJECT_A,
			nowMs: 40,
			cards: [
				card("key-suppressed-two", {
					text: "The user now lives in Osaka.",
					metadata: { value: "Osaka" },
				}),
			],
		});
		expect(differentValueSameKey.suppressed).toEqual([
			{ idempotencyKey: "key-suppressed-two", reason: "key-suppressed" },
		]);

		const decomposedContent = "Cafe\u0301 is the preferred meeting place.";
		const contentSuppressed = await writeChunk(store, fixture.runtime.db, {
			suffix: "content-suppressed",
			projectId: PROJECT_A,
			nowMs: 50,
			cards: [
				card("content-suppressed", {
					text: decomposedContent,
					attribute: "preference.place",
				}),
			],
		});
		expect(contentSuppressed.suppressed).toEqual([
			{ idempotencyKey: "content-suppressed", reason: "content-suppressed" },
		]);
		expect(readCount(fixture.runtime.db, "SELECT COUNT(*) AS count FROM nodix_memories")).toBe(0);

		const otherProject = await writeChunk(store, fixture.runtime.db, {
			suffix: "other-project",
			projectId: PROJECT_B,
			nowMs: 60,
			cards: [card("other-project", { text: decomposedContent })],
		});
		expect(otherProject).toMatchObject({ createdCount: 1, suppressed: [] });
		expect(
			readCount(
				fixture.runtime.db,
				"SELECT COUNT(*) AS count FROM nodix_memories WHERE project_id = ?",
				PROJECT_B,
			),
		).toBe(1);

		const admitted = card("batch-admitted", {
			text: "The user prefers jazz.",
			attribute: "preference.music",
			metadata: { value: "jazz" },
		});
		const mixed = await writeChunk(store, fixture.runtime.db, {
			suffix: "mixed-batch",
			projectId: PROJECT_A,
			nowMs: 70,
			cards: [card("batch-suppressed"), admitted],
		});
		expect(mixed).toMatchObject({
			createdCount: 1,
			suppressed: [{ idempotencyKey: "batch-suppressed", reason: "key-suppressed" }],
		});
		expect(mixed.cardIds).toHaveLength(1);
		expect(
			fixture.runtime.db
				.prepare(
					"SELECT text, project_id, attribute FROM nodix_memories WHERE id = ?",
				)
				.get(mixed.cardIds[0]),
		).toEqual({ text: admitted.text, project_id: PROJECT_A, attribute: admitted.attribute });
		expect(
			readCount(
				fixture.runtime.db,
				"SELECT COUNT(*) AS count FROM nodix_memory_chunks WHERE memory_id = ?",
				mixed.cardIds[0],
			),
		).toBe(1);
	});

	it("requires one scoped forget action and stores a suppression through the internal service binding", async () => {
		const keyInput = {
			suppress_key: { subject: "user", attribute: "preference.food" },
			scope: "global",
		};
		const contentInput = { suppress_content: "The user avoids peanuts.", scope: "global" };
		expect(forgetParamsSchema.safeParse(keyInput).success).toBe(true);
		expect(forgetParamsSchema.safeParse(contentInput).success).toBe(true);
		for (const invalid of [
			{},
			{ suppress_key: keyInput.suppress_key },
			{ suppress_content: contentInput.suppress_content, scope: " " },
			{ ...keyInput, suppress_content: contentInput.suppress_content },
		]) {
			expect(forgetParamsSchema.safeParse(invalid).success).toBe(false);
		}

		const context = {
			store,
			retriever: {},
			scopePolicy: createScopePolicy(),
			embedder,
			agentId: "suppression-test-agent",
			stateDir: dirname(fixture.dbPath),
		} as ToolContext;

		const result = asClawResult(await executeMemoryForgetTool(context, { agentId: context.agentId }, "suppress-key", keyInput));

		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toMatch(/key suppression created/u);
		expect(result.details?.suppression).toEqual({
			created: true,
			shape: "key",
			projectId: "global",
		});
		expect(readSuppressions(fixture.runtime.db)).toEqual([
			{
				project_id: "global",
				subject: "user",
				attribute: "preference.food",
				content_hash: null,
				created_at: expect.any(Number),
			},
		]);
	});
});
