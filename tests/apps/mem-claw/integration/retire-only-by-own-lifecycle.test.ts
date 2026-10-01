/** @file retire-only-by-own-lifecycle.test.ts
 * @purpose Proves stored history is retired only by its own lifecycle.
 * @boundary Real atomic write, encrypted SQLite, supersede transaction, and internal recall binding.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client.ts";
import {
	buildInsightMetadata,
	stringifyInsightMetadata,
} from "../../../../packages/memory/src/engine/extraction/memory-metadata-codec.ts";
import { executeMemoryRecallTool } from "../../../../packages/memory/src/engine/bindings/memory-recall-tool.ts";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../../../packages/memory/src/engine/retrieval/retriever.ts";
import { createScopePolicy } from "../../../../packages/memory/src/engine/security/scopes.ts";
import { MemoryStore } from "../../../../packages/memory/src/store/store.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../helpers/test-db.ts";
import { asClawResult, getRecallMemories } from "../helpers/tool-result.ts";

const SESSION_MS = Date.parse("2026-06-01T12:00:00.000Z");
const ADDRESS = "preferences.general";
const TEST_TIMEOUT_MS = 180_000;

function metadataOf(row: { metadata?: string }): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(row.metadata ?? "{}");
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function metadataJson(patch: Record<string, unknown>): string {
	return JSON.stringify({ valid_from: SESSION_MS, asserted_at: SESSION_MS, ...patch });
}

describe("a memory is retired only by its own lifecycle", () => {
	let embedder: Embedder;
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;
	let stateDir: string | undefined;
	let previousStateDir: string | undefined;

	beforeAll(async () => {
		embedder = await createTestEmbedder();
	}, TEST_TIMEOUT_MS);

	afterEach(async () => {
		await store?.close();
		fixture?.cleanup();
		if (stateDir) rmSync(stateDir, { recursive: true, force: true });
		if (previousStateDir === undefined) delete process.env.SNO_PROFILE_DIR;
		else process.env.SNO_PROFILE_DIR = previousStateDir;
		fixture = undefined;
		store = undefined;
		stateDir = undefined;
		previousStateDir = undefined;
	});

	it(
		"leaves refused history live when a profile row at the same address is retired",
		async () => {
			fixture = createTestDb();
			store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
			const scope = "retire-own-lifecycle-address";
			const profile = await store.store({
				text: "The user keeps the grocery budget at 400 dollars a month.",
				category: "profile",
				projectId: scope,
				trusted: true,
				timestamp: SESSION_MS,
				metadata: metadataJson({
					kind: "profile",
					section_name: ADDRESS,
					fact_key: `profile:${ADDRESS}`,
				}),
			});
			const refusedRows = await Promise.all(
				[
					"So, AI can predict, but human testing is still crucial.",
					"user: I told my manager I would review the deck on Tuesday.",
					"The design team moved its meeting to Thursday.",
				].map((text) =>
					store?.store({
						text,
						category: "episodic",
						projectId: scope,
						timestamp: SESSION_MS,
						dispositionReason: "subject_not_user",
						dispositionedAt: SESSION_MS,
						metadata: metadataJson({ kind: "episodic", section_name: ADDRESS }),
					}),
				),
			);
			if (refusedRows.some((row) => row === undefined)) {
				throw new Error("refused-row setup failed");
			}
			const ordinary = await store.store({
				text: "Bought a coffee for 3.66 dollars on 2026-06-01.",
				category: "episodic",
				projectId: scope,
				timestamp: SESSION_MS,
				metadata: metadataJson({ kind: "episodic", section_name: ADDRESS }),
			});
			const profileMetadata = metadataOf(profile);
			const replacement = await store.supersede({
				create: {
					text: "The user keeps the grocery budget at 550 dollars a month.",
					category: "profile",
					projectId: scope,
					trusted: true,
					timestamp: SESSION_MS,
					metadata: metadataJson({
						kind: "profile",
						section_name: ADDRESS,
						fact_key: `profile:${ADDRESS}`,
					}),
				},
				closes: [
					{
						id: profile.id,
						buildMetadata: (createdId: string) =>
							stringifyInsightMetadata(
								buildInsightMetadata(profile, {
									...profileMetadata,
									invalidated_at: SESSION_MS,
									superseded_by: createdId,
								}),
							),
					},
				],
			});

			const rows = await store.list({ projectId: scope, limit: 20 });
			const byId = new Map(rows.map((row) => [row.id, row]));
			expect(metadataOf(byId.get(profile.id) ?? {}).invalidated_at).toBe(SESSION_MS);
			expect(metadataOf(byId.get(profile.id) ?? {}).superseded_by).toBe(replacement.id);
			for (const refused of refusedRows) {
				if (!refused) continue;
				const stored = byId.get(refused.id);
				expect(stored).toBeDefined();
				expect(metadataOf(stored ?? {}).invalidated_at).toBeUndefined();
				expect(metadataOf(stored ?? {}).superseded_by).toBeUndefined();
			}
			const storedOrdinary = byId.get(ordinary.id);
			expect(storedOrdinary).toBeDefined();
			expect(metadataOf(storedOrdinary ?? {}).invalidated_at).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"stores a retracting candidate as history without retiring its predecessor",
		async () => {
			fixture = createTestDb();
			store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
			const scope = "retire-own-lifecycle-extraction";
			const target = await store.store({
				text: "The user tracks the Orion migration task.",
				category: "episodic",
				projectId: scope,
				timestamp: SESSION_MS,
				metadata: metadataJson({ kind: "episodic" }),
			});
			await store.store({
				text: "The user drinks oat milk flat whites.",
				category: "episodic",
				projectId: scope,
				timestamp: SESSION_MS,
				metadata: metadataJson({ kind: "episodic" }),
			});
			const candidateText = "The user stopped tracking the Orion migration task.";
			const ledgerKey = {
				conversationId: `${scope}-session`, chunkHash: "retracting-candidate", pipelineVersion: "test",
			};
			store.beginAtomicExtractionChunk({
				...ledgerKey, rawChunk: `user: ${candidateText}`, routingSnapshotId: "test",
				runParameters: { maxInputTokens: 4096, outputTokenBudget: 4096, subchunkCount: 1 },
				nowMs: SESSION_MS + 86_400_000,
			});
			store.recordAtomicExtractionCalls(ledgerKey, SESSION_MS + 86_400_001);
			const written = await store.storeAtomicExtractionChunk({
				ledgerKey, projectId: scope, extractorVersion: "test", nowMs: SESSION_MS + 86_400_002,
				cards: [{
					idempotencyKey: "retracting-candidate", globalTurnIndex: 0, endsCurrent: true, endedAt: null, text: candidateText, category: "episodic",
					subject: "user", attribute: null, timestamp: SESSION_MS + 86_400_000,
					validFrom: null, validUntil: null, importance: 0.7, timezone: "UTC", lane: "active",
					dispositionReason: null, rawCandidateJson: null,
					metadata: { kind: "episodic", ends_current: true }, relations: [],
				}],
			});
			expect(written.ledger.state).toBe("complete");

			const rows = await store.list({ projectId: scope, limit: 20 });
			const targetAfter = rows.find((row) => row.id === target.id);
			const storedCandidate = rows.find((row) => row.id !== target.id && row.text.includes("stopped"));
			expect(targetAfter).toBeDefined();
			expect(storedCandidate).toBeDefined();
			expect(metadataOf(targetAfter ?? {}).invalidated_at).toBeUndefined();
			expect(metadataOf(targetAfter ?? {}).superseded_by).toBeUndefined();
			expect(metadataOf(storedCandidate ?? {}).supersedes).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"returns a stored cancellation even when its target is absent from recall results",
		async () => {
			previousStateDir = process.env.SNO_PROFILE_DIR;
			stateDir = mkdtempSync(join(tmpdir(), "mem-claw-retire-own-lifecycle-"));
			process.env.SNO_PROFILE_DIR = stateDir;
			fixture = createTestDb();

			store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
			const target = await store.store({
				text: "The user tracks the Orion migration task.",
				vector: await embedder.embed("The user tracks the Orion migration task."),
				category: "episodic",
				projectId: "global",
			});
			const cancellationText = "The user stopped tracking the Orion migration task.";
			const cancellation = await store.store({
				text: cancellationText,
				vector: await embedder.embed(cancellationText),
				category: "episodic",
				projectId: "global",
				metadata: JSON.stringify({ supersedes: target.id }),
			});
			const context = {
				store, embedder, stateDir: stateDir, scopePolicy: createScopePolicy(),
				retriever: createRetriever(store, embedder, { warn: () => {} }, {
					...DEFAULT_RETRIEVAL_CONFIG, minScore: 0, hardMinScore: 0, rerank: "none",
				}),
			};
			const recalled = getRecallMemories<{ id: string }>(
				asClawResult(
					await executeMemoryRecallTool(context, { agentId: "retire-own-lifecycle-agent" }, "retire-own-lifecycle-call", {
						query: cancellationText,
						top_k: 1,
						min_score: 0,
					}, { name: "memory_recall", label: "Memory Recall", description: "" }),
				),
			);

			expect(recalled.map((memory) => memory.id)).toEqual([cancellation.id]);
			expect(recalled.some((memory) => memory.id === target.id)).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);
});
