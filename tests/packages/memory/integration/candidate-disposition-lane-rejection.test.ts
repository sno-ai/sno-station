/** @file candidate-disposition-lane-rejection.test.ts
 * @purpose Proves unresolved parked and quarantined candidates cannot reach persistence.
 * @boundary Production candidate processor, real Sno routing, ONNX embeddings, and encrypted SQLite.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { processExtractedCandidate } from "@/extraction/insight-distill-candidate-processor";
import { createLlmClient, type LlmClient } from "../../../../packages/memory/src/model/llm-client";
import type { LlmRoutingConfig } from "../../../../packages/memory/src/model/llm-mode-routing";
import type { CandidateMemory, ExtractionStats } from "../../../../packages/memory/src/engine/shared/types";
import { MemoryStore } from "../../../../packages/memory/src/store/store";
import { requireEnv } from "../../../apps/mem-claw/helpers/env.ts";
import { createTestDb, createTestEmbedder, type TestDb } from "../../../apps/mem-claw/helpers/test-db.ts";

const ROUTING: LlmRoutingConfig = {
	mode: "rem-enhanced",
	remEnhanced: {
		occasions: {
			memoryExtract: "snoRemMem",
			profileSectionMerge: "snoRemMem",
			profileActiveTaskClassify: "snoRemMem",
			conflictAdjudication: "snoRemMem",
			summaryBuild: "agent",
		},
	},
	agentNative: { flavor: "subscription" },
};
const SCOPE = "candidate-disposition-lane-rejection";
const SESSION_DATE_TIME = "2026-07-31T00:00:00.000Z";

describe("candidate disposition lane rejection", () => {
	let embedder: Embedder;
	let fixture: TestDb | undefined;
	let store: MemoryStore | undefined;

	beforeAll(async () => {
		embedder = await createTestEmbedder();
	});

	afterEach(async () => {
		await store?.close();
		fixture?.cleanup();
		store = undefined;
		fixture = undefined;
	});

	it(
		"rejects parked and quarantined junk while preserving an unseen sound event",
		{ timeout: 240_000 },
		async () => {
			fixture = createTestDb();
			store = new MemoryStore({ dbPath: fixture.dbPath, embedder });
			const llm: LlmClient = createLlmClient({
				apiKey: requireEnv("SNO_MEM_CLAW_LLM_INTERNAL_KEY"),
				preset: "mem_claw/sno_ai_extract",
				routing: ROUTING,
				timeoutMs: 90_000,
			});
			const parkedText =
				'{"evidence":["0"],"payload":{"dislikes":[],"likes":[]},"section":"active_tasks"}';
			const quarantinedText =
				'{"evidence":["0"],"payload":{"free":null,"location":null,"name":null,"occupation":null},"section":"identity"}';
			const candidates: CandidateMemory[] = [
				{
					category: "profile",
					sectionName: "active_tasks",
					abstract: parkedText,
					overview: parkedText,
					content: parkedText,
					lane: "parked",
					dispositionReason: "entity_capability_parked",
					rawCandidateJson: parkedText,
				},
				{
					category: "profile",
					sectionName: "identity",
					abstract: quarantinedText,
					overview: quarantinedText,
					content: quarantinedText,
					lane: "quarantined",
					dispositionReason: "payload_not_renderable",
					rawCandidateJson: quarantinedText,
				},
				{
					category: "episodic",
					abstract: "The user attended a chamber recital on Tuesday.",
					overview: "The user attended a chamber recital on Tuesday.",
					content: "The user attended a chamber recital on Tuesday.",
					eventAt: SESSION_DATE_TIME,
				},
			];
			const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };

			for (let index = 0; index < candidates.length; index++) {
				const candidate = candidates[index];
				if (!candidate) throw new Error(`missing candidate ${index}`);
				await processExtractedCandidate({
					candidate,
					sessionKey: "candidate-disposition-lane-rejection-session",
					stats,
					targetScope: SCOPE,
					scopeFilter: [SCOPE],
					store,
					embedder,
					llm,
					routing: ROUTING,
					sessionDateTime: SESSION_DATE_TIME,
					replayIdentity: `candidate-disposition-lane-rejection-${index}`,
				});
			}

			const rows = await store.list({ projectId: SCOPE, limit: 20 });
			expect(stats.rejected).toBe(2);
			expect(rows).toEqual([
				expect.objectContaining({
					category: "episodic",
					text: "The user attended a chamber recital on Tuesday.",
					timestamp: Date.parse(SESSION_DATE_TIME),
				}),
			]);
			expect(rows.every((row) => !row.text.includes("payload"))).toBe(true);
		},
	);
});
