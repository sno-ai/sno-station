/** @file b-profile-active-rejection.test.ts
 * @purpose Proves a rejected active profile candidate cannot reach profile persistence.
 * @boundary Real Sno classification, real profile writer, ONNX embeddings, and encrypted SQLite.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Embedder } from "../../../../packages/memory/src/engine/extraction/embedding-provider-client";
import { InsightDistiller } from "@/extraction/memory-extraction-pipeline";
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
			dedupDecision: "agent",
			profileSectionMerge: "snoRemMem",
			profileActiveTaskClassify: "snoRemMem",
			profileActiveTaskMatch: "snoRemMem",
			conflictAdjudication: "snoRemMem",
			summaryBuild: "agent",
			intentClassifier: "agent",
		},
	},
	agentNative: { flavor: "subscription" },
};
const SESSION_DATE_TIME = "2026-07-31T00:00:00.000Z";

type PipelineProbe = {
	routeProfileBornCandidates(candidates: CandidateMemory[]): Promise<{
		candidates: CandidateMemory[];
		drops: Array<{ disposition: string; originalText: string }>;
		gateUnavailable: boolean;
	}>;
};

describe("B-profile active rejection persistence boundary", () => {
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
		"drops model-rejected active junk while preserving an unseen sound fact",
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
			const distiller = new InsightDistiller(store, embedder, llm, {
				defaultScope: "b-profile-active-rejection",
				routing: ROUTING,
			}) as unknown as PipelineProbe;
			const junkEvidence = "user: Thanks for the update.";
			const soundEvidence =
				"user: My Riverstone project is scheduled to launch in October.";

			const routed = await distiller.routeProfileBornCandidates([
				{
					category: "profile",
					sectionName: "entities.project",
					abstract: '{"free":null,"location":null,"name":null}',
					overview: '{"free":null,"location":null,"name":null}',
					content: '{"free":null,"location":null,"name":null}',
					gateEvidenceText: junkEvidence,
				},
				{
					category: "profile",
					sectionName: "entities.project",
					abstract: "The user's Riverstone project is scheduled to launch in October.",
					overview: "The user's Riverstone project is scheduled to launch in October.",
					content: "The user's Riverstone project is scheduled to launch in October.",
					gateEvidenceText: soundEvidence,
				},
			]);
			const stats: ExtractionStats = { created: 0, merged: 0, skipped: 0 };
			for (let index = 0; index < routed.candidates.length; index++) {
				const candidate = routed.candidates[index];
				if (!candidate) throw new Error(`missing routed candidate ${index}`);
				await processExtractedCandidate({
					candidate,
					sessionKey: "b-profile-active-rejection-session",
					stats,
					targetScope: "b-profile-active-rejection",
					scopeFilter: ["b-profile-active-rejection"],
					store,
					embedder,
					llm,
					routing: ROUTING,
					sessionDateTime: SESSION_DATE_TIME,
					replayIdentity: `b-profile-active-rejection-${index}`,
				});
			}

			const rows = await store.list({ projectId: "b-profile-active-rejection", limit: 20 });
			process.stdout.write(
				`\nACTIVE_REJECTION_BEGIN\n${JSON.stringify(
					{
						gateUnavailable: routed.gateUnavailable,
						drops: routed.drops,
						rows: rows.map((row) => ({
							category: row.category,
							lane: row.lane,
							disposition: row.dispositionReason ?? null,
							text: row.text,
						})),
					},
					null,
					1,
				)}\nACTIVE_REJECTION_END\n`,
			);
			expect(routed.gateUnavailable).toBe(false);
			// Check what reached STORAGE, not which disposition string the model happened to pick.
			// Pinning the string made this test sample a live model's mood: on unmodified HEAD it
			// passed once and failed once against the same input, the junk having been called
			// "subject_not_user" one run and "noise-gate" the next. Both verdicts are defensible
			// and neither changes the contract, which is that the empty structure must not become
			// profile material and the sound fact must.
			//
			// This used to demand exactly ONE row and exactly ONE drop. Owner law 2026-08-26 ended
			// both: a refused candidate is not dropped, it falls back to an ACTIVE episodic row
			// carrying the evidence sentence. Two rows is now the correct outcome and the old
			// count was blocking the whole file for it.
			const profiles = rows.filter((row) => row.category === "profile");
			expect(profiles).toHaveLength(1);
			expect(profiles[0]).toMatchObject({
				text: expect.stringContaining("Riverstone"),
				timestamp: Date.parse(SESSION_DATE_TIME),
			});
			// The real defect this guards: the null-filled structure reaching storage as prose.
			expect(rows.map((row) => row.text).join("\n")).not.toContain('"free":null');
			// The junk was refused as profile material, whatever the gate called it, and its own
			// sentence survives instead — nothing was thrown away.
			const junkRow = rows.find((row) => row.text.includes("Thanks for the update"));
			expect(junkRow).toMatchObject({ category: "episodic", lane: "active" });
		},
	);
});
